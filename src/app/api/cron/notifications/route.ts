// Notification retry worker — POST /api/cron/notifications
// The schema models nextRetryAt + attemptCount + maxAttempts but no worker existed.
// Failed notifications stayed pending forever; source apps never got callbacks.
//
// Deploy via Vercel Cron (vercel.json already included in this patch set):
//   { "crons": [{ "path": "/api/cron/notifications", "schedule": "* * * * *" }] }
//
// Protect with CRON_SECRET env var (set in Vercel dashboard under Environment Variables)

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

const BATCH = 50
const BACKOFF = [1, 2, 5, 15, 30] // minutes between retries (exponential-ish)

export async function POST(request: Request) {
  const auth = request.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  // Uses @@index([status, nextRetryAt]) — only loads due rows
  const pending = await db.internalNotification.findMany({
    where: {
      status: { in: ['pending', 'failed_retrying'] },
      nextRetryAt: { lte: now },
    },
    include: { application: true },
    orderBy: { nextRetryAt: 'asc' },
    take: BATCH,
  })

  const results = { delivered: 0, retrying: 0, exhausted: 0, errors: 0 }

  await Promise.allSettled(
    pending.map(async (notif) => {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)

        const resp = await fetch(notif.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Notification-Attempt': String(notif.attemptCount + 1),
          },
          body: notif.payload,
          signal: controller.signal,
        }).finally(() => clearTimeout(timer))

        const body = await resp.text().catch(() => '')
        const ok = resp.status >= 200 && resp.status < 300

        if (ok) {
          await db.internalNotification.update({
            where: { id: notif.id },
            data: {
              status: 'delivered',
              attemptCount: { increment: 1 },
              lastAttemptAt: now,
              lastResponseStatus: resp.status,
              lastResponseBody: body.slice(0, 500),
            },
          })
          results.delivered++
        } else {
          await fail(notif, resp.status, body)
          results.retrying++
        }
      } catch (err) {
        await fail(notif, 0, err instanceof Error ? err.message : 'Unknown error')
        results.errors++
      }
    })
  )

  return NextResponse.json({ processed: pending.length, ...results })
}

async function fail(
  notif: { id: string; attemptCount: number; maxAttempts: number },
  status: number,
  body: string
) {
  const next = notif.attemptCount + 1
  const exhausted = next >= notif.maxAttempts
  const backoffMin = BACKOFF[Math.min(next - 1, BACKOFF.length - 1)]

  await db.internalNotification.update({
    where: { id: notif.id },
    data: {
      status: exhausted ? 'failed_exhausted' : 'failed_retrying',
      attemptCount: next,
      lastAttemptAt: new Date(),
      nextRetryAt: exhausted ? null : new Date(Date.now() + backoffMin * 60_000),
      lastResponseStatus: status,
      lastResponseBody: body.slice(0, 500),
    },
  })
}
