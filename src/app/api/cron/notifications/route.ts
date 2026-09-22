/**
 * Notification retry worker.
 *
 * The `internal_notifications` table records every outbound partner webhook
 * with attemptCount / maxAttempts / nextRetryAt, and `getPendingNotifications()`
 * selects the rows that are due — but nothing was ever calling it. Failed
 * webhook deliveries were therefore never retried.
 *
 * This worker is intended to run every minute (see vercel.json) and:
 *   1. loads notifications that are due (status pending|failed_retrying),
 *   2. re-delivers them with the same timestamped HMAC signature,
 *   3. reschedules failures with exponential backoff, and
 *   4. marks rows failed_exhausted once maxAttempts is reached.
 */

import { NextResponse } from 'next/server'
import { getPendingNotifications } from '@/lib/data'
import { verifyCronRequest } from '@/lib/qstash-verify'
import {
  deliverQueuedNotification,
  recordNotificationDelivered,
  recordNotificationFailure,
} from '@/lib/payments'

// Allow more time on serverless platforms (Vercel caps at 60s on Hobby).
export const maxDuration = 60

// Never cache — this endpoint has side effects.
export const dynamic = 'force-dynamic'

type ProcessedResult = {
  id: string
  paymentIntentId: string
  status: 'delivered' | 'retrying' | 'exhausted'
  httpStatus?: number
  error?: string
}

async function handleRetry(request: Request) {
  try {
    const isAuthorized = await verifyCronRequest(request)
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const due = await getPendingNotifications()
    const results: ProcessedResult[] = []
    let delivered = 0

    for (const row of due) {
      const outcome = await deliverQueuedNotification({
        id: row.id,
        url: row.url,
        payload: row.payload,
        applicationId: row.applicationId,
      })

      if (outcome.success) {
        await recordNotificationDelivered(row.paymentIntentId, outcome.statusCode ?? 200)
        delivered++
        results.push({
          id: row.id,
          paymentIntentId: row.paymentIntentId,
          status: 'delivered',
          httpStatus: outcome.statusCode,
        })
        continue
      }

      const isPermanent = typeof outcome.error === 'string' && outcome.error.includes('(permanent)')
      await recordNotificationFailure(
        row.paymentIntentId,
        outcome.error || 'Unknown delivery error',
        { permanent: isPermanent, statusCode: outcome.statusCode }
      )

      // Reflect the post-attempt state so callers can see what happened.
      const attempt = (row.attemptCount ?? 0) + 1
      const maxAttempts = row.maxAttempts ?? 5
      const exhausted = isPermanent || attempt >= maxAttempts

      results.push({
        id: row.id,
        paymentIntentId: row.paymentIntentId,
        status: exhausted ? 'exhausted' : 'retrying',
        httpStatus: outcome.statusCode,
        error: outcome.error,
      })
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      dueCount: due.length,
      deliveredCount: delivered,
      results,
    })
  } catch (error: any) {
    console.error('Notifications cron error:', error)
    return NextResponse.json(
      { error: 'Internal server error', message: error?.message || 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function GET(request: Request) {
  return handleRetry(request)
}

export async function POST(request: Request) {
  return handleRetry(request)
}
