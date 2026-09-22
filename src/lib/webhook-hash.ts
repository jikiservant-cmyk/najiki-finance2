/**
 * Webhook / notification hashing helpers.
 *
 * Deliberately dependency-free and side-effect-free so the same functions can be
 * unit-tested with `node --test` without a database, Redis or network access.
 */

import { createHash } from 'crypto'

export type DedupeFields = {
  /** Which provider sent the webhook (e.g. "livepay"). */
  providerCode: string
  /** The raw request body exactly as received — never a re-serialized copy. */
  rawBody: string
  /** Parsed body, when it is valid JSON. `null` when parsing failed. */
  parsedBody: Record<string, unknown> | null
}

export type DedupeResult = {
  hash: string
  /**
   * `event` — the provider gave us a stable event identity, so retries of the
   *           same event collapse onto one row.
   * `body`  — no event identity available; fall back to hashing the body.
   */
  strategy: 'event' | 'body'
}

const EVENT_ID_FIELDS = ['internal_reference', 'transactionId', 'transaction_id', 'id'] as const
const STATUS_FIELDS = ['status', 'transactionStatus', 'transaction_status'] as const

function firstString(body: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = body[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/**
 * Build a stable idempotency hash for an inbound webhook.
 *
 * The hash must be derivable from the *same* logical delivery even when the
 * provider retries with a fresh timestamped signature — that is why the event
 * identity (reference + status), and not the signature header, is used.
 *
 * When no event identity is present we fall back to hashing the raw body. Note
 * that a body hash *is* replayable by an attacker who knows the payload, which
 * is why the caller must only persist this row after the signature verifies.
 */
export function computeWebhookEventHash({ providerCode, rawBody, parsedBody }: DedupeFields): DedupeResult {
  const provider = providerCode.toLowerCase()

  if (parsedBody) {
    const eventId = firstString(parsedBody, EVENT_ID_FIELDS)
    if (eventId) {
      const status = firstString(parsedBody, STATUS_FIELDS) ?? ''
      return {
        hash: sha256(`ev:${provider}:${eventId}:${status}`),
        strategy: 'event',
      }
    }
  }

  return {
    hash: sha256(`bd:${provider}:${rawBody}`),
    strategy: 'body',
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** SHA-256 of an arbitrary string — used for the outbound notification ledger. */
export function sha256Hex(value: string): string {
  return sha256(value)
}
