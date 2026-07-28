import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'
import { inngest } from '@/lib/inngest/client'
import { createHmac } from 'crypto'

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

            // Emit completion event for webhook delivery
            await inngest.send({
              name: 'payment.completed',
              data: {
                paymentIntentId: payment.id,
                reference: payment.reference,
                status: result.status,
                amount: Number(payment.amount),
                currency: payment.currency,
                providerPaymentId: result.providerPaymentId || payment.providerPaymentId,
                failureReason: result.failureReason,
                applicationId: payment.applicationId,
                webhookUrl: `${payment.application.baseUrl}${payment.application.webhookPath}`,
                apiKey: payment.application.apiKey,
                externalEntityId: payment.externalEntityId,
                metadata: payment.metadata ? JSON.parse(payment.metadata) : {},
              },
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

    // 2. Dispatch pending webhook notifications
    const pendingNotifications = await db.internalNotification.findMany({
      where: {
        status: { in: ['pending', 'failed_retrying'] },
        nextRetryAt: { lte: new Date() },
        ...(appCode ? { application: { code: appCode } } : {}),
      },
      include: { application: true },
      take: 50,
    })

    const notifResults: Array<{ id: string; status: string }> = []

    for (const notif of pendingNotifications) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Najiki-Notification': 'true',
        }
        if (notif.application.apiKey) {
          headers['X-Najiki-Signature'] = createHmac('sha256', notif.application.apiKey).update(notif.payload).digest('hex')
          headers['Authorization'] = `Bearer ${notif.application.apiKey}`
        }

        const res = await fetch(notif.url, { method: 'POST', headers, body: notif.payload })

        if (res.ok) {
          await db.internalNotification.update({
            where: { id: notif.id },
            data: {
              status: 'delivered',
              attemptCount: notif.attemptCount + 1,
              lastAttemptAt: new Date(),
              lastResponseStatus: res.status,
              nextRetryAt: null,
            },
          })
          notifResults.push({ id: notif.id, status: 'delivered' })
        } else {
          const newCount = notif.attemptCount + 1
          const maxReached = newCount >= (notif.maxAttempts || 5)
          await db.internalNotification.update({
            where: { id: notif.id },
            data: {
              status: maxReached ? 'failed_exhausted' : 'failed_retrying',
              attemptCount: newCount,
              lastAttemptAt: new Date(),
              lastResponseStatus: res.status,
              nextRetryAt: maxReached ? null : new Date(Date.now() + Math.pow(2, newCount) * 60000),
            },
          })
          notifResults.push({ id: notif.id, status: maxReached ? 'failed_exhausted' : 'failed_retrying' })
        }
      } catch (err: any) {
        const newCount = notif.attemptCount + 1
        const maxReached = newCount >= (notif.maxAttempts || 5)
        await db.internalNotification.update({
          where: { id: notif.id },
          data: {
            status: maxReached ? 'failed_exhausted' : 'failed_retrying',
            attemptCount: newCount,
            lastAttemptAt: new Date(),
            lastResponseBody: err.message,
            nextRetryAt: maxReached ? null : new Date(Date.now() + Math.pow(2, newCount) * 60000),
          },
        })
        notifResults.push({ id: notif.id, status: 'failed_error' })
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      polledPaymentsCount: pendingPayments.length,
      pollResults,
      processedNotificationsCount: pendingNotifications.length,
      notifResults,
    })
  } catch (error: any) {
    console.error('QStash cron error:', error)
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
  }
}

export async function GET(request: Request) {
  return POST(request)
}
