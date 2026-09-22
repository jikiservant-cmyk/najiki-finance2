/**
 * Operational alerting worker.
 *
 * The system previously had no way to tell anyone that something was wrong: no
 * health endpoint, no monitoring, no error tracking. Stuck payments and dead
 * webhook deliveries were only discovered when a partner complained.
 *
 * This worker runs on a schedule (see vercel.json / scripts/setup-cron-schedules.ts)
 * and reports:
 *
 *   - dependency failures (DB / Redis)
 *   - payments stuck in pending|processing for over an hour
 *   - partner webhooks exhausted after every retry
 *   - an SMS queue backlog and terminally failed messages
 *
 * Findings are POSTed to `ALERT_WEBHOOK_URL` (Slack/Discord/anything that
 * accepts JSON) through safeFetch, and always returned in the response so an
 * external monitor can act on them without a chat integration.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { redis } from '@/lib/redis'
import { verifyCronRequest } from '@/lib/qstash-verify'
import { safeFetch } from '@/lib/safe-fetch'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

type Alert = {
  id: string
  severity: 'critical' | 'warning'
  title: string
  detail: string
  value?: number
  threshold?: number
}

/** Thresholds — env-overridable so tuning does not need a deploy. */
function thresholds() {
  return {
    stuckPaymentMinutes: Number(process.env.ALERT_STUCK_PAYMENT_MINUTES || 60),
    stuckPaymentCount: Number(process.env.ALERT_STUCK_PAYMENT_COUNT || 5),
    exhaustedNotifications: Number(process.env.ALERT_EXHAUSTED_NOTIFICATIONS || 1),
    smsQueueBacklog: Number(process.env.ALERT_SMS_QUEUE_BACKLOG || 100),
    failedSmsCount: Number(process.env.ALERT_FAILED_SMS || 20),
  }
}

async function handleAlerts(request: Request) {
  try {
    const isAuthorized = await verifyCronRequest(request)
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limits = thresholds()
    const alerts: Alert[] = []
    const metrics: Record<string, number | string> = {}

    // ── 1. Dependencies ─────────────────────────────────────────────────────
    try {
      await db.$queryRawUnsafe('SELECT 1')
      metrics.database = 'ok'
    } catch (error: any) {
      metrics.database = 'down'
      alerts.push({
        id: 'database-down',
        severity: 'critical',
        title: 'Database unreachable',
        detail: error?.message || 'SELECT 1 failed',
      })
    }

    try {
      await redis.ping?.()
      metrics.redis = 'ok'
    } catch (error: any) {
      metrics.redis = 'down'
      alerts.push({
        id: 'redis-down',
        severity: 'critical',
        title: 'Redis unreachable',
        detail: error?.message || 'PING failed',
      })
    }

    // ── 2. Payments stuck in a non-terminal state ───────────────────────────
    try {
      const stuckSince = new Date(Date.now() - limits.stuckPaymentMinutes * 60 * 1000)
      const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const stuck = await db.paymentIntent.count({
        where: {
          status: { in: ['pending', 'processing'] },
          createdAt: { lte: stuckSince, gte: windowStart },
        },
      })
      metrics.stuckPayments = stuck
      if (stuck >= limits.stuckPaymentCount) {
        alerts.push({
          id: 'payments-stuck',
          severity: 'critical',
          title: `${stuck} payments stuck for over ${limits.stuckPaymentMinutes} minutes`,
          detail: 'Provider callbacks or status polling are not resolving these intents.',
          value: stuck,
          threshold: limits.stuckPaymentCount,
        })
      }
    } catch (error: any) {
      console.error('[alerts] stuck payment check failed:', error)
    }

    // ── 3. Partner webhooks that gave up ────────────────────────────────────
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const exhausted = await db.internalNotification.count({
        where: { status: 'failed_exhausted', updatedAt: { gte: since } },
      })
      metrics.exhaustedNotifications = exhausted
      if (exhausted >= limits.exhaustedNotifications) {
        alerts.push({
          id: 'notifications-exhausted',
          severity: 'critical',
          title: `${exhausted} partner webhook(s) exhausted all retries`,
          detail: 'A partner application has not been told about settled payments.',
          value: exhausted,
          threshold: limits.exhaustedNotifications,
        })
      }
    } catch (error: any) {
      console.error('[alerts] notification check failed:', error)
    }

    // ── 4. SMS backlog / failures ───────────────────────────────────────────
    try {
      const [queued, failed] = await Promise.all([
        db.smsMessage.count({ where: { status: { in: ['queued', 'pending'] } } }),
        db.smsMessage.count({
          where: { status: 'failed', updatedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
        }),
      ])
      metrics.smsQueued = queued
      metrics.smsFailedLastHour = failed

      if (queued >= limits.smsQueueBacklog) {
        alerts.push({
          id: 'sms-backlog',
          severity: 'warning',
          title: `SMS queue backlog: ${queued} messages`,
          detail: 'Check that the SMS cron worker is scheduled and running.',
          value: queued,
          threshold: limits.smsQueueBacklog,
        })
      }
      if (failed >= limits.failedSmsCount) {
        alerts.push({
          id: 'sms-failures',
          severity: 'warning',
          title: `${failed} SMS failures in the last hour`,
          detail: 'Provider credentials, sender ID or balance may be the cause.',
          value: failed,
          threshold: limits.failedSmsCount,
        })
      }
    } catch (error: any) {
      console.error('[alerts] sms check failed:', error)
    }

    // ── 5. Notify ───────────────────────────────────────────────────────────
    let notified = false
    let notifyError: string | undefined

    if (alerts.length > 0) {
      const target = process.env.ALERT_WEBHOOK_URL
      if (target) {
        try {
          const text = alerts
            .map((alert) => `${alert.severity === 'critical' ? '🔴' : '🟠'} *${alert.title}*\n${alert.detail}`)
            .join('\n\n')

          const res = await safeFetch(target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              // `text` works for Slack and Discord; structured fields are there
              // for anything else that wants them.
              text: `Na'jiki alerts (${alerts.length})\n\n${text}`,
              alerts,
              metrics,
              timestamp: new Date().toISOString(),
            }),
            signal: AbortSignal.timeout(10_000),
          })
          notified = res.ok
          if (!res.ok) notifyError = `ALERT_WEBHOOK_URL responded ${res.status}`
        } catch (error: any) {
          notifyError = error?.message || 'notification delivery failed'
          console.error('[alerts] failed to deliver notification:', error)
        }
      } else {
        console.warn('[alerts] ALERT_WEBHOOK_URL is not configured — alerts are only returned in this response')
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      alertCount: alerts.length,
      alerts,
      metrics,
      notified,
      ...(notifyError ? { notifyError } : {}),
    })
  } catch (error: any) {
    console.error('Alerts cron error:', error)
    return NextResponse.json(
      { error: 'Internal server error', message: error?.message || 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function GET(request: Request) {
  return handleAlerts(request)
}

export async function POST(request: Request) {
  return handleAlerts(request)
}
