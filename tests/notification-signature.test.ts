/**
 * Outbound webhook signing.
 *
 * Both notification senders — payment completion and SMS delivery — now call
 * this one function, because they previously signed differently and a partner
 * can only implement one verifier. These tests pin the two properties that
 * matter and that the old SMS path got wrong:
 *
 *   1. The timestamp is inside the signed string, so a captured body cannot be
 *      replayed later with a refreshed header.
 *   2. The secret is never placed in a header.
 *
 * Node's built-in runner, no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildNotificationHeaders,
  verifyNotificationSignature,
  NOTIFICATION_SIGNATURE_HEADER,
  NOTIFICATION_TIMESTAMP_HEADER,
} from '../src/lib/notification-signature.ts'

const SECRET = 'njk_whsec_a-test-signing-secret'
const PAYLOAD = JSON.stringify({ status: 'delivered', smsId: 'abc' })
const T0 = 1_700_000_000_000

test('a signed payload carries a timestamped signature', () => {
  const headers = buildNotificationHeaders(SECRET, PAYLOAD, T0)

  assert.equal(headers[NOTIFICATION_TIMESTAMP_HEADER], String(T0))
  assert.match(headers[NOTIFICATION_SIGNATURE_HEADER], /^t=\d+,v=[0-9a-f]{64}$/)
  assert.ok(headers[NOTIFICATION_SIGNATURE_HEADER].startsWith(`t=${T0},v=`))
})

test('the secret never appears in any header', () => {
  // The old SMS path sent `Authorization: Bearer <secret>`, copying the signing
  // key into every partner's proxy and log aggregator.
  const headers = buildNotificationHeaders(SECRET, PAYLOAD, T0)

  for (const [name, value] of Object.entries(headers)) {
    assert.equal(value.includes(SECRET), false, `secret leaked in header ${name}`)
    assert.notEqual(name.toLowerCase(), 'authorization')
  }
})

test('no signature headers at all when there is no secret', () => {
  const headers = buildNotificationHeaders(null, PAYLOAD, T0)
  assert.equal(headers[NOTIFICATION_SIGNATURE_HEADER], undefined)
  assert.equal(headers[NOTIFICATION_TIMESTAMP_HEADER], undefined)
  // Still usable as a delivery, just unsigned.
  assert.equal(headers['Content-Type'], 'application/json')
})

test('the timestamp is part of the signed string, so a replay fails', () => {
  const headers = buildNotificationHeaders(SECRET, PAYLOAD, T0)
  const signature = headers[NOTIFICATION_SIGNATURE_HEADER]

  // Correct timestamp verifies.
  assert.equal(
    verifyNotificationSignature({
      secret: SECRET,
      payloadString: PAYLOAD,
      timestamp: headers[NOTIFICATION_TIMESTAMP_HEADER],
      signature,
      now: T0,
    }),
    true
  )

  // Replaying the same body/signature with a *newer* timestamp must fail: the
  // timestamp is inside the HMAC, so it cannot be swapped independently.
  assert.equal(
    verifyNotificationSignature({
      secret: SECRET,
      payloadString: PAYLOAD,
      timestamp: String(T0 + 60_000),
      signature,
      now: T0 + 60_000,
    }),
    false
  )
})

test('a valid signature older than the skew window is rejected', () => {
  const headers = buildNotificationHeaders(SECRET, PAYLOAD, T0)

  assert.equal(
    verifyNotificationSignature({
      secret: SECRET,
      payloadString: PAYLOAD,
      timestamp: headers[NOTIFICATION_TIMESTAMP_HEADER],
      signature: headers[NOTIFICATION_SIGNATURE_HEADER],
      now: T0 + 10 * 60 * 1000, // ten minutes later
    }),
    false
  )
})

test('a tampered payload, wrong secret, or malformed input fails', () => {
  const headers = buildNotificationHeaders(SECRET, PAYLOAD, T0)
  const base = {
    payloadString: PAYLOAD,
    timestamp: headers[NOTIFICATION_TIMESTAMP_HEADER],
    signature: headers[NOTIFICATION_SIGNATURE_HEADER],
    now: T0,
  }

  assert.equal(verifyNotificationSignature({ ...base, secret: SECRET }), true)
  assert.equal(verifyNotificationSignature({ ...base, secret: 'wrong' }), false)
  assert.equal(
    verifyNotificationSignature({ ...base, secret: SECRET, payloadString: '{"status":"failed"}' }),
    false
  )
  assert.equal(verifyNotificationSignature({ ...base, secret: SECRET, signature: '' }), false)
  assert.equal(verifyNotificationSignature({ ...base, secret: SECRET, timestamp: null }), false)
  assert.equal(verifyNotificationSignature({ ...base, secret: SECRET, timestamp: 'not-a-number' }), false)
})

test('the same secret and payload sign identically for both senders', () => {
  // The invariant: payment notifications and SMS notifications are produced by
  // the same function, so one partner verifier covers both.
  const a = buildNotificationHeaders(SECRET, PAYLOAD, T0)
  const b = buildNotificationHeaders(SECRET, PAYLOAD, T0)
  assert.deepEqual(a, b)
})

test('a different payload or secret produces a different signature', () => {
  const first = buildNotificationHeaders(SECRET, PAYLOAD, T0)
  const otherPayload = buildNotificationHeaders(SECRET, '{"x":1}', T0)
  const otherSecret = buildNotificationHeaders('another-secret', PAYLOAD, T0)

  assert.notEqual(first[NOTIFICATION_SIGNATURE_HEADER], otherPayload[NOTIFICATION_SIGNATURE_HEADER])
  assert.notEqual(first[NOTIFICATION_SIGNATURE_HEADER], otherSecret[NOTIFICATION_SIGNATURE_HEADER])
})
