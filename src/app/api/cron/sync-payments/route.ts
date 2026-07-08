import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // We look for payment intents that are stuck in 'processing' state
  // and haven't been updated in the last 25 seconds.
  const threshold = new Date(Date.now() - 25000)
  
  const pendingIntents = await db.paymentIntent.findMany({
    where: {
      status: 'processing',
      updatedAt: { lte: threshold }
    },
    include: {
      provider: true,
      application: true
    },
    take: 50,
  })

  let synced = 0
  let failed = 0
  let unchanged = 0

  await Promise.allSettled(
    pendingIntents.map(async (paymentIntent) => {
      try {
        if (!paymentIntent.provider?.code) {
          unchanged++
          return
        }

        const providerClient = getPaymentProvider(paymentIntent.provider.code)
        if (!providerClient.checkPaymentStatus) {
          unchanged++
          return
        }

        const statusResult = await providerClient.checkPaymentStatus(
          paymentIntent.reference,
          paymentIntent.currency,
          paymentIntent.providerPaymentId || undefined
        )

        // If status changed to success or failed, update the DB
        if (statusResult.status !== 'pending' && statusResult.status !== 'processing') {
          const updatedIntent = await db.paymentIntent.update({
            where: { id: paymentIntent.id },
            data: {
              status: statusResult.status,
              failureReason: statusResult.failureReason || null,
              completedAt: statusResult.status === 'success' ? new Date() : null,
              // We don't touch updatedAt unless we actually change the status,
              // but Prisma updates it automatically. This is fine since it's no longer 'processing'.
            }
          })
          
          await db.paymentTransaction.create({
            data: {
              paymentIntentId: paymentIntent.id,
              status: statusResult.status,
              rawProviderResponse: JSON.stringify(statusResult),
              note: 'STATUS_SYNC_FROM_CRON',
            }
          })

          // Queue the webhook notification back to the source application
          await db.internalNotification.create({
            data: {
              paymentIntentId: paymentIntent.id,
              applicationId: paymentIntent.applicationId,
              url: `${paymentIntent.application.baseUrl}${paymentIntent.application.webhookPath}`,
              payload: JSON.stringify({
                paymentIntentId: paymentIntent.id,
                reference: paymentIntent.reference,
                status: statusResult.status,
                amount: paymentIntent.amount,
                currency: paymentIntent.currency,
                providerPaymentId: statusResult.providerPaymentId || paymentIntent.providerPaymentId,
                failureReason: statusResult.failureReason,
                externalEntityId: paymentIntent.externalEntityId,
                metadata: (() => { try { return paymentIntent.metadata ? JSON.parse(paymentIntent.metadata) : {}; } catch(e) { return {}; } })(),
              }),
              status: 'pending',
              attemptCount: 0,
              maxAttempts: 5,
              nextRetryAt: new Date(),
            },
          })

          synced++
        } else {
          // Still processing, update the updatedAt so we don't query it again for another 25s
          await db.paymentIntent.update({
             where: { id: paymentIntent.id },
             data: { updatedAt: new Date() }
          })
          unchanged++
        }
      } catch (err) {
        console.error(`[Cron] Error syncing payment ${paymentIntent.id}:`, err)
        failed++
      }
    })
  )

  return NextResponse.json({ 
    success: true, 
    processed: pendingIntents.length,
    synced,
    unchanged,
    failed
  })
}

export const GET = POST
