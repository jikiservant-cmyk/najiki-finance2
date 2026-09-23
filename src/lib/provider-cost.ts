/**
 * Parsing the cost figure a provider reports.
 *
 * Africa's Talking returns cost as a formatted string rather than a number —
 * typically `"UGX 50.0000"`, sometimes `"KES 0.8000"`, occasionally empty for
 * sandbox sends. It was previously discarded entirely and the SMS record kept a
 * hardcoded 50, which the dashboard then summed and labelled "Total Cost".
 *
 * The value is converted to the currency's minor units, so UGX (which has no
 * minor unit) is not multiplied by 100 the way a two-decimal currency would be
 * — the same class of mistake as the 100x wallet bug.
 *
 * Zero imports — reachable from the type-stripped test runner.
 */

/**
 * Currencies with no minor unit.
 *
 * A hand-maintained mirror of `ZERO_DECIMAL_CURRENCIES` in src/lib/money.ts —
 * duplicated rather than imported because this module must stay import-free to
 * remain reachable from the type-stripped test runner, and Node's type stripping
 * resolves relative specifiers literally. It had already drifted (UYI was
 * present in money.ts and missing here), which is silent: the cost of a UYI
 * message would have been recorded 100x too large. `tests/currency-exponents.test.ts`
 * asserts the two definitions agree, so the mirror cannot drift again.
 */
export const ZERO_DECIMAL_CURRENCIES = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
] as const

/** Currencies whose minor unit is a thousandth. Mirrors money.ts likewise. */
export const THREE_DECIMAL_CURRENCIES = [
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
] as const

const ZERO_DECIMAL = new Set<string>(ZERO_DECIMAL_CURRENCIES)
const THREE_DECIMAL = new Set<string>(THREE_DECIMAL_CURRENCIES)

export interface ParsedProviderCost {
  /** Amount in the currency's minor units. */
  amountMinor: number
  currency: string | null
}

/**
 * Parse a provider cost string.
 *
 *   parseProviderCost('UGX 50.0000')  → { amountMinor: 50,   currency: 'UGX' }
 *   parseProviderCost('KES 0.8000')   → { amountMinor: 80,   currency: 'KES' }
 *   parseProviderCost('KWD 1.500')    → { amountMinor: 1500, currency: 'KWD' }
 *   parseProviderCost(50)             → { amountMinor: 50,   currency: null }
 *   parseProviderCost('')             → null
 *
 * Returns null when nothing usable is present, so callers can leave the
 * existing value alone rather than writing a misleading zero.
 */
export function parseProviderCost(raw: unknown): ParsedProviderCost | null {
  if (raw === null || raw === undefined) return null

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null
    return { amountMinor: Math.round(raw), currency: null }
  }

  const text = String(raw).trim()
  if (!text) return null

  // Optional three-letter currency, then the amount (digits, one decimal point).
  const match = /([A-Za-z]{3})?\s*([0-9]+(?:\.[0-9]+)?)/.exec(text)
  if (!match) return null

  const currency = match[1] ? match[1].toUpperCase() : null
  const numeric = Number(match[2])
  if (!Number.isFinite(numeric) || numeric < 0) return null

  // Three-decimal currencies exist (KWD, BHD, ...). Treating them as
  // two-decimal understates their cost by 10x, so they are handled explicitly
  // rather than falling into the default.
  const exponent = !currency ? 2 : ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2
  const scale = 10 ** exponent

  // Half-up on the minor unit, matching src/lib/money.ts.
  return { amountMinor: Math.round(numeric * scale), currency }
}
