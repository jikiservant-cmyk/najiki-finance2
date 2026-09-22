/**
 * Data-retention worker.
 *
 * Masks (or purges) customer phone numbers once they have been held for longer
 * than the retention window. See `src/lib/retention.ts` for the policy and why
 * it exists — briefly, `payment_intents.phone_number` and
 * `sms_messages.recipient` held contactable customer identifiers forever, with
 * no expiry, which is both a breach liability and a storage-limitation problem.
 *
 * Scheduled daily via `scripts/setup-cron-schedules.ts`. `vercel.json` can only
 * carry two daily jobs on the Hobby plan, so this one goes through QStash like
 * the sub-daily workers.
 *
 * Auth: `verifyCronRequest` — either an Upstash QStash signature or
 * `CRON_SECRET` as a bearer token. Never runs unauthenticated.
 */

import { NextResponse } from 'next/server'
import { verifyCronRequest } from '@/lib/qstash-verify'
import { applyPhoneRetention } from '@/lib/retention-store'
import { resolvePhoneRetentionDays, resolveRetentionMode, describeRetentionWindow } from '@/lib/retention'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

async function handleRetention(request: Request) {
  try {
    const isAuthorized = await verifyCronRequest(request)
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const days = resolvePhoneRetentionDays()
    const mode = resolveRetentionMode()

    if (days <= 0) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: describeRetentionWindow(days, mode),
      })
    }

    const report = await applyPhoneRetention({ days, mode, batchSize: 500 })

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      policy: describeRetentionWindow(days, mode),
      ...report,
      // A truthful signal that the backlog is not cleared yet, so a monitor can
      // tell "nothing to do" apart from "still working through it".
      ...(report.truncated
        ? { note: 'Batch limit reached — further records remain and will be processed on the next run.' }
        : {}),
    })
  } catch (error: any) {
    console.error('Retention cron error:', error)
    return NextResponse.json(
      { error: 'Internal server error', message: error?.message || 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function GET(request: Request) {
  return handleRetention(request)
}

export async function POST(request: Request) {
  return handleRetention(request)
}
