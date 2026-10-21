import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isAuthorizedTenantPoll } from '@/lib/tenant-resolution'
import { checkRateLimit, clientIdentifier } from '@/lib/rate-limit'
import { findApplicationByApiKey } from '@/lib/application-auth'
import { safeJsonObject } from '@/lib/json'
import {
  flushPendingNotificationsForPayment,
  reconcileSinglePaymentById,
} from '@/lib/reconcile-payments'

export const dynamic = 'force-dynamic'

function extractApiKey(request: Request): string | null {
  const authHeader = request.headers.get('Authorization')
  if (authHeader) {
    const trimmed = authHeader.trim()
    if (trimmed.toLowerCase().startsWith('bearer ')) return trimmed.slice(7).trim() || null
    if (trimmed.toLowerCase().startsWith('apikey ')) return trimmed.slice(7).trim() || null
    if (trimmed.toLowerCase().startsWith('token ')) return trimmed.slice(6).trim() || null
    if (trimmed) return trimmed
  }
  return request.headers.get('x-api-key')?.trim() || request.headers.get('X-API-KEY')?.trim() || null
}

export function OPTIONS(request: Request) {
  const origin = request.headers.get('origin') || ''
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)
  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    return new NextResponse(null, { status: 403, headers: { 'Access-Control-Allow-Origin': 'null' } })
  }
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    Vary: 'Origin',
  }
  if (allowedOrigins.length === 0) headers['Access-Control-Allow-Origin'] = '*'
  else if (allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return new NextResponse(null, { status: 204, headers })
}

export async function POST() {
  return NextResponse.json({ error: 'Method not allowed. Use GET to fetch a payment or POST /api/payments to create one.' }, { status: 405 })
}

export async function PUT() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}

export async function DELETE() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const apiKey = extractApiKey(request)
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing or invalid authorization header' }, { status: 401 })
    }

    const ipDecision = await checkRateLimit('get-payment-ip', clientIdentifier(request), { tokens: 120, window: '1 m' })
    if (!ipDecision.ok) return NextResponse.json({ error: ipDecision.message }, { status: ipDecision.status, headers: ipDecision.retryAfter ? { 'Retry-After': ipDecision.retryAfter } : {} })
    const keyDecision = await checkRateLimit('get-payment-key', apiKey, { tokens: 60, window: '1 m' })
    if (!keyDecision.ok) return NextResponse.json({ error: keyDecision.message }, { status: keyDecision.status, headers: keyDecision.retryAfter ? { 'Retry-After': keyDecision.retryAfter } : {} })

    const auth = await findApplicationByApiKey(apiKey)
    const application = auth?.application ?? null

    if (!application) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
    }

    const { reference } = await params

    const paymentIntent = await db.paymentIntent.findUnique({
      where: { reference },
      include: {
        application: { select: { id: true, code: true, name: true } },
        tenant:      { select: { id: true, code: true, name: true } },
        provider:    { select: { id: true, code: true, name: true } },
        paymentType: { select: { id: true, code: true, description: true } },
      },
    })

    if (!paymentIntent) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    // Check that the payment intent belongs to the authenticated application
    if (paymentIntent.applicationId !== application.id) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const requestTenantCode = searchParams.get('tenantCode')
    const parsedIntentMetadata = safeJsonObject(paymentIntent.metadata)

    if (paymentIntent.tenant) {
      let authorized = isAuthorizedTenantPoll({
        intentTenant: paymentIntent.tenant,
        requestedTenantCode: requestTenantCode,
        intentMetadata: parsedIntentMetadata,
      })
      if (!authorized) {
        const activeTenantCount = await db.tenant.count({
          where: { applicationId: application.id, isActive: true },
        })
        authorized = isAuthorizedTenantPoll({
          intentTenant: paymentIntent.tenant,
          requestedTenantCode: requestTenantCode,
          intentMetadata: parsedIntentMetadata,
          activeTenantCount,
        })
      }
      if (!authorized) {
        return NextResponse.json({ error: 'Payment not found (tenant mismatch)' }, { status: 404 })
      }
    }

    let currentStatus = paymentIntent.status
    let currentFailureReason = paymentIntent.failureReason
    let completedAt = paymentIntent.completedAt
    let currentProviderPaymentId = paymentIntent.providerPaymentId

    if (paymentIntent.status === 'success' || paymentIntent.status === 'failed') {
      await flushPendingNotificationsForPayment(paymentIntent.id, {
        fallbackWebhookSecret: apiKey,
      })
    } else if (
      (paymentIntent.status === 'processing' || paymentIntent.status === 'pending') &&
      paymentIntent.provider?.code
    ) {
      const lastPollTime = paymentIntent.lastPolledAt?.getTime() ?? 0
      const msSincePoll = Date.now() - lastPollTime

      if (msSincePoll >= 2_500) {
        try {
          const reconciled = await reconcileSinglePaymentById(paymentIntent.id, {
            note: 'STATUS_SYNC_FROM_API',
            fallbackWebhookSecret: apiKey,
          })
          if (reconciled) {
            currentStatus = reconciled.status
            currentFailureReason = reconciled.failureReason
            completedAt = reconciled.completedAt
            currentProviderPaymentId = reconciled.providerPaymentId
          }
        } catch (pollError) {
          console.error('[Payment API] Error polling provider status:', pollError)
        }
      }
    }

    return NextResponse.json({
      id:               paymentIntent.id,
      reference:        paymentIntent.reference,
      status:           currentStatus,
      amount:           Number(paymentIntent.amount), // Decimal → number for JSON
      currency:         paymentIntent.currency,
      phoneNumber:      paymentIntent.phoneNumber,
      externalEntityId: paymentIntent.externalEntityId,
      provider:         paymentIntent.provider,
      providerPaymentId: currentProviderPaymentId,
      application:      paymentIntent.application,
      tenant:           paymentIntent.tenant,
      paymentType:      paymentIntent.paymentType,
      failureReason:    currentFailureReason,
      createdAt:        paymentIntent.createdAt,
      updatedAt:        paymentIntent.updatedAt,
      completedAt:      completedAt,
    })
  } catch (error) {
    console.error('Get payment error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
