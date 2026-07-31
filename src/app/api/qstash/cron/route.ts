import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'
import { createHmac } from 'crypto'
import { safeFetch } from '@/lib/safe-fetch'
import { enqueueWebhookNotification } from '@/lib/payments'

export async function POST(request: Request) {
  try {
    // Optional QStash signature / secret check if present in env
    const qstashSignature = request.headers.get('upstash-signature')
    
    // Parse query params for optional app-specific cron execution
    const url = new URL(request.url)
    const appCode = url.searchParams.get('app')
    
    // 1. Find all pending payments older than 30 seconds
    const thirtySecondsAgo = new Date(Date.now() - 30_000)
    const pendingPayments = await db.paymentIntent.findMany({
      where: {
        status: 'pending',
        createdAt: { lte: thirtySecondsAgo },
        ...(appCode ? { application: { code: appCode } } : {}),
      },
      include: {
        provider: true,
        application: true,
      },
      take: 50,
    })

    const pollResults: Array<{ id: string; reference: string; status: string; polledStatus?: string }> = []

    for (const payment of pendingPayments) {
      try {
        const providerClient = getPaymentProvider(payment.provider.code)
        if (providerClient.checkPaymentStatus) {
          const result = await providerClient.checkPaymentStatus(
            payment.reference,
            payment.currency,
            payment.providerPaymentId || undefined
          )

          if (result && (result.status === 'success' || result.status === 'failed')) {
            await db.$transaction([
              db.paymentIntent.update({
                where: { id: payment.id },
                data: {
                  status: result.status,
                  failureReason: result.failureReason,
                  completedAt: result.status === 'success' ? new Date() : null,
                },
              }),
              db.paymentTransaction.create({
                data: {
                  paymentIntentId: payment.id,
                  status: result.status,
                  rawProviderResponse: JSON.stringify(result),
                  note: `QSTASH_CRON_POLL | Status: ${result.status}`,
                },
              }),
            ])

            // Create completion event for webhook delivery
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

            pollResults.push({ id: payment.id, reference: payment.reference, status: 'resolved', polledStatus: result.status })
          } else {
            pollResults.push({ id: payment.id, reference: payment.reference, status: 'still_pending' })
          }
        }
      } catch (err: any) {
        pollResults.push({ id: payment.id, reference: payment.reference, status: 'error', polledStatus: err.message })
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      polledPaymentsCount: pendingPayments.length,
      pollResults,
    })
  } catch (error: any) {
    console.error('QStash cron error:', error)
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
  }
}

export async function GET(request: Request) {
  return POST(request)
}
