/**
 * Retry backoff policy for outbound partner webhooks.
 *
 * Pure and dependency-free so the schedule is unit-testable.
 */

export const NOTIFICATION_MAX_ATTEMPTS = 5
export const NOTIFICATION_BASE_DELAY_MS = 30_000
export const NOTIFICATION_MAX_DELAY_MS = 6 * 60 * 60 * 1000 // 6 hours

/**
 * Exponential backoff with jitter.
 * attempt 1 → ~30s, 2 → ~2m, 3 → ~8m, 4 → ~32m (capped at 6h).
 *
 * Jitter (± up to 5s) keeps a burst of failures from retrying in lockstep.
 */
export function computeNextRetryAt(
  attemptCount: number,
  options: { baseDelayMs?: number; maxDelayMs?: number; jitterMs?: number; now?: number } = {}
): Date {
  const base = options.baseDelayMs ?? NOTIFICATION_BASE_DELAY_MS
  const max = options.maxDelayMs ?? NOTIFICATION_MAX_DELAY_MS
  const jitterMs = options.jitterMs ?? 5_000
  const now = options.now ?? Date.now()

  const attempt = Math.max(1, Math.floor(attemptCount))
  const exponential = base * Math.pow(4, attempt - 1)
  const capped = Math.min(exponential, max)
  const jitter = Math.floor(Math.random() * jitterMs)

  return new Date(now + capped + jitter)
}

/** True when a notification row has used up its allowed attempts. */
export function isExhausted(attemptCount: number, maxAttempts: number, permanent = false): boolean {
  if (permanent) return true
  return attemptCount >= Math.max(1, maxAttempts)
}

/**
 * Per-status HTTP classification for outbound webhook retries.
 * 4xx (except 408/429) means the partner will never accept this payload, so
 * retrying only wastes quota and delays the alert.
 */
export function isPermanentHttpFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}
