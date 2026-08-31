// FIX: Add rate limiting to /api/payments
// Without this one bad client or attacker can flood the endpoint,
// exhaust the DB connection pool, and create thousands of pending intents.
//
// Using Upstash Redis for distributed rate limiting.

import { NextResponse, after } from 'next/server'
import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'
import { createPaymentTransaction } from '@/lib/data'
import { CreatePaymentRequestSchema } from '@/lib/schemas'
import { processPayment } from '@/lib/payments'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// Use Upstash Redis for distributed rate limiting if configured
let ratelimit: Ratelimit | null = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = Redis.fromEnv()
    ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(20, '1 m'),
      analytics: true,
    })
  }
} catch (e) {
  console.warn('Failed to initialize rate limiter:', e)
}

// FIX: crypto-random reference — replaces Date.now().slice(-6)+Math.random()*10000
// which had collision probability under burst load (same millisecond = same prefix)
function generateReference(appCode: string, typeCode?: string): string {
  const time = Date.now().toString(16).slice(-8).toUpperCase()
  const rand = randomBytes(5).toString('hex').toUpperCase()
  const type = (typeCode || 'PAY').slice(0, 3).toUpperCase()
  return `${appCode.slice(0, 6).toUpperCase()}-${type}-${time}-${rand}`
}


export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
}

export async function POST(request: Request) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  if (ratelimit) {
    try {
      // Enforce a strict 1-second timeout on the Redis rate limit check
      // so it never stalls the payment API if Redis is slow or unresponsive.
      const ratelimitPromise = ratelimit.limit(ip)
      const timeoutPromise = new Promise<{success: boolean}>((_, reject) => 
        setTimeout(() => reject(new Error('Rate limit timeout')), 1000)
      )
      
      const { success } = await Promise.race([ratelimitPromise, timeoutPromise])
      if (!success) {
        return NextResponse.json(
          { error: 'Too many requests' },
          { status: 429, headers: { 'Retry-After': '60' } }
        )
      }
    } catch (ratelimitError) {
      console.warn('Rate limiter failed or timed out, bypassing:', ratelimitError)
      // Bypass rate limiting if Redis is down/fails to prevent breaking payments
    }
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

    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:3000'
    const protocol = request.headers.get('x-forwarded-proto') || 'https'
    const appBaseUrl = process.env.NEXTAUTH_URL || `${protocol}://${host}`
    const webhookUrl = `${appBaseUrl}/api/webhooks/${provider.code.toLowerCase()}`

    // Process payment in background using Next.js after()
    after(() => {
      processPayment({
        paymentIntentId: paymentIntent.id,
        amount: Number(validatedBody.amount),
        currency: validatedBody.currency,
        phoneNumber: validatedBody.phoneNumber,
        reference,
        providerCode: provider.code,
        description: rawBody.description || `Payment for ${validatedBody.paymentTypeCode ?? 'payment'}`,
        metadata: { ...(validatedBody.metadata ?? {}), paymentIntentId: paymentIntent.id },
        webhookUrl,
      }).catch(err => console.error('Background payment processing error:', err))
    })

    return NextResponse.json({
      paymentId: paymentIntent.id,
      reference: paymentIntent.reference,
      status: 'pending',
    }, { status: 202 })
  } catch (error: any) {
    console.error('Create payment error:', error)
    if (error && (error.name === 'ZodError' || Array.isArray(error.issues))) {
      const details = (error.issues || []).map((i: any) => `${i.path.join('.') || 'body'}: ${i.message}`)
      return NextResponse.json({ error: 'Validation failed', details }, { status: 400 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
