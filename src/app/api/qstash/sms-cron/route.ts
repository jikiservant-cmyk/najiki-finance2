import { NextResponse } from 'next/server'
import { smsQueue, retrySmsNotifications, reconcileSmsDeliveryReports } from '@/lib/sms-queue'
import { smsStore } from '@/lib/sms-store'
import { verifyCronRequest } from '@/lib/qstash-verify'

// Optional: allow function to run longer on Vercel
export const maxDuration = 60

async function handleSmsCron(request: Request) {
  try {
    const isAuthorized = await verifyCronRequest(request)
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Keep this within the 60s serverless limit even when the provider or a
    // partner endpoint is slow. Queued records remain durable for the next run.
    const results = await smsQueue.processBatch(10)
    const reportsResolved = await reconcileSmsDeliveryReports()
    // A row claimed but never handed to the provider has no provider id, so no
    // delivery report can ever settle it and the queued sweep cannot reclaim it.
    // Close it as `unknown` rather than leaving the dashboard reporting a dead
    // row as in-flight for 48 hours. Never resent: the carrier may have accepted it.
    //
    // Wrapped because this is bookkeeping, not delivery: a failure here must not
    // abort the queue drain above and strand every queued message behind it.
    let orphanedReclaimed = 0
    try {
      orphanedReclaimed = await smsStore.reclaimOrphanedPending(
        Number(process.env.SMS_PENDING_RECLAIM_MINUTES || 5)
      )
    } catch (error) {
      console.error('[sms-cron] orphan reclaim failed; continuing', error)
    }
    const staleMarkedUnknown = await smsStore.markStalePendingUnknown()
    const notificationsDelivered = await retrySmsNotifications()
    const reportsPruned = await smsStore.pruneDeliveryReports()
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      processedCount: results.length,
      reportsResolved,
      orphanedReclaimed,
      reportsPruned,
      staleMarkedUnknown,
      notificationsDelivered,
      results,
    })
  } catch (error: any) {
    console.error('SMS cron failed (details omitted)')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Vercel Cron issues GET requests; QStash and manual triggers use POST.
export async function GET(request: Request) {
  return handleSmsCron(request)
}

export async function POST(request: Request) {
  return handleSmsCron(request)
}
