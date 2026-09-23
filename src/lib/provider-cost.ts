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

/** Currencies with no minor unit. Mirrors src/lib/money.ts for the ones seen here. */
const ZERO_DECIMAL = new Set(['UGX', 'RWF', 'JPY', 'KRW', 'BIF', 'GNF', 'KMF', 'VND', 'XAF', 'XOF', 'XPF', 'CLP', 'ISK', 'PYG', 'DJF', 'VUV'])

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

  const exponent = currency && ZERO_DECIMAL.has(currency) ? 0 : 2
  const scale = 10 ** exponent

  // Half-up on the minor unit, matching src/lib/money.ts.
  return { amountMinor: Math.round(numeric * scale), currency }
}
