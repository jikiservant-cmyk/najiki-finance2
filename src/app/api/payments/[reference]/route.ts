import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'
import { enqueueWebhookNotification, completePayment } from '@/lib/payments'
import { loadTenantProviderCredentials } from '@/lib/tenant-credentials'
import { isConfirmedTerminalStatus } from '@/lib/payment-security'
import { checkRateLimit, clientIdentifier } from '@/lib/rate-limit'
import { PLATFORM_FEE_TYPES } from '@/lib/constants'
import { webhookSecretFromRow, findApplicationByApiKey } from '@/lib/application-auth'
import { safeJsonObject } from '@/lib/json'

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
          let pollCredentials: any = undefined
          const isPlatformPayment =
            paymentIntent.paymentType &&
            PLATFORM_FEE_TYPES.includes(String(paymentIntent.paymentType.code).toUpperCase())
          if (paymentIntent.tenantId && paymentIntent.providerId && !isPlatformPayment) {
            pollCredentials = await loadTenantProviderCredentials(paymentIntent.tenantId, paymentIntent.providerId)
            if (!pollCredentials) {
              // Keep the intent reconcilable; do not query the platform account.
              throw new Error(`Tenant credentials unavailable for payment ${paymentIntent.id}`)
            }
          }
          const providerClient = getPaymentProvider(paymentIntent.provider.code, pollCredentials)
          if (providerClient.checkPaymentStatus) {
            const statusResult = await providerClient.checkPaymentStatus(
              paymentIntent.reference,
              paymentIntent.currency,
              paymentIntent.providerPaymentId || undefined
            )

            // If status changed to success or failed, update the DB
            if (isConfirmedTerminalStatus(statusResult, {
              amount: Number(paymentIntent.amount),
              currency: paymentIntent.currency,
              providerPaymentId: paymentIntent.providerPaymentId,
            })) {
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
