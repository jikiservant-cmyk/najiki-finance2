/**
 * Provider amount reconciliation: the payer's gross, the merchant's net, and
 * LivePay's fee.
 *
 * Why this module exists
 * ----------------------
 * LivePay reports two numbers for a successful collection:
 *
 *   amount — the transaction amount
 *   charge — LivePay's own collection fee (3% on Airtel, for example)
 *
 * The gateway used to compare the PaymentIntent amount to `amount` with strict
 * equality and ignore `charge` entirely. That refused perfectly good payments
 * the moment a fee was involved.
 *
 * Production evidence (2026-10-28, tenant `sdfg`, LivePay txn
 * `c14be48a-3590-46af-af1d-3106c6aa1862`):
 *
 *   we requested .................. UGX 17,000   (PaymentIntent.amount)
 *   webhook said .................. amount 17,510, charge 510
 *   LivePay "Revenue (7d)" ........ UGX 17,510   (gross)
 *   LivePay "Account Balance" ..... UGX 17,000   (net = amount - charge)
 *
 * Result of the old gate: `AMOUNT_MISMATCH expected=17000 reported=17510`,
 * the transaction recorded `disputed`, nothing credited to the ledger, and the
 * partner app never told. The SACCO partner hit the same thing (5,000 / 5,150).
 *
 * The 510 is exactly 3% of 17,000, so the fee is added ON TOP of what we asked
 * for — but LivePay is not consistent about which number goes in `amount`:
 * some payloads put the payer's gross there (with the fee inside it), others put
 * the merchant's net there and report the fee separately.
 *
 * The rule that is correct for both, and still strict
 * ---------------------------------------------------
 * A settlement is accepted only when one of these is EXACTLY true (1e-3):
 *
 *   NET   reported - charge === expected     (fee is included in `amount`)
 *   GROSS reported          === expected     (fee is reported separately)
 *
 * Neither branch is a tolerance band: a UGX 100 payment can never satisfy a
 * UGX 20,000 intent under either convention. The branch that matched is
 * recorded (`match`) so an audit trail shows how each payment was read.
 *
 * Backwards compatible: a provider that reports no fee (`charge` absent) is
 * unchanged — only the GROSS branch can match.
 */

/** Comparison tolerance in major currency units (floating-point safety only). */
export const AMOUNT_EPSILON = 0.001

export type ProviderAmountReason =
  | 'OK'
  | 'INVALID_AMOUNT'
  | 'INVALID_CHARGE'
  | 'AMOUNT_MISMATCH'

export interface ProviderAmountInput {
  /** The authoritative amount stored on the PaymentIntent. */
  expected: number | string
  /** The provider's `amount`. Absent => assume it equals expected. */
  reported?: number | string | null
  /** The provider's `charge` / fee. Absent => 0. */
  charge?: number | string | null
}

export type ProviderAmountMatch = 'NET' | 'GROSS' | null

export interface ProviderAmountResult {
  ok: boolean
  /** Authoritative amount from the intent. */
  expected: number
  /** Provider `amount`, as reported. */
  reported: number
  /** Provider fee included in / alongside `reported`. */
  charge: number
  /** `reported - charge`: what the merchant receives when the fee is inside `amount`. */
  net: number
  /** Which exact convention reconciled, if any. */
  match: ProviderAmountMatch
  reason: ProviderAmountReason
  /** Human-readable one-liner suitable for `webhook_logs.processing_error`. */
  detail: string
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

/** Parse a provider-supplied charge. Blank => 0. Anything else must be a finite, non-negative number. */
export function parseProviderCharge(value: unknown): number | null {
  if (isBlank(value)) return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

const equalsAmount = (a: number, b: number) => Math.abs(a - b) <= AMOUNT_EPSILON

/**
 * Decide whether a provider-reported amount settles an intent.
 *
 * `ok` is true when the NET (`reported - charge`) or the GROSS (`reported`)
 * equals `expected` exactly — see the module header for why both are needed.
 * Never throws: invalid input produces `ok: false` with a reason, because a
 * malformed amount must be refused, not crash the webhook.
 */
export function checkProviderAmount(input: ProviderAmountInput): ProviderAmountResult {
  const expected = Number(input.expected)
  const reportedRaw = isBlank(input.reported) ? input.expected : input.reported
  const reported = Number(reportedRaw)
  const parsedCharge = parseProviderCharge(input.charge)
  const charge = parsedCharge ?? NaN

  const net = Number.isFinite(reported) && parsedCharge !== null ? reported - parsedCharge : NaN

  const build = (
    ok: boolean,
    match: ProviderAmountMatch,
    reason: ProviderAmountReason
  ): ProviderAmountResult => ({
    ok,
    expected,
    reported,
    charge,
    net,
    match,
    reason,
    detail: ok
      ? `AMOUNT_OK expected=${expected} reported=${reported} charge=${charge} net=${net} match=${match}`
      : `AMOUNT_MISMATCH expected=${expected} reported=${reported} charge=${charge} net=${net}` +
        (reason === 'AMOUNT_MISMATCH' ? '' : ` reason=${reason}`),
  })

  if (!Number.isFinite(expected) || !Number.isFinite(reported)) {
    return build(false, null, 'INVALID_AMOUNT')
  }
  if (parsedCharge === null) {
    return build(false, null, 'INVALID_CHARGE')
  }

  // GROSS first: when the fee is zero (or already accounted for) this is the
  // historical rule, and `net` equals `reported` anyway.
  if (equalsAmount(reported, expected)) return build(true, 'GROSS', 'OK')
  if (Number.isFinite(net) && equalsAmount(net, expected)) return build(true, 'NET', 'OK')
  return build(false, null, 'AMOUNT_MISMATCH')
}
