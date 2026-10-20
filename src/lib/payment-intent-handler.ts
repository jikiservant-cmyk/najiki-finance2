// Shared handler for POST /api/payments and POST /api/payments/intent
//
// The SACCO application calls /api/payments/intent, but this service historically
// only exposed /api/payments. A POST to /api/payments/intent was therefore routed
// to /api/payments/[reference] which only implements GET, causing Next.js to
// return its default HTML error page (Status 500) instead of JSON. Partner
// integrations that follow older documentation still use the /intent suffix, so
// both paths must be served by the same implementation.
//
// This module exists so the two route files remain thin wrappers that delegate
// to a single tested code path.

import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import {
  getPaymentProvider,
  getAvailableProviders,
  isProviderImplemented,
  providerDisplayName,
} from '@/lib/providers'
import { CreatePaymentRequestSchema } from '@/lib/schemas'
import { processPayment } from '@/lib/payments'
import { resolveTenantOrPlatformCredentials } from '@/lib/tenant-credentials'
import { resolveTenantForApplication } from '@/lib/tenant-resolution'
import { isPlatformFeeType, appRequiresTenantCredentials } from '@/lib/constants'
import { checkRateLimit, clientIdentifier } from '@/lib/rate-limit'
import { findApplicationByApiKey } from '@/lib/application-auth'

function generateReference(appCode: string, typeCode?: string): string {
  const time = Date.now().toString(16).slice(-8).toUpperCase()
  const rand = randomBytes(5).toString('hex').toUpperCase()
  const type = (typeCode || 'PAY').slice(0, 3).toUpperCase()
  return `${appCode.slice(0, 6).toUpperCase()}-${type}-${time}-${rand}`
}

function rateLimitResponse(decision: { status: number; message: string; retryAfter?: string }) {
  const headers: Record<string, string> = {}
  if (decision.retryAfter) headers['Retry-After'] = decision.retryAfter
  return NextResponse.json({ error: decision.message }, { status: decision.status, headers })
}

export function paymentCorsHeaders(request: Request) {
  const origin = request.headers.get('origin') || request.headers.get('referer') || ''
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)
  // In production with no allowlist, fail closed for browser cross-origin,
  // but still return JSON so SACCO proxy (server-to-server) doesn't see HTML 500.
  // Server-to-server calls don't send Origin, so they bypass this check.
  const isBrowserCrossOrigin = !!origin && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')
  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0 && isBrowserCrossOrigin) {
    return NextResponse.json(
      { error: 'CORS not configured: set ALLOWED_ORIGINS to include this origin' },
      { status: 403, headers: { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' } }
    )
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, Idempotency-Key',
    Vary: 'Origin',
  }

  if (allowedOrigins.length === 0) {
    headers['Access-Control-Allow-Origin'] = '*'
  } else if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  } else if (origin) {
    // Return no CORS header for unknown origins — browser will block,
    // but server-to-server still works. Don't return HTML.
    headers['Access-Control-Allow-Origin'] = 'null'
  } else {
    headers['Access-Control-Allow-Origin'] = '*'
  }

  return new NextResponse(null, { status: 204, headers })
}

/**
 * Normalise a partner payload that may use snake_case (older SACCO clients)
 * into the camelCase shape validated by CreatePaymentRequestSchema. This keeps
 * the alias backwards-compatible without relaxing the canonical schema.
 */
function normaliseBody(raw: any): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const out: any = { ...raw }
  // snake_case → camelCase aliases; camelCase wins when both are present
  if (out.application_code && !out.applicationCode) out.applicationCode = out.application_code
  if (out.tenant_code && !out.tenantCode) out.tenantCode = out.tenant_code
  if (out.payment_type_code && !out.paymentTypeCode) out.paymentTypeCode = out.payment_type_code
  if (out.external_entity_id && !out.externalEntityId) out.externalEntityId = out.external_entity_id
  if (out.phone_number && !out.phoneNumber) out.phoneNumber = out.phone_number
  if (out.idempotency_key && !out.idempotencyKey) out.idempotencyKey = out.idempotency_key
  if (out.provider_code && !out.providerCode) out.providerCode = out.provider_code
  // Also accept `amount` as string (some SACCO clients serialise as string)
  if (typeof out.amount === 'string') {
    const n = Number(out.amount)
    if (Number.isFinite(n)) out.amount = n
  }
  return out
}

