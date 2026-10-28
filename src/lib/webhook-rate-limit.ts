/**
 * How many inbound provider webhooks one source IP may send per minute.
 *
 * THE GUARD AND WHAT IT IS FOR
 * ----------------------------
 * `/api/webhooks/:provider` is reachable without credentials, so it needs a
 * ceiling on how much CPU (HMAC + JSON) and database work a single source can
 * cause. That is all this is: an availability guard. Integrity is enforced by
 * the signature, which is checked before anything is written.
 *
 * WHY 120 WAS WRONG
 * -----------------
 * Mobile-money providers deliver every settlement from a small set of egress
 * addresses, so all of a congregation's giving shares one rate-limit bucket.
 * A Sunday service with a few hundred tithes inside one minute — or any
 * Christmas, harvest or anniversary spike — crossed 120/min and the provider
 * was told 429. Because delivery is at-least-once, nothing was lost, but
 * settlements arrived minutes late while the church's own screens showed
 * "pending", which is indistinguishable from a broken integration.
 *
 * The default is 600/min (10 req/s per IP): comfortably above a large
 * congregation's burst, still bounded. Raise it for a bigger parish via
 * `WEBHOOK_INBOUND_RATE_LIMIT_PER_MINUTE`. Values are clamped so a typo, a
 * blank value or a negative number cannot silently disable the guard, and a
 * huge value cannot be used to.
 *
 * Pure — no imports — so the test runner can reach it and the route can call it
 * per request (the env is read at call time, so it is tunable without a deploy
 * only in the sense that it is restart-scoped; it is evaluated per request so a
 * test can vary it).
 */

export const DEFAULT_INBOUND_RATE_LIMIT_PER_MINUTE = 600
export const MIN_INBOUND_RATE_LIMIT_PER_MINUTE = 60
export const MAX_INBOUND_RATE_LIMIT_PER_MINUTE = 60_000

/**
 * Resolve the inbound per-IP limit from a raw environment value.
 *
 * Unset, blank, non-numeric or `<= 0` → the default (never "unlimited").
 * Out-of-range numbers are clamped rather than rejected, so a configuration
 * mistake degrades to *a* limit instead of removing the guard.
 */
export function inboundRateLimitPerMinute(
  raw: string | undefined = process.env.WEBHOOK_INBOUND_RATE_LIMIT_PER_MINUTE
): number {
  const parsed = Number(String(raw ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INBOUND_RATE_LIMIT_PER_MINUTE
  return Math.min(
    Math.max(Math.floor(parsed), MIN_INBOUND_RATE_LIMIT_PER_MINUTE),
    MAX_INBOUND_RATE_LIMIT_PER_MINUTE
  )
}
