/**
 * The worker that applies the phone-number retention policy.
 *
 * Policy (windows, modes, cutoff arithmetic) lives in `retention.ts`; this is
 * the database half. Shared by the `/api/cron/retention` route and
 * `scripts/apply-retention.ts` so the scheduled path and the manual path cannot
 * drift.
 *
 * Both tables carry a `*RedactedAt` marker and this only ever selects rows
 * where it is null, which makes the worker idempotent: running it twice does
 * nothing the second time, and re-running it can never re-mask an
 * already-masked number into a different one.
 */

import { db } from './db'
import { maskPhoneNumber } from './redact'
import {
  isRetentionDisabled,
  resolvePhoneRetentionDays,
  resolveRetentionMode,
  retentionCutoff,
  type RetentionMode,
} from './retention'

/** `recipient` is NOT NULL in Postgres, so purge replaces rather than nulls. */
export const REDACTED_RECIPIENT = 'REDACTED'

export interface RetentionReport {
  /** Records whose phone number was masked or purged. */
  paymentIntentsRedacted: number
  smsMessagesRedacted: number
  /** True when the batch limit was hit and another run is needed. */
  truncated: boolean
  mode: RetentionMode
  retentionDays: number
  cutoff: string | null
  dryRun: boolean
}

export interface ApplyRetentionOptions {
  /** Override the configured window. */
  days?: number
  /** Override the configured mode. */
  mode?: RetentionMode
  /** Rows considered per table per run. Keeps the cron inside its time budget. */
  batchSize?: number
  /** Report what would change without writing. */
  dryRun?: boolean
  now?: Date
}

/**
 * Mask or purge every phone number older than the retention window.
 *
 * Processes at most `batchSize` rows per table and reports `truncated` when
 * there is more to do, so a large backlog is worked off over successive runs
 * instead of blowing the function's time limit.
 */
export async function applyPhoneRetention(
  options: ApplyRetentionOptions = {}
): Promise<RetentionReport> {
  const days = options.days ?? resolvePhoneRetentionDays()
  const mode = options.mode ?? resolveRetentionMode()
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 5000))
  const now = options.now ?? new Date()
  const dryRun = options.dryRun ?? false

  const empty: RetentionReport = {
    paymentIntentsRedacted: 0,
    smsMessagesRedacted: 0,
    truncated: false,
    mode,
    retentionDays: days,
    cutoff: null,
    dryRun,
  }

  if (isRetentionDisabled(days)) return empty

  const cutoff = retentionCutoff(days, now)

  const [intents, messages] = await Promise.all([
    db.paymentIntent.findMany({
      where: { phoneNumber: { not: null }, phoneRedactedAt: null, createdAt: { lt: cutoff } },
      select: { id: true, phoneNumber: true },
      orderBy: { createdAt: 'asc' },
      take: batchSize + 1,
    }),
    db.smsMessage.findMany({
      where: { recipientRedactedAt: null, createdAt: { lt: cutoff } },
      select: { id: true, recipient: true },
      orderBy: { createdAt: 'asc' },
      take: batchSize + 1,
    }),
  ])

  const intentBatch = intents.slice(0, batchSize)
  const messageBatch = messages.slice(0, batchSize)
  const truncated = intents.length > batchSize || messages.length > batchSize

  const report: RetentionReport = {
    ...empty,
    truncated,
    cutoff: cutoff.toISOString(),
  }

  if (dryRun) {
    report.paymentIntentsRedacted = intentBatch.length
    report.smsMessagesRedacted = messageBatch.length
    return report
  }

  if (mode === 'purge') {
    // Nothing to read back, so both tables go in one statement each.
    if (intentBatch.length > 0) {
      const result = await db.paymentIntent.updateMany({
        where: { id: { in: intentBatch.map((row) => row.id) } },
        data: { phoneNumber: null, phoneRedactedAt: now },
      })
      report.paymentIntentsRedacted = result.count
    }

    if (messageBatch.length > 0) {
      // `recipient` is NOT NULL, so it gets a marker rather than a null.
      const result = await db.smsMessage.updateMany({
        where: { id: { in: messageBatch.map((row) => row.id) } },
        data: { recipient: REDACTED_RECIPIENT, recipientRedactedAt: now },
      })
      report.smsMessagesRedacted = result.count
    }

    return report
  }

  // Masking needs the current value, so it cannot be expressed as an
  // updateMany. The marker is written in the SAME statement as the masked
  // value, so a run that dies part-way leaves the rows it did touch fully
  // done, and the next run picks up the rest without re-masking anything.
  for (const row of intentBatch) {
    await db.paymentIntent.update({
      where: { id: row.id },
      data: {
        phoneNumber: maskPhoneNumber(row.phoneNumber ?? ''),
        phoneRedactedAt: now,
      },
    })
    report.paymentIntentsRedacted += 1
  }

  for (const row of messageBatch) {
    await db.smsMessage.update({
      where: { id: row.id },
      data: {
        recipient: maskPhoneNumber(row.recipient ?? ''),
        recipientRedactedAt: now,
      },
    })
    report.smsMessagesRedacted += 1
  }

  return report
}
