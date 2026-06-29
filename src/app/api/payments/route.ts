// FIX: Add rate limiting to /api/payments
// Without this one bad client or attacker can flood the endpoint,
// exhaust the DB connection pool, and create thousands of pending intents.
//
// Using a token-bucket per IP (in-process).
// For multi-instance: swap for Upstash Redis + @upstash/ratelimit

import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'
import { createPaymentTransaction } from '@/lib/data'
import { CreatePaymentRequestSchema } from '@/lib/schemas'

// Token bucket — 20 requests per IP per minute
const buckets = new Map<string, { tokens: number; last: number }>()
const RATE = 20
const WINDOW = 60_000

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const b = buckets.get(ip) ?? { tokens: RATE, last: now }
  const refill = Math.floor(((now - b.last) / WINDOW) * RATE)
  b.tokens = Math.min(RATE, b.tokens + refill)
  b.last = now
  if (b.tokens <= 0) { buckets.set(ip, b); return true }
  b.tokens--
  buckets.set(ip, b)
  return false
}

// FIX: crypto-random reference — replaces Date.now().slice(-6)+Math.random()*10000
// which had collision probability under burst load (same millisecond = same prefix)
function generateReference(appCode: string, typeCode?: string): string {
  const time = Date.now().toString(16).slice(-8).toUpperCase()
  const rand = randomBytes(5).toString('hex').toUpperCase()
  const type = (typeCode || 'PAY').slice(0, 3).toUpperCase()
  return `${appCode.slice(0, 6).toUpperCase()}-${type}-${time}-${rand}`
}

export async function POST(request: Request) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }

  try {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Missing or invalid authorization header' }, { status: 401 })
    }
    const apiKey = authHeader.slice(7) // Remove 'Bearer ' prefix

    const rawBody = await request.json()
    const validatedBody = CreatePaymentRequestSchema.parse(rawBody)

    // Idempotency fast-path — check before any other DB work
    const existingIntent = await db.paymentIntent.findUnique({
      where: { idempotencyKey: validatedBody.idempotencyKey },
    })
    if (existingIntent) {
      return NextResponse.json({
        paymentId: existingIntent.id,
        reference: existingIntent.reference,
        status: existingIntent.status,
      })
    }

    // Parallelise independent lookups
    const [application, activeProvider] = await Promise.all([
      db.application.findFirst({
        where: { 
          code: validatedBody.applicationCode, 
          apiKey: apiKey,
          isActive: true 
        },
      }),
      db.provider.findFirst({ where: { isActive: true } }),
    ])

    if (!application) {
      return NextResponse.json({ error: 'Invalid or inactive application, or invalid API key' }, { status: 401 })
    }

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

    // Prefer tenant's default provider
    let provider = activeProvider
    if (tenant?.defaultProviderId) {
      const tenantProvider = await db.provider.findFirst({
        where: { id: tenant.defaultProviderId, isActive: true },
      })
      if (tenantProvider) provider = tenantProvider
    }
    if (!provider) {
      return NextResponse.json({ error: 'No active payment provider' }, { status: 500 })
    }

    const reference = generateReference(
      validatedBody.applicationCode,
      validatedBody.paymentTypeCode
    )

    const paymentIntent = await db.paymentIntent.create({
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

    const providerClient = getPaymentProvider(provider.code)
    const providerResponse = await providerClient.initiatePayment({
      amount: validatedBody.amount,
      currency: validatedBody.currency,
      phoneNumber: validatedBody.phoneNumber,
      reference,
      description: `Payment for ${validatedBody.paymentTypeCode ?? 'payment'}`,
      metadata: { ...(validatedBody.metadata ?? {}), paymentIntentId: paymentIntent.id },
    })

    const [updatedIntent] = await db.$transaction([
      db.paymentIntent.update({
        where: { id: paymentIntent.id },
        data: {
          status: providerResponse.status,
          providerPaymentId: providerResponse.providerPaymentId,
          failureReason: providerResponse.failureReason,
          completedAt: providerResponse.status === 'success' ? new Date() : null,
        },
      }),
      db.paymentTransaction.create({
        data: {
          paymentIntentId: paymentIntent.id,
          status: providerResponse.status,
          rawProviderResponse: JSON.stringify(providerResponse),
          note: 'PAYMENT_INITIATED',
        },
      }),
    ])

    return NextResponse.json({
      paymentId: updatedIntent.id,
      reference: updatedIntent.reference,
      status: updatedIntent.status,
    })
  } catch (error) {
    console.error('Create payment error:', error)
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
