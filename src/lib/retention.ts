/**
 * Data-retention policy for customer phone numbers.
 *
 * `payment_intents.phone_number` and `sms_messages.recipient` both hold a
 * customer's mobile number in cleartext, with no expiry. Uganda's Data
 * Protection and Privacy Act requires personal data to be kept no longer than
 * is necessary for the purpose it was collected for — and here that purpose is
 * finished the moment a payment settles or an SMS is delivered. Keeping the
 * number forever means a breach exposes a contactable history of who paid whom,
 * long after anyone needed that.
 *
 * The policy below is a *window*, not a deletion: after the window closes the
 * number is masked to its dialling prefix and last two digits. That is no
 * longer personal data, but it still answers the support questions that
 * actually get asked ("did this payment come from that number?") without
 * holding a contactable identifier. Operators who want the number gone
 * entirely can run the same worker in `purge` mode.
 *
 * Pure policy only — no database, no imports — so it is directly testable.
 * The worker that applies it lives in `retention-store.ts`.
 */

/** Ninety days: long enough to cover a dispute, short enough to be defensible. */
export const DEFAULT_PHONE_RETENTION_DAYS = 90

/** How the worker disposes of a number once its window has closed. */
export type RetentionMode = 'mask' | 'purge'

/**
 * Resolve the configured window, in days.
 *
 * `PHONE_RETENTION_DAYS=0` disables the worker entirely — an explicit opt-out
 * for an operator whose regulator requires raw retention. Anything unparseable
 * or negative falls back to the default rather than silently disabling
 * retention, because "the config was a typo" should not mean "keep everything".
 */
export function resolvePhoneRetentionDays(
  raw: string | number | undefined | null = process.env.PHONE_RETENTION_DAYS
): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PHONE_RETENTION_DAYS

  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(parsed)) return DEFAULT_PHONE_RETENTION_DAYS
  if (parsed <= 0) return 0
  return Math.floor(parsed)
}

/** Resolve the disposition mode. Anything unrecognised means `mask`. */
export function resolveRetentionMode(
  raw: string | undefined | null = process.env.PHONE_RETENTION_MODE
): RetentionMode {
  return String(raw ?? '').trim().toLowerCase() === 'purge' ? 'purge' : 'mask'
}

/** True when the worker is switched off. */
export function isRetentionDisabled(days: number): boolean {
  return days <= 0
}

/**
 * The instant before which records are due for redaction.
 *
 * Records created *at or after* this instant are still inside the window.
 */
export function retentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/** Whether a record created at `createdAt` has left the retention window. */
export function isRedactionDue(
  createdAt: Date | string | number,
  days: number,
  now: Date = new Date()
): boolean {
  if (isRetentionDisabled(days)) return false
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt)
  if (Number.isNaN(created.getTime())) return false
  return created.getTime() < retentionCutoff(days, now).getTime()
}

/** Human-readable window, for logs and the worker's response body. */
export function describeRetentionWindow(days: number, mode: RetentionMode = 'mask'): string {
  if (isRetentionDisabled(days)) {
    return 'Phone-number retention is disabled (PHONE_RETENTION_DAYS=0) — numbers are kept indefinitely.'
  }
  const action = mode === 'purge' ? 'deleted' : 'masked'
  return `Phone numbers are ${action} ${days} day(s) after the record is created.`
}
