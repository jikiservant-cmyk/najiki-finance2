/**
 * The two currency-exponent definitions must agree.
 *
 * `src/lib/money.ts` owns the ISO 4217 exponent table for money arithmetic;
 * `src/lib/provider-cost.ts` keeps a hand-maintained mirror, because it has to
 * stay import-free to be reachable from this test runner. A mirror that drifts
 * is silently wrong money: the sets had already diverged once (UYI was in money.ts
 * and missing from provider-cost.ts), which would have recorded the cost of a
 * UYI message 100x too large.
 *
 * So the mirror is asserted rather than trusted. If this test fails, the two
 * definitions disagree — fix the smaller list, do not relax the test.
 *
 * Node's built-in runner, no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ZERO_DECIMAL_CURRENCIES, THREE_DECIMAL_CURRENCIES } from '../src/lib/money.ts'
import {
  ZERO_DECIMAL_CURRENCIES as COST_ZERO_DECIMAL,
  THREE_DECIMAL_CURRENCIES as COST_THREE_DECIMAL,
  parseProviderCost,
} from '../src/lib/provider-cost.ts'

function sorted(values: readonly string[]): string[] {
  return [...values].map((v) => v.toUpperCase()).sort()
}

test('the zero-decimal sets are identical in both modules', () => {
  assert.deepEqual(
    sorted(COST_ZERO_DECIMAL),
    sorted(ZERO_DECIMAL_CURRENCIES),
    'provider-cost.ts has drifted from money.ts: a currency in one list and not the other is parsed with the wrong exponent'
  )
})

test('the three-decimal sets are identical in both modules', () => {
  assert.deepEqual(sorted(COST_THREE_DECIMAL), sorted(THREE_DECIMAL_CURRENCIES))
})

test('no currency is in both exponent lists', () => {
  const overlap = sorted(ZERO_DECIMAL_CURRENCIES).filter((code) =>
    sorted(THREE_DECIMAL_CURRENCIES).includes(code)
  )
  assert.deepEqual(overlap, [])
})

test('every code in either list is a three-letter upper-case code', () => {
  for (const code of [...ZERO_DECIMAL_CURRENCIES, ...THREE_DECIMAL_CURRENCIES]) {
    assert.match(code, /^[A-Z]{3}$/)
  }
})

test('UGX — the platform default — really is zero-decimal in both', () => {
  // The whole point of the table: a 100x error here is the difference between
  // 5,000 UGX and 500,000 UGX of credited balance.
  assert.ok(sorted(ZERO_DECIMAL_CURRENCIES).includes('UGX'))
  assert.ok(sorted(COST_ZERO_DECIMAL).includes('UGX'))
  assert.equal(parseProviderCost('UGX 50.0000')?.amountMinor, 50)
  assert.equal(parseProviderCost('KES 0.8000')?.amountMinor, 80)
})

test('a three-decimal currency is not parsed as two-decimal', () => {
  // KWD 1.500 is 1500 fils, not 150 — the drift this test exists to prevent
  // also covers getting the exponent of a third currency family wrong.
  assert.equal(parseProviderCost('KWD 1.500')?.amountMinor, 1500)
  assert.equal(parseProviderCost('BHD 2.250')?.amountMinor, 2250)
})
