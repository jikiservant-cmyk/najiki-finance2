/**
 * What to do about an inbound provider webhook we have seen before.
 *
 * A provider's delivery is at-least-once, so the same event arrives more than
 * once and must be processed exactly once. The database enforces that with a
 * unique key on `signatureHash`, but the *decision* of what a repeat means is
 * the part that went wrong, so it lives here where it can be tested.
 *
 * THE BUG THIS ENCODES THE FIX FOR
 * --------------------------------
 * The route used to treat "a row with this hash already exists" as "already
 * handled". Those are not the same thing. A row is written with
 * `processed: false` *before* the work is done, so if anything fails after that
 * insert — a transient database error, a timeout, a lost race on the wallet
 * balance — the row survives with `processed: false`.
 *
 * The provider then retries, as it is supposed to. The retry saw an unprocessed
 * row, skipped the "already handled" branch, tried to insert its own row, hit
 * the unique constraint, and answered `200 {duplicate: true}`. The provider
 * stopped retrying. The payment was never settled, and nothing said so.
 *
 * So the rule is: only a row that finished counts as a duplicate. An unfinished
 * row is work to resume — the operation is idempotent, so resuming is safe, and
 * the alternative is losing the payment.
 *
 * Zero imports so the type-stripped test runner can reach it.
 */

export type WebhookLogAction = 'process' | 'duplicate'

/** The only field this decision needs — kept structural so callers can pass a Prisma row. */
export interface ExistingWebhookLog {
  processed: boolean
}

/**
 * Decide whether an inbound event still needs processing.
 *
 *   no row at all          → 'process'    (first delivery)
 *   row, processed: true   → 'duplicate'  (finished; acknowledge and stop)
 *   row, processed: false  → 'process'    (abandoned part-way; resume it)
 *
 * Resuming is what prevents a retried-but-previously-failed delivery from being
 * acknowledged and forgotten. It is deliberately biased towards doing the work
 * again, because every operation behind this decision is idempotent and the
 * cost of the bias is a little wasted effort, whereas the other direction
 * costs a settled payment.
 */
export function decideWebhookLogAction(existing: ExistingWebhookLog | null | undefined): WebhookLogAction {
  return existing?.processed ? 'duplicate' : 'process'
}
