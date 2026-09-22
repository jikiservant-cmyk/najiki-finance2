/**
 * Unit tests for currency-aware money arithmetic and ledger reconciliation.
 *
 * These guard the ugliest class of bug in this codebase: a payment that is
 * recorded, reported and settled at the wrong magnitude. No database, no
 * network — `src/lib/ledger-core.ts` is deliberately I/O-free.
 *
 *   npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  amountsMatch,
  currencyExponent,
  fromMinorUnits,
  isKnownCurrency,
  isZeroDecimalCurrency,
  minorUnitsToDecimalString,
  toMinorUnits,
} from '../src/lib/money.ts'
import {
  ledgerBalanceFrom,
  reconcileWalletFrom,
  UnknownLedgerDirectionError,
} from '../src/lib/ledger-core.ts'

// ─── currency exponents ──────────────────────────────────────────────────────

test('UGX has no minor unit — the platform default is zero-decimal', () => {
  assert.equal(currencyExponent('UGX'), 0)
  assert.equal(isZeroDecimalCurrency('UGX'), 0 === currencyExponent('UGX'))
  assert.equal(isZeroDecimalCurrency('ugx'), true)
  assert.equal(isKnownCurrency('UGX'), true)
})

test('exponents follow ISO 4217, with 2 as the fallback', () => {
  assert.equal(currencyExponent('USD'), 2)
  assert.equal(currencyExponent('EUR'), 2)
  assert.equal(currencyExponent('KES'), 2)
  assert.equal(currencyExponent('JPY'), 0)
  assert.equal(currencyExponent('KRW'), 0)
  assert.equal(currencyExponent('RWF'), 0)
  assert.equal(currencyExponent('KWD'), 3)
  assert.equal(currencyExponent('BHD'), 3)

  // Unknown codes degrade to ordinary behaviour rather than throwing mid-payment.
  assert.equal(currencyExponent('ZZZ'), 2)
  assert.equal(isKnownCurrency('ZZZ'), false)
  assert.equal(currencyExponent(''), 2)
})

// ─── the 100x bug ────────────────────────────────────────────────────────────

test('a UGX collection is NOT multiplied by 100', () => {
  // This is the regression that mattered: 5,000 UGX collected was credited to
  // the tenant wallet as 500,000 minor units.
  assert.equal(toMinorUnits(5000, 'UGX'), 5000n)
  assert.equal(toMinorUnits(5000, 'UGX') * 100n, 500000n)

  // A two-decimal currency still scales as before.
  assert.equal(toMinorUnits(5000, 'USD'), 500000n)
})

test('zero-decimal amounts round to whole units', () => {
  assert.equal(toMinorUnits(5000.4, 'UGX'), 5000n)
  assert.equal(toMinorUnits(5000.5, 'UGX'), 5001n)
  assert.equal(toMinorUnits('0.5', 'UGX'), 1n)
  assert.equal(toMinorUnits(0, 'UGX'), 0n)
})

test('float noise is rounded away, not truncated into a wrong amount', () => {
  // 0.1 + 0.2 === 0.30000000000000004 — the noise sits below the minor unit.
  assert.equal(toMinorUnits(0.1 + 0.2, 'USD'), 30n)
  assert.equal(toMinorUnits(19.99, 'USD'), 1999n)
  // 1.005 is not representable in binary floating point (it is really
  // 1.00499999999999989...). A literal 1.005 means 1.005, so it rounds half-up
  // to 1.01 rather than back down to 1.00.
  assert.equal(toMinorUnits(1.005, 'USD'), 101n)
  assert.equal(toMinorUnits('1.005', 'USD'), 101n)
})

test('extreme exponents still parse instead of throwing', () => {
  // toString() would give "1e-7"; the fixed-point fallback expands it.
  assert.equal(toMinorUnits(1e-7, 'USD'), 0n)
  assert.equal(toMinorUnits(0.0000001234, 'USD'), 0n)
})

test('three-decimal currencies keep their thousandth', () => {
  assert.equal(toMinorUnits('1.234', 'KWD'), 1234n)
  assert.equal(toMinorUnits('1.235', 'KWD'), 1235n)
  assert.equal(toMinorUnits('1.2345', 'KWD'), 1235n)
})

test('negative amounts keep their sign', () => {
  assert.equal(toMinorUnits(-5000, 'UGX'), -5000n)
  assert.equal(toMinorUnits('-12.34', 'USD'), -1234n)
  assert.equal(toMinorUnits('-0.5', 'UGX'), -1n)
})

test('string and Decimal-like inputs are accepted', () => {
  assert.equal(toMinorUnits('5000', 'UGX'), 5000n)
  assert.equal(toMinorUnits('5000.00', 'UGX'), 5000n)
  assert.equal(toMinorUnits('12.50', 'USD'), 1250n)
  // Prisma.Decimal exposes toString()
  assert.equal(toMinorUnits({ toString: () => '1234.56' }, 'USD'), 123456n)
})

test('nonsense amounts fail loudly instead of silently becoming 0', () => {
  assert.throws(() => toMinorUnits('not-a-number' as any, 'UGX'), /not a decimal number/)
  assert.throws(() => toMinorUnits(NaN as any, 'UGX'), /not a finite number/)
  assert.throws(() => toMinorUnits(Infinity as any, 'UGX'), /not a finite number/)
  assert.throws(() => toMinorUnits(1e16 as any, 'UGX'), /out of range/)
})

// ─── round trips ─────────────────────────────────────────────────────────────

test('minor units round-trip back to the original amount', () => {
  assert.equal(fromMinorUnits(toMinorUnits(5000, 'UGX'), 'UGX'), 5000)
  assert.equal(fromMinorUnits(toMinorUnits(12.5, 'USD'), 'USD'), 12.5)
  assert.equal(fromMinorUnits(toMinorUnits('1.234', 'KWD'), 'KWD'), 1.234)
  assert.equal(fromMinorUnits(-2500n, 'UGX'), -2500)
})

test('exact decimal rendering never goes through a float', () => {
  assert.equal(minorUnitsToDecimalString(5000n, 'UGX'), '5000')
  assert.equal(minorUnitsToDecimalString(1250n, 'USD'), '12.50')
  assert.equal(minorUnitsToDecimalString(5n, 'USD'), '0.05')
  assert.equal(minorUnitsToDecimalString(0n, 'USD'), '0.00')
  assert.equal(minorUnitsToDecimalString(1234n, 'KWD'), '1.234')
  assert.equal(minorUnitsToDecimalString(-1250n, 'USD'), '-12.50')
})

test('amountsMatch compares at the currency precision', () => {
  assert.equal(amountsMatch(5000, 5000.0, 'UGX'), true)
  assert.equal(amountsMatch('5000', 5000, 'UGX'), true)
  // Below the minor unit of UGX, so equal.
  assert.equal(amountsMatch(5000, 5000.4, 'UGX'), true)
  // A whole unit apart is not equal.
  assert.equal(amountsMatch(5000, 5001, 'UGX'), false)
  // Same numbers, different precision: 0.4 UGX is not 0.4 USD.
  assert.equal(amountsMatch(5000.4, 5000.4, 'USD'), true)
  assert.equal(amountsMatch(5000.4, 5000.5, 'USD'), false)
})

// ─── ledger reconciliation ───────────────────────────────────────────────────

test('a balance is the sum of credits minus debits', () => {
  assert.equal(
    ledgerBalanceFrom([
      { direction: 'credit', amountMinor: 5000n },
      { direction: 'credit', amountMinor: 2500n },
      { direction: 'debit', amountMinor: 1000n },
    ]),
    6500n
  )
  assert.equal(ledgerBalanceFrom([]), 0n)
})

test('direction casing does not change the sign', () => {
  assert.equal(ledgerBalanceFrom([{ direction: 'CREDIT', amountMinor: 7n }]), 7n)
  assert.equal(ledgerBalanceFrom([{ direction: 'Debit', amountMinor: 7n }]), -7n)
})

test('a number amountMinor is coerced exactly', () => {
  assert.equal(ledgerBalanceFrom([{ direction: 'credit', amountMinor: 5000 }]), 5000n)
})

test('an unknown direction is an error, not a silently dropped entry', () => {
  assert.throws(
    () => ledgerBalanceFrom([{ direction: 'transfer', amountMinor: 5n }]),
    UnknownLedgerDirectionError
  )
})

test('matching balances reconcile clean', () => {
  const result = reconcileWalletFrom(
    { id: 'w1', tenantId: 't1', appCode: 'najiki', currency: 'UGX', balanceMinor: 7500n },
    [
      { direction: 'credit', amountMinor: 5000n },
      { direction: 'credit', amountMinor: 2500n },
    ]
  )

  assert.equal(result.balanced, true)
  assert.equal(result.driftMinor, 0n)
  assert.equal(result.entryCount, 2)
})

test('a 100x inflated balance is reported as drift, not as health', () => {
  // Exactly the historical shape: one 5,000 UGX collection whose entries were
  // written as 500,000 minor units.
  const result = reconcileWalletFrom(
    { id: 'w1', tenantId: 't1', appCode: 'najiki', currency: 'UGX', balanceMinor: 500000n },
    [{ direction: 'credit', amountMinor: 5000n }]
  )

  assert.equal(result.balanced, false)
  assert.equal(result.driftMinor, 495000n)
})

test('an empty ledger against a funded balance is drift', () => {
  const result = reconcileWalletFrom(
    { id: 'w1', tenantId: 't1', appCode: 'najiki', currency: 'UGX', balanceMinor: 5000n },
    []
  )
  assert.equal(result.balanced, false)
  assert.equal(result.driftMinor, 5000n)
})

test('reconciliation reports the drift in the wallet currency', () => {
  const ugx = reconcileWalletFrom(
    { id: 'w1', tenantId: 't1', appCode: 'najiki', currency: 'UGX', balanceMinor: 500000n },
    [{ direction: 'credit', amountMinor: 5000n }]
  )
  assert.equal(minorUnitsToDecimalString(ugx.driftMinor, ugx.currency), '495000')

  const usd = reconcileWalletFrom(
    { id: 'w2', tenantId: 't1', appCode: 'najiki', currency: 'USD', balanceMinor: 1250n },
    [{ direction: 'credit', amountMinor: 1000n }]
  )
  assert.equal(minorUnitsToDecimalString(usd.driftMinor, usd.currency), '2.50')
})
