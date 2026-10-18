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
import { loadTenantProviderCredentials } from '@/lib/tenant-credentials'
import { PLATFORM_FEE_TYPES, appRequiresTenantCredentials } from '@/lib/constants'
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
  const origin = request.headers.get('origin') || ''
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)
  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    return new NextResponse(null, { status: 403, headers: { 'Access-Control-Allow-Origin': 'null' } })
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    Vary: 'Origin',
  }

  if (allowedOrigins.length === 0) {
    headers['Access-Control-Allow-Origin'] = '*'
  } else if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
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

    const keyDecision = await checkRateLimit('payments-key', apiKey, { tokens: 20, window: '1 m' })
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

    const activeProvider =
      requestedProvider ??
      configuredDefaultProvider ??
      (await db.provider.findFirst({
        where: usableProviderWhere,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }))

    const [tenant, paymentType] = await Promise.all([
      validatedBody.tenantCode
        ? db.tenant.findFirst({
            where: {
              applicationId: application.id,
              code: validatedBody.tenantCode,
              isActive: true,
            },
          })
        : Promise.resolve(null),
      validatedBody.paymentTypeCode
        ? db.paymentType.findFirst({
            where: { applicationId: application.id, code: validatedBody.paymentTypeCode },
          })
        : Promise.resolve(null),
    ])

    if (validatedBody.tenantCode && !tenant) {
      return NextResponse.json({ error: 'Invalid or inactive tenant' }, { status: 404 })
    }

    const isPlatformPayment =
      paymentType && PLATFORM_FEE_TYPES.includes(String(paymentType.code).toUpperCase())

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
          console.error(
            `[payments] Tenant "${tenant.code}" is configured to use provider ` +
              `"${misconfigured.code}", which has no working adapter.`
          )
          return NextResponse.json(
            {
              error:
                `Tenant "${tenant.code}" is configured to use ${providerDisplayName(misconfigured.code)}, ` +
                'which is not implemented. Change the tenant\'s default provider in Setup.',
              availableProviders: getAvailableProviders(),
            },
            { status: 503 }
          )
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

    // Per-tenant credential enforcement
    if (!isPlatformPayment && (tenant || appRequiresTenantCredentials(application.code))) {
      if (!tenant) {
        return NextResponse.json(
          {
            error:
              `Application "${application.code}" requires a tenantCode for tenant collections. ` +
              'Tenant-less payments are not accepted — platform credentials are not used for tenant money.',
          },
          { status: 400 }
        )
      }
      const tenantCredentials = await loadTenantProviderCredentials(tenant.id, provider.id)
      if (!tenantCredentials) {
        return NextResponse.json(
          {
            error:
              `Tenant "${tenant.code}" has no active credentials configured for ${providerDisplayName(provider.code)}. ` +
              'Tenant collections require complete per-tenant credentials — configure them in Setup. ' +
              'Platform credentials are not used for tenant collections.',
            availableProviders: getAvailableProviders(),
          },
          { status: 503 }
        )
      }
    }

    const reference = generateReference(validatedBody.applicationCode, validatedBody.paymentTypeCode)

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
          metadata: JSON.stringify(validatedBody.metadata ?? {}),
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

    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:3000'
    const protocol = request.headers.get('x-forwarded-proto') || 'https'
    const rawAppBaseUrl =
      process.env.NEXTAUTH_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${protocol}://${host}`)
    const appBaseUrl = rawAppBaseUrl.replace(/\/+$/, '')
    const webhookUrl = `${appBaseUrl}/api/webhooks/${provider.code.toLowerCase()}`

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

    return NextResponse.json(
      {
        paymentId: paymentIntent.id,
        reference: paymentIntent.reference,
        status: updatedIntent?.status || 'pending',
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