export async function handleCreatePaymentIntent(request: Request) {
  try {
    // 1. Coarse per-IP guard
    const ipDecision = await checkRateLimit('payments-ip', clientIdentifier(request), {
      tokens: 60,
      window: '1 m',
      timeoutMs: 3000,
    })
    if (!ipDecision.ok) return rateLimitResponse(ipDecision)

    // 2. Authenticate — accept Authorization: Bearer <key>, x-api-key header,
    // and legacy Authorization: ApiKey <key> / Token <key> so older SACCO
    // deployments do not get a 401 after the gateway hardened its check.
    let apiKey: string | null = null
    const authHeader = request.headers.get('Authorization')
    if (authHeader) {
      const trimmed = authHeader.trim()
      if (trimmed.toLowerCase().startsWith('bearer ')) apiKey = trimmed.slice(7).trim()
      else if (trimmed.toLowerCase().startsWith('apikey ')) apiKey = trimmed.slice(7).trim()
      else if (trimmed.toLowerCase().startsWith('token ')) apiKey = trimmed.slice(6).trim()
      else if (trimmed) apiKey = trimmed // raw key without scheme
    }
    if (!apiKey) apiKey = request.headers.get('x-api-key')?.trim() || request.headers.get('X-API-KEY')?.trim() || null
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing or invalid authorization header' }, { status: 401 })
    }

    const keyDecision = await checkRateLimit('payments-key', apiKey, { tokens: 20, window: '1 m', timeoutMs: 3000 })
    if (!keyDecision.ok) return rateLimitResponse(keyDecision)

    let rawBody: any
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const normalised = normaliseBody(rawBody)
    const validatedBody = CreatePaymentRequestSchema.parse(normalised)

    const auth = await findApplicationByApiKey(apiKey, { code: validatedBody.applicationCode })
    const application = auth?.application ?? null

    if (!application) {
      return NextResponse.json(
        { error: 'Invalid or inactive application, or invalid API key' },
        { status: 401 }
      )
    }

    // 3. Idempotency scoped to application
    const existingIntent = await db.paymentIntent.findFirst({
      where: {
        applicationId: application.id,
        idempotencyKey: validatedBody.idempotencyKey,
      },
    })
    if (existingIntent) {
      return NextResponse.json({
        paymentId: existingIntent.id,
        reference: existingIntent.reference,
        status: existingIntent.status,
      })
    }

    // Provider selection
    const requestedProviderCode = validatedBody.providerCode?.trim().toLowerCase()

    if (requestedProviderCode && !isProviderImplemented(requestedProviderCode)) {
      return NextResponse.json(
        {
          error: `Provider "${requestedProviderCode}" is not available for payments.`,
          availableProviders: getAvailableProviders(),
        },
        { status: 400 }
      )
    }

    const usableProviderWhere = {
      isActive: true,
      code: { in: getAvailableProviders() },
    } as const

    const configuredDefaultCode = (process.env.DEFAULT_PROVIDER_CODE || '').trim().toLowerCase()

    const [requestedProvider, configuredDefaultProvider] = await Promise.all([
      requestedProviderCode
        ? db.provider.findFirst({ where: { ...usableProviderWhere, code: requestedProviderCode } })
        : Promise.resolve(null),
      configuredDefaultCode && isProviderImplemented(configuredDefaultCode)
        ? db.provider.findFirst({ where: { ...usableProviderWhere, code: configuredDefaultCode } })
        : Promise.resolve(null),
    ])

    let activeProvider =
      requestedProvider ??
      configuredDefaultProvider ??
      (await db.provider.findFirst({
        where: usableProviderWhere,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }))

    if (!activeProvider && process.env.LIVEPAY_API_KEY) {
      try {
        activeProvider = await db.provider.upsert({
          where: { code: 'livepay' },
          create: { code: 'livepay', name: 'LivePay', credentialsRef: 'LIVEPAY_', isActive: true },
          update: { isActive: true },
        })
        console.warn('[payments] Auto-activated "livepay" provider row so deposit proceeds.')
      } catch (provErr) {
        console.error('[payments] Could not auto-activate livepay provider row:', provErr)
      }
    }

    const [tenantLookup, fetchedPaymentType] = await Promise.all([
      resolveTenantForApplication(application.id, validatedBody.tenantCode),
      validatedBody.paymentTypeCode
        ? db.paymentType.findFirst({
            where: { applicationId: application.id, code: validatedBody.paymentTypeCode },
          })
        : Promise.resolve(null),
    ])

    let tenant = tenantLookup.resolved?.tenant ?? null
    if (tenant && tenantLookup.resolved && tenantLookup.resolved.matchedBy !== 'exact-code') {
      console.warn(
        `[payments] Resolved tenant "${tenant.code}" (matchedBy=${tenantLookup.resolved.matchedBy}) for requested tenantCode="${validatedBody.tenantCode ?? ''}"`
      )
    }

    let paymentType = fetchedPaymentType
    if (validatedBody.paymentTypeCode && !paymentType) {
      try {
        paymentType = await db.paymentType.upsert({
          where: {
            applicationId_code: {
              applicationId: application.id,
              code: validatedBody.paymentTypeCode,
            },
          },
          create: {
            applicationId: application.id,
            code: validatedBody.paymentTypeCode,
            description: `${validatedBody.paymentTypeCode} payment`,
          },
          update: {},
        })
      } catch (ptErr) {
        console.warn(`[payments] Could not auto-register paymentType "${validatedBody.paymentTypeCode}":`, ptErr)
      }
    }

    if (validatedBody.tenantCode && !tenant) {
      return NextResponse.json(
        {
          error: `Invalid or inactive tenant "${validatedBody.tenantCode}".`,
          availableTenants: tenantLookup.tenants.map((t) => t.code),
        },
        { status: 404 }
      )
    }

    const isPlatformPayment = isPlatformFeeType(paymentType?.code ?? validatedBody.paymentTypeCode)

    let provider = activeProvider
    if (tenant?.defaultProviderId && !isPlatformPayment && !requestedProvider) {
      const tenantProvider = await db.provider.findFirst({
        where: { ...usableProviderWhere, id: tenant.defaultProviderId },
      })

      if (tenantProvider) {
        provider = tenantProvider
      } else {
        const misconfigured = await db.provider.findUnique({
          where: { id: tenant.defaultProviderId },
          select: { code: true, isActive: true },
        })

        if (misconfigured && !isProviderImplemented(misconfigured.code)) {
          console.warn(
            `[payments] Tenant "${tenant.code}" defaultProvider "${misconfigured.code}" has no adapter — ` +
              `falling back to ${activeProvider?.code ?? 'livepay'} so deposit does not fail. Fix in Setup.`
          )
          if (activeProvider) {
            provider = activeProvider
            // Self-heal the tenant row so future deposits don't need fallback
            try {
              await db.tenant.update({ where: { id: tenant.id }, data: { defaultProviderId: activeProvider.id } })
              console.warn(`[payments] Self-healed tenant "${tenant.code}" defaultProvider to "${activeProvider.code}"`)
            } catch {}
          }
        }
      }
    }

    if (!provider) {
      return NextResponse.json(
        {
          error: 'No implemented payment provider is active.',
          availableProviders: getAvailableProviders(),
        },
        { status: 503 }
      )
    }

    let credentialSource = isPlatformPayment ? 'platform-fee' : 'none'

    // Per-tenant credential enforcement
    if (!isPlatformPayment && (tenant || appRequiresTenantCredentials(application.code))) {
      if (!tenant && appRequiresTenantCredentials(application.code)) {
        if (tenantLookup.tenants.length === 1) {
          console.warn(`[payments] tenantCode missing for single-tenant app "${application.code}" — auto-resolving to "${tenantLookup.tenants[0].code}" so deposit does not fail.`)
          tenant = tenantLookup.tenants[0]
        } else if (tenantLookup.tenants.length === 0) {
          console.warn(`[payments] No active tenants for app "${application.code}" — proceeding without tenant (will 400 if required)`)
        } else {
          console.warn(`[payments] tenantCode missing for multi-tenant app "${application.code}" (${tenantLookup.tenants.length} tenants) — returning 400. SACCO must send tenantCode.`)
        }
      }
      if (!tenant) {
        return NextResponse.json(
          {
            error:
              `Application "${application.code}" requires a tenantCode for tenant collections. ` +
              'Tenant-less payments are not accepted — platform credentials are not used for tenant money. `tenantCode` must be one of the SACCO tenants configured in Setup.',
            hint: 'If this SACCO has only one branch/tenant, the gateway now auto-resolves it; this error means multiple tenants exist and you must specify which one.',
          },
          { status: 400 }
        )
      }
      const resolvedCreds = await resolveTenantOrPlatformCredentials(tenant.id, provider.id, tenant.code)
      if (!resolvedCreds) {
        return NextResponse.json(
          {
            error:
              `Tenant "${tenant.code}" has no active credentials configured for ${providerDisplayName(provider.code)}. ` +
              'Configure per-tenant credentials in Setup or set LIVEPAY_API_KEY and LIVEPAY_ACCOUNT_NO in the gateway environment.',
            availableProviders: getAvailableProviders(),
          },
          { status: 503 }
        )
      }
      credentialSource = resolvedCreds.source
    }

    const reference = generateReference(validatedBody.applicationCode, validatedBody.paymentTypeCode)
    const intentMetadata = {
      ...(validatedBody.metadata ?? {}),
      ...(validatedBody.tenantCode ? { requestedTenantCode: validatedBody.tenantCode } : {}),
      credentialSource,
    }

    let paymentIntent: any
    try {
      paymentIntent = await db.paymentIntent.create({
        data: {
          applicationId: application.id,
          tenantId: tenant?.id ?? null,
          paymentTypeId: paymentType?.id ?? null,
          externalEntityId: validatedBody.externalEntityId,
          reference,
          idempotencyKey: validatedBody.idempotencyKey,
          amount: validatedBody.amount,
          currency: validatedBody.currency,
          phoneNumber: validatedBody.phoneNumber,
          providerId: provider.id,
          status: 'pending',
          metadata: JSON.stringify(intentMetadata),
        },
      })
    } catch (e: any) {
      if (e?.code === 'P2002' && isIdempotencyConflict(e)) {
        const existing = await db.paymentIntent.findFirst({
          where: { applicationId: application.id, idempotencyKey: validatedBody.idempotencyKey },
        })
        if (existing) {
          return NextResponse.json({
            paymentId: existing.id,
            reference: existing.reference,
            status: existing.status,
          })
        }
      }
      throw e
    }

    // Build webhook URL — must be gateway's public URL, not SACCO's Netlify host
    // If NEXTAUTH_URL not set, we fell back to kunitydev.netlify.app host which LivePay
    // will never callback to. That doesn't block PIN, but breaks confirmation.
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:3000'
    const protocol = request.headers.get('x-forwarded-proto') || 'https'
    let rawAppBaseUrl = process.env.NEXTAUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
    if (!rawAppBaseUrl) {
      rawAppBaseUrl = `${protocol}://${host}`
      if (process.env.NODE_ENV === 'production') {
        console.warn(`[payments] NEXTAUTH_URL not set in prod — using host ${host} for webhookUrl. Set NEXTAUTH_URL to gateway public origin or LivePay callback will fail.`)
      }
    }
    const appBaseUrl = rawAppBaseUrl.replace(/\/+$/, '')
    const webhookUrl = `${appBaseUrl}/api/webhooks/${provider.code.toLowerCase()}`

    // Validate phone before we charge LivePay — UGX numbers must be 2567... (12 digits)
    const normalizedForLog = String(validatedBody.phoneNumber).replace(/[\s\-\(\)]/g, '')
    if (normalizedForLog.length < 9 || normalizedForLog.length > 15) {
      console.warn(`[payments] Suspicious phone length ${normalizedForLog.length} for ${normalizedForLog.slice(0,4)}**** — LivePay may not send PIN`)
    }

    await processPayment({
      paymentIntentId: paymentIntent.id,
      amount: Number(validatedBody.amount),
      currency: validatedBody.currency,
      phoneNumber: validatedBody.phoneNumber,
      reference,
      providerCode: provider.code,
      description: rawBody.description || `Payment for ${validatedBody.paymentTypeCode ?? 'payment'}`,
      metadata: { ...(validatedBody.metadata ?? {}), paymentIntentId: paymentIntent.id },
      webhookUrl,
    })

    const updatedIntent = await db.paymentIntent.findUnique({ where: { id: paymentIntent.id } })
    const finalStatus = updatedIntent?.status || 'pending'
    const finalFailure = (updatedIntent as any)?.failureReason || null
    const finalProviderId = (updatedIntent as any)?.providerPaymentId || null

    // Surface provider rejection with an explicit non-2xx status so partner apps
    // never display a fake "waiting for PIN prompt" screen when no PIN was sent.
    if (finalStatus === 'failed') {
      console.error(`[payments] LivePay failed for ${reference} source=${credentialSource} phone=${String(validatedBody.phoneNumber).slice(0,4)}**** reason=${finalFailure}`)
      return NextResponse.json(
        {
          error: finalFailure
            ? `Payment provider rejected collection: ${finalFailure}`
            : 'Payment provider rejected collection request.',
          paymentId: paymentIntent.id,
          reference: paymentIntent.reference,
          status: finalStatus,
          credentialSource,
          failureReason: finalFailure,
          providerPaymentId: finalProviderId,
          hint: 'PIN not sent — verify SACCO LivePay Account Number + API Key in Setup and phone number.',
        },
        { status: 422 }
      )
    }

    console.log(`[payments] Created ${reference} status=${finalStatus} provider=${provider.code} credentialSource=${credentialSource} providerPaymentId=${finalProviderId || 'none'} webhook=${webhookUrl}`)

    return NextResponse.json(
      {
        paymentId: paymentIntent.id,
        reference: paymentIntent.reference,
        status: finalStatus,
        credentialSource,
        providerPaymentId: finalProviderId,
        failureReason: finalFailure,
      },
      { status: 200 }
    )
  } catch (error: any) {
    console.error('Create payment error:', error)
    if (error && (error.name === 'ZodError' || Array.isArray(error.issues))) {
      const details = (error.issues || []).map((i: any) => `${i.path?.join('.') || 'body'}: ${i.message}`)
      return NextResponse.json({ error: 'Validation failed', details }, { status: 400 })
    }
    // Never leak internal details as HTML — always JSON for API consumers.
    // Prisma connection failures, decryption errors and unhandled provider
    // throws all land here. Returning JSON keeps the SACCO client from
    // surfacing a Next.js HTML error page as a "gateway error".
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

function isIdempotencyConflict(error: any): boolean {
  const target = error?.meta?.target
  if (Array.isArray(target)) {
    return target.some((t: unknown) => String(t).includes('idempotency_key') || String(t).includes('idempotencyKey'))
  }
  if (typeof target === 'string') {
    return target.includes('idempotency_key') || target.includes('idempotencyKey')
  }
  return true
}
