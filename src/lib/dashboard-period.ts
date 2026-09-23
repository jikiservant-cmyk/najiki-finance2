/**
 * Resolving the dashboard's `?period=` parameter.
 *
 * Previously an `else if` ladder: each known value set `dateFilter` and a SQL
 * interval, and **anything unrecognised fell through with `dateFilter` left
 * undefined**. That meant `?period=1d` — a plausible thing for an operator to
 * try — returned all-time totals in the stat cards beside a 14-day chart, with
 * nothing on screen saying the two covered different windows.
 *
 * A whitelist with an explicit default, so an unknown value is a *known* value:
 * the caller always knows which window it got back, and the resolved period is
 * returned in the payload so the UI can show it.
 *
 * Zero imports so the type-stripped test runner can reach it.
 */

export interface ResolvedDashboardPeriod {
  /** The period actually applied — always a member of the whitelist. */
  period: string
  /** Look-back in days, or `null` for "all time". */
  days: number | null
  /** SQL INTERVAL literal for the daily-chart query. */
  interval: string
  /** True when the request asked for something we do not support. */
  fellBack: boolean
}

/** Every period the dashboard reports, and the SQL interval each maps to. */
export const DASHBOARD_PERIODS: Record<string, { days: number | null; interval: string }> = {
  '14d': { days: 14, interval: '14 days' },
  '1m': { days: 30, interval: '30 days' },
  '3m': { days: 90, interval: '90 days' },
  '1y': { days: 365, interval: '365 days' },
  // Not a real interval, just an effectively-unbounded look-back.
  all: { days: null, interval: '100 years' },
}

export const DEFAULT_DASHBOARD_PERIOD = '14d'

/**
 * Canonicalise a requested period.
 *
 * Note the interval strings are literals from this table and never derived from
 * input — the dashboard interpolates one into SQL, and keeping the source a
 * closed set is what makes that safe.
 */
export function resolveDashboardPeriod(
  requested: string | null | undefined,
  fallback: string = DEFAULT_DASHBOARD_PERIOD
): ResolvedDashboardPeriod {
  const key = String(requested ?? '').trim().toLowerCase()
  const selected = DASHBOARD_PERIODS[key]

  if (selected) {
    return { period: key, days: selected.days, interval: selected.interval, fellBack: false }
  }

  const fallbackKey = DASHBOARD_PERIODS[fallback] ? fallback : DEFAULT_DASHBOARD_PERIOD
  const fallbackEntry = DASHBOARD_PERIODS[fallbackKey]
  return {
    period: fallbackKey,
    days: fallbackEntry.days,
    interval: fallbackEntry.interval,
    // Only "was it unknown" — whether the value was empty is not a request error.
    fellBack: key.length > 0,
  }
}

/** Unix ms lower bound for the window, or `undefined` for all time. */
export function periodDateFilter(
  resolved: ResolvedDashboardPeriod,
  now: Date = new Date()
): Date | undefined {
  if (resolved.days === null) return undefined
  return new Date(now.getTime() - resolved.days * 24 * 60 * 60 * 1000)
}
