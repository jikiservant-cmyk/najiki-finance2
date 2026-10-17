import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'
import { enqueueWebhookNotification, completePayment, resolvePaymentCredentials } from '@/lib/payments'
import { webhookSecretFromRow, findApplicationByApiKey } from '@/lib/application-auth'
import { safeJsonObject } from '@/lib/json'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// Use Upstash Redis for distributed rate limiting if configured
let ratelimit: Ratelimit | null = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = Redis.fromEnv()
    ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(60, '1 m'),
      analytics: true,
    })
  }
} catch (e) {
  console.warn('Failed to initialize rate limiter:', e)
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Missing or invalid authorization header' }, { status: 401 })
    }
    const apiKey = authHeader.slice(7) // Remove 'Bearer ' prefix

    if (ratelimit) {
      try {
        // Enforce a strict 1-second timeout on the Redis rate limit check
        const ratelimitPromise = ratelimit.limit(`get_payment_${apiKey}`)
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
      }
    }

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

    if (paymentIntent.tenant && paymentIntent.tenant.code !== requestTenantCode) {
      return NextResponse.json({ error: 'Payment not found (tenant mismatch)' }, { status: 404 })
    }

    let currentStatus = paymentIntent.status
    let currentFailureReason = paymentIntent.failureReason
    let completedAt = paymentIntent.completedAt

    // If still processing, see if we should poll the provider (max once every 15s)
    if (paymentIntent.status === 'processing' && paymentIntent.provider?.code) {
      const secondsSinceUpdate = (Date.now() - paymentIntent.updatedAt.getTime()) / 1000
      
      if (secondsSinceUpdate > 15) {
        try {
          // Pen-test finding (F-A): poll with the TENANT's own credentials for
          // tenant-collected payments — the same rule the creation path, the
          // webhook path and both cron pollers use. Polling a tenant's payment
          // under the platform's account checks the wrong account.
          //
          // Pen-test finding (F-2b): and when the tenant has no usable
          // credentials, DO NOT POLL AT ALL. This path used to fall through to
          // platform credentials, which for a tenant collection either settles
          // the payment against money sitting in the platform account or
          // contradicts the webhook path that refuses the same payment. Not
          // polling leaves the intent in its stored state for an operator to
          // fix; that is recoverable, whereas a wrong-account settlement is not.
          const resolved = await resolvePaymentCredentials({
            tenantId: paymentIntent.tenantId,
            providerId: paymentIntent.providerId,
            paymentType: paymentIntent.paymentType,
          })

          if (!resolved.ok) {
            console.error(
              `[payments/${reference}] Not polling: tenant ${paymentIntent.tenantId} has ` +
                (resolved.reason === 'incomplete-credentials'
                  ? `incomplete credentials (missing: ${resolved.missing?.join(', ')})`
                  : 'no active credentials configured') +
                '. Refusing to check the platform account for a tenant collection.'
            )
          } else {
          const providerClient = getPaymentProvider(paymentIntent.provider.code, resolved.credentials)
          if (providerClient.checkPaymentStatus) {
            const statusResult = await providerClient.checkPaymentStatus(
              paymentIntent.reference,
              paymentIntent.currency,
              paymentIntent.providerPaymentId || undefined
            )

            // If status changed to success or failed, update the DB
            if (statusResult.status !== 'pending' && statusResult.status !== 'processing') {
              const { intent: updatedIntent, wasAlreadyProcessed } = await completePayment({
                paymentIntentId: paymentIntent.id,
                status: statusResult.status,
                providerPaymentId: statusResult.providerPaymentId,
                failureReason: statusResult.failureReason,
                amount: Number(paymentIntent.amount),
                currency: paymentIntent.currency,
                rawProviderResponse: JSON.stringify(statusResult),
                note: 'STATUS_SYNC_FROM_API',
              })

              if (!wasAlreadyProcessed) {
                await enqueueWebhookNotification({
                  paymentIntentId: paymentIntent.id,
                  reference: paymentIntent.reference,
                  status: statusResult.status,
                  amount: Number(paymentIntent.amount),
                  currency: paymentIntent.currency,
                  providerPaymentId: statusResult.providerPaymentId || paymentIntent.providerPaymentId || '',
                  failureReason: statusResult.failureReason,
                  applicationId: application.id,
                  webhookUrl: `${application.baseUrl}${application.webhookPath}`,
                  webhookSecret: webhookSecretFromRow(application),
                  externalEntityId: paymentIntent.externalEntityId,
                  tenantId: paymentIntent.tenantId,
                  tenantCode: paymentIntent.tenant?.code ?? null,
                  metadata: safeJsonObject(paymentIntent.metadata),
                })
              }

              currentStatus = updatedIntent.status
              currentFailureReason = updatedIntent.failureReason
              completedAt = updatedIntent.completedAt
            } else {
               // Just touch updatedAt to reset the 15s throttle
               await db.paymentIntent.update({
                 where: { id: paymentIntent.id },
                 data: { updatedAt: new Date() }
               })
            }
          }
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
      providerPaymentId: paymentIntent.providerPaymentId,
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
