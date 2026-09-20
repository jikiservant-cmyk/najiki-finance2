import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'
import { completePayment, enqueueWebhookNotification } from '@/lib/payments'
import { verifyCronRequest } from '@/lib/qstash-verify'
import { decrypt } from '@/lib/encryption'
import { PLATFORM_FEE_TYPES } from '@/lib/constants'

async function handleSync(request: Request) {
  try {
    const isAuthorized = await verifyCronRequest(request)
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(request.url)
    const appCode = url.searchParams.get('app')

    // Find all pending or processing payments older than 30 seconds
    const thirtySecondsAgo = new Date(Date.now() - 30_000)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const pendingPayments = await db.paymentIntent.findMany({
      where: {
        status: { in: ['pending', 'processing'] },
        createdAt: { lte: thirtySecondsAgo, gte: twentyFourHoursAgo },
        ...(appCode ? { application: { code: appCode } } : {}),
      },
      include: {
        provider: true,
        application: true,
        tenant: true,
        paymentType: true,
      },
      take: 50,
    })

    const pollResults: Array<{ id: string; reference: string; status: string; polledStatus?: string }> = []

    for (const payment of pendingPayments) {
      try {
        const isPlatformPayment = payment.paymentType && PLATFORM_FEE_TYPES.includes(payment.paymentType.code.toUpperCase())

        let customCredentials: any = undefined
        if (payment.tenantId && !isPlatformPayment) {
          const tenantConfig = await db.tenantProviderConfig.findFirst({
            where: {
              tenantId: payment.tenantId,
              providerId: payment.providerId,
              isActive: true,
            },
          })
          if (tenantConfig?.configJson && typeof tenantConfig.configJson === 'object') {
            customCredentials = tenantConfig.configJson
            if (customCredentials?._encrypted) {
              customCredentials = JSON.parse(decrypt(customCredentials._encrypted))
            }
          }
        }

        const providerClient = getPaymentProvider(payment.provider.code, customCredentials)
        if (providerClient.checkPaymentStatus) {
          const result = await providerClient.checkPaymentStatus(
            payment.reference,
            payment.currency,
            payment.providerPaymentId || undefined
          )

          if (result && (result.status === 'success' || result.status === 'failed')) {
            const completion = await completePayment({
              paymentIntentId: payment.id,
              status: result.status,
              providerPaymentId: result.providerPaymentId || payment.providerPaymentId || '',
              failureReason: result.failureReason,
              amount: Number(payment.amount),
              currency: payment.currency,
              rawProviderResponse: JSON.stringify(result),
              note: `SYNC_PAYMENTS_CRON | Status: ${result.status}`,
            })

            if (!completion.wasAlreadyProcessed) {
              await enqueueWebhookNotification({
                paymentIntentId: payment.id,
                reference: payment.reference,
                status: result.status,
                amount: Number(payment.amount),
                currency: payment.currency,
                providerPaymentId: result.providerPaymentId || payment.providerPaymentId || '',
                failureReason: result.failureReason,
                applicationId: payment.applicationId,
                webhookUrl: `${payment.application.baseUrl}${payment.application.webhookPath}`,
                apiKey: payment.application.apiKey,
                externalEntityId: payment.externalEntityId,
                metadata: payment.metadata ? JSON.parse(payment.metadata) : {},
              })
            }

            pollResults.push({ id: payment.id, reference: payment.reference, status: 'resolved', polledStatus: result.status })
          } else {
            pollResults.push({ id: payment.id, reference: payment.reference, status: 'still_pending' })
          }
        }
      } catch (err: any) {
        console.error(`Error checking status for payment ${payment.id}:`, err)
        pollResults.push({ id: payment.id, reference: payment.reference, status: 'error' })
      }
    }

    return NextResponse.json({
      success: true,
      polledCount: pendingPayments.length,
      results: pollResults,
    })
  } catch (error: any) {
    console.error('sync-payments cron error:', error)
    return NextResponse.json(
      { error: 'Internal server error', message: error?.message || 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  return handleSync(request)
}
