// Payment intent creation.
//
// Ordering matters here and was previously wrong:
//
//   1. rate limit (cheap, before touching the DB)
//   2. authenticate the API key            ← MUST come before anything that
//   3. validate the body                      can reveal data or write rows
//   4. idempotency lookup, scoped to the authenticated application
//   5. create + initiate
//
// The idempotency lookup used to run *before* the API key was checked, so a
// caller with a guessed/reused key could read back another application's
// payment id, reference and status.

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
import { PLATFORM_FEE_TYPES } from '@/lib/constants'
import { checkRateLimit, clientIdentifier } from '@/lib/rate-limit'
import { findApplicationByApiKey } from '@/lib/application-auth'

// crypto-random reference — replaces Date.now().slice(-6)+Math.random()*10000
// which had collision probability under burst load (same millisecond = same prefix)
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

export function OPTIONS(request: Request) {
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

  // Only echo back an origin we actually allow. Previously a non-matching
  // origin received `Access-Control-Allow-Origin: <first allowed origin>`,
  // which makes ALLOWED_ORIGINS appear enforced by accident. Omit to deny.
  if (allowedOrigins.length === 0) {
    headers['Access-Control-Allow-Origin'] = '*'
  } else if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return new NextResponse(null, { status: 204, headers })
}

export async function POST(request: Request) {
  try {
    // ── 1. Coarse per-IP guard, before any DB work or body parsing ──────────
    const ipDecision = await checkRateLimit('payments-ip', clientIdentifier(request), {
      tokens: 60,
      window: '1 m',
    })
    if (!ipDecision.ok) return rateLimitResponse(ipDecision)

    // ── 2. Authenticate ────────────────────────────────────────────────────
    const authHeader = request.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Missing or invalid authorization header' }, { status: 401 })
    }
    const apiKey = authHeader.slice(7).trim()
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing or invalid authorization header' }, { status: 401 })
    }

    const keyDecision = await checkRateLimit('payments-key', apiKey, { tokens: 20, window: '1 m' })
    if (!keyDecision.ok) return rateLimitResponse(keyDecision)

    const rawBody = await request.json()
    const validatedBody = CreatePaymentRequestSchema.parse(rawBody)

    // Hash-first lookup; falls back to the legacy cleartext column so apps
    // provisioned before the migration keep working (see application-auth.ts).
    const auth = await findApplicationByApiKey(apiKey, { code: validatedBody.applicationCode })
    const application = auth?.application ?? null

    if (!application) {
      return NextResponse.json(
        { error: 'Invalid or inactive application, or invalid API key' },
        { status: 401 }
      )
    }

    // ── 3. Idempotency, now scoped to the authenticated application ─────────
    // The key is unique per (applicationId, idempotencyKey) rather than
    // globally, so two partner apps may reuse the same key without one of them
    // silently receiving the other's payment.
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

    // ── Provider selection ────────────────────────────────────────────────
    // Three things were wrong with `findFirst({ where: { isActive: true } })`:
    //
    //   1. No `orderBy` — Postgres may return any row, so which provider new
    //      payments used was unspecified.
    //   2. No implementation filter — three of the four seeded providers are
    //      stubs whose initiatePayment() throws, so the "default" could be a
    //      provider that cannot take the payment at all.
    //   3. The caller had no way to ask for a specific provider.
    //
    // Selection is now: explicit request → tenant default → configured default
    // → oldest active implemented provider. Every path filters on
    // IMPLEMENTED_PROVIDER_CODES, and a misconfigured tenant gets a clear 503
    // rather than an opaque provider throw.
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

    // Unspecified ordering is the bug, so ordering is now explicit everywhere.
    // Oldest-first is stable and does not change as rows are edited.
    const activeProvider =
      requestedProvider ??
      configuredDefaultProvider ??
      (await db.provider.findFirst({
        where: usableProviderWhere,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }))

    // Tenant + payment type (conditional on request body)
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

    // Prefer tenant's default provider, UNLESS it's a platform payment
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
        // The tenant is pointed at a provider with no working adapter (or an
        // inactive one). Refuse loudly instead of silently taking the payment
        // through a different provider than the one configured — an operator
        // needs to see this, not have it papered over.
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
        // Lost a race against a concurrent request with the same key.
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

    // Process payment synchronously to avoid Vercel killing the background task
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
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * True when a Prisma P2002 is specifically the (applicationId, idempotencyKey)
 * unique constraint — other unique columns (reference) must still surface.
 */
function isIdempotencyConflict(error: any): boolean {
  const target = error?.meta?.target
  if (Array.isArray(target)) {
    return target.some((t: unknown) => String(t).includes('idempotency_key') || String(t).includes('idempotencyKey'))
  }
  if (typeof target === 'string') {
    return target.includes('idempotency_key') || target.includes('idempotencyKey')
  }
  // Older Prisma versions don't always report the target — accept the conflict
  // and let the scoped re-read decide.
  return true
}
