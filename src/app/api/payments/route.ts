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
import { getPaymentProvider } from '@/lib/providers'
import { CreatePaymentRequestSchema } from '@/lib/schemas'
import { processPayment } from '@/lib/payments'
import { PLATFORM_FEE_TYPES } from '@/lib/constants'
import { checkRateLimit, clientIdentifier } from '@/lib/rate-limit'

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

    const application = await db.application.findFirst({
      where: {
        code: validatedBody.applicationCode,
        apiKey,
        isActive: true,
      },
    })

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

    const activeProvider = await db.provider.findFirst({ where: { isActive: true } })

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
    if (tenant?.defaultProviderId && !isPlatformPayment) {
      const tenantProvider = await db.provider.findFirst({
        where: { id: tenant.defaultProviderId, isActive: true },
      })
      if (tenantProvider) provider = tenantProvider
    }
    if (!provider) {
      return NextResponse.json({ error: 'No active payment provider' }, { status: 500 })
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
