/**
 * Webhook replay/dedupe decisions.
 *
 * The regression this exists to prevent is subtle and was live: a delivery that
 * started but never finished left a row behind with `processed: false`, and the
 * provider's next retry was acknowledged as a *duplicate* of it. The retry
 * stopped, and the payment never settled — a silent loss of a real payment.
 *
 * So these tests care most about the unprocessed case, and about the function
 * treating "no row" and "unfinished row" the same way (both mean: do the work).
 *
 * Node's built-in runner, no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decideWebhookLogAction } from '../src/lib/webhook-dedupe.ts'

test('a first delivery is processed', () => {
  assert.equal(decideWebhookLogAction(null), 'process')
  assert.equal(decideWebhookLogAction(undefined), 'process')
})

test('an event that already completed is a duplicate', () => {
  assert.equal(decideWebhookLogAction({ processed: true }), 'duplicate')
})

test('an event left unfinished is resumed, NOT acknowledged as a duplicate', () => {
  // This is the whole point of the module. The old code returned 'duplicate'
  // here (via a P2002 on the unique key), which told the provider to stop
  // retrying and stranded the payment in a non-terminal state forever.
  assert.equal(decideWebhookLogAction({ processed: false }), 'process')
})

test('an unfinished row wins over "we have seen this before"', () => {
  // Guards the exact shape of the old bug: the row exists, so a naive
  // "row exists → duplicate" shortcut gets the wrong answer.
  const abandoned = { processed: false }
  assert.notEqual(decideWebhookLogAction(abandoned), 'duplicate')
})

test('extra fields on the row do not change the decision', () => {
  assert.equal(
    decideWebhookLogAction({ processed: false, id: 'x', processingError: null } as never),
    'process'
  )
  assert.equal(
    decideWebhookLogAction({ processed: true, id: 'x', processingError: 'AMOUNT_MISMATCH' } as never),
    'duplicate'
  )
})

test('a partial row without a processed flag is treated as unfinished', () => {
  // Defensive: `undefined` is falsy, so an older row shape degrades to doing the
  // work rather than assuming completion.
  assert.equal(decideWebhookLogAction({} as never), 'process')
})
