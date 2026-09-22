/**
 * Unit tests for the pure helpers used on the money path.
 *
 * Runs on Node's built-in test runner with type stripping — no test framework,
 * no database, no network:
 *
 *   npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeWebhookEventHash, sha256Hex } from '../src/lib/webhook-hash.ts'
import { maskPhoneNumber, normalizePhoneNumber, redactPhoneNumbersInText, safeErrorMessage } from '../src/lib/redact.ts'
import {
  computeNextRetryAt,
  isExhausted,
  isPermanentHttpFailure,
  NOTIFICATION_MAX_ATTEMPTS,
} from '../src/lib/backoff.ts'

// ─── webhook idempotency ─────────────────────────────────────────────────────

test('event hash is stable across retries of the same event', () => {
  const first = computeWebhookEventHash({
    providerCode: 'livepay',
    rawBody: '{"internal_reference":"IP-1","status":"success","amount":5000}',
    parsedBody: { internal_reference: 'IP-1', status: 'success', amount: 5000 },
  })
  // Same event, extra fields added by the provider on the retry (e.g. a fresh
  // timestamp) — must still collapse onto the same row.
  const retry = computeWebhookEventHash({
    providerCode: 'livepay',
    rawBody: '{"internal_reference":"IP-1","status":"success","amount":5000,"ts":99}',
    parsedBody: { internal_reference: 'IP-1', status: 'success', amount: 5000, ts: 99 },
  })

  assert.equal(first.strategy, 'event')
  assert.equal(first.hash, retry.hash)
})

test('event hash distinguishes different events and providers', () => {
  const a = computeWebhookEventHash({ providerCode: 'livepay', rawBody: '{}', parsedBody: { internal_reference: 'A', status: 'success' } })
  const b = computeWebhookEventHash({ providerCode: 'livepay', rawBody: '{}', parsedBody: { internal_reference: 'B', status: 'success' } })
  const c = computeWebhookEventHash({ providerCode: 'other', rawBody: '{}', parsedBody: { internal_reference: 'A', status: 'success' } })

  assert.notEqual(a.hash, b.hash)
  assert.notEqual(a.hash, c.hash)
})

test('falls back to a body hash when no event identity is present', () => {
  const result = computeWebhookEventHash({
    providerCode: 'livepay',
    rawBody: '{"unstructured":true}',
    parsedBody: { unstructured: true },
  })
  assert.equal(result.strategy, 'body')
  assert.equal(result.hash, sha256Hex('bd:livepay:{"unstructured":true}'))
})

test('unparseable bodies still hash deterministically', () => {
  const result = computeWebhookEventHash({ providerCode: 'livepay', rawBody: 'not-json', parsedBody: null })
  assert.equal(result.strategy, 'body')
  assert.equal(result.hash, sha256Hex('bd:livepay:not-json'))
})

// ─── PII redaction ───────────────────────────────────────────────────────────

test('phone numbers are masked in logs', () => {
  assert.equal(maskPhoneNumber('+256700123456'), '+2567******56')
  assert.equal(maskPhoneNumber('0700123456'), '0700****56')
  assert.equal(maskPhoneNumber(''), '')
})

test('short values are over-masked rather than leaked', () => {
  assert.equal(maskPhoneNumber('12345'), '****5')
})

test('digits-only normalisation strips formatting', () => {
  assert.equal(normalizePhoneNumber('+256 (700) 123-456'), '256700123456')
})

test('free-text redaction masks phone-like runs only', () => {
  const input = 'delivered to +256700123456 status=success amount=50000 ref=NK-CHU-AB12 id=IP-123456789012'
  const output = redactPhoneNumbersInText(input)
  assert.ok(!output.includes('700123456'), 'phone number must not survive redaction')
  assert.ok(output.includes('+2567'), 'prefix stays readable for debugging')
  assert.ok(output.includes('amount=50000'), 'amounts must not be mangled')
  assert.ok(output.includes('NK-CHU-AB12'), 'references must not be mangled')
  assert.ok(output.includes('IP-123456789012'), 'provider ids must not be mangled')
})

test('safeErrorMessage never throws on odd values', () => {
  assert.equal(safeErrorMessage(new Error('boom')), 'boom')
  assert.equal(safeErrorMessage('plain'), 'plain')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.equal(safeErrorMessage(circular), 'Unknown error')
})

// ─── notification backoff ────────────────────────────────────────────────────

test('backoff grows exponentially and is capped', () => {
  const now = 1_700_000_000_000
  const at = (attempt: number) => computeNextRetryAt(attempt, { now, jitterMs: 1 }).getTime() - now

  assert.equal(at(1), 30_000)
  assert.equal(at(2), 120_000)
  assert.equal(at(3), 480_000)
  assert.equal(at(6), 6 * 60 * 60 * 1000) // capped
  assert.equal(at(20), 6 * 60 * 60 * 1000) // stays capped
})

test('backoff always moves forward in time', () => {
  const now = 1_700_000_000_000
  for (let attempt = 1; attempt <= 8; attempt++) {
    assert.ok(computeNextRetryAt(attempt, { now }).getTime() > now)
  }
})

test('exhaustion is reached at maxAttempts, or immediately when permanent', () => {
  assert.equal(isExhausted(NOTIFICATION_MAX_ATTEMPTS - 1, NOTIFICATION_MAX_ATTEMPTS), false)
  assert.equal(isExhausted(NOTIFICATION_MAX_ATTEMPTS, NOTIFICATION_MAX_ATTEMPTS), true)
  assert.equal(isExhausted(0, NOTIFICATION_MAX_ATTEMPTS, true), true)
})

test('4xx responses are permanent except 408/429', () => {
  assert.equal(isPermanentHttpFailure(400), true)
  assert.equal(isPermanentHttpFailure(403), true)
  assert.equal(isPermanentHttpFailure(404), true)
  assert.equal(isPermanentHttpFailure(408), false)
  assert.equal(isPermanentHttpFailure(429), false)
  assert.equal(isPermanentHttpFailure(500), false)
  assert.equal(isPermanentHttpFailure(200), false)
})
