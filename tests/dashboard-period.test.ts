/**
 * Dashboard period resolution.
 *
 * The bug this guards: an `else if` ladder left `dateFilter` undefined for any
 * unrecognised `?period=` value, so the stat cards reported **all time** while
 * the daily chart reported 14 days, with nothing on screen saying so. An
 * operator reading "1d" and getting lifetime totals has been misinformed by the
 * default rather than by their own mistake.
 *
 * Node's built-in runner, no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DASHBOARD_PERIODS,
  DEFAULT_DASHBOARD_PERIOD,
  periodDateFilter,
  resolveDashboardPeriod,
} from '../src/lib/dashboard-period.ts'

test('every known period resolves to itself', () => {
  for (const key of Object.keys(DASHBOARD_PERIODS)) {
    const resolved = resolveDashboardPeriod(key)
    assert.equal(resolved.period, key)
    assert.equal(resolved.fellBack, false)
  }
})

test('an unknown period becomes the default rather than becoming all-time', () => {
  // This is the regression. Under the old ladder `?period=1d` applied NO date
  // filter, i.e. it behaved like "all", which is the opposite of what was asked.
  const resolved = resolveDashboardPeriod('1d')

  assert.equal(resolved.period, DEFAULT_DASHBOARD_PERIOD)
  assert.equal(resolved.days, 14)
  assert.notEqual(resolved.days, null, 'an unknown period must not mean "all time"')
  assert.equal(resolved.fellBack, true)
})

test('other plausible but unsupported values also fall back, and say so', () => {
  for (const bad of ['7d', 'today', '2y', 'ALL TIME', 'x', '%', '../../etc']) {
    const resolved = resolveDashboardPeriod(bad)
    assert.equal(resolved.days, 14, `${bad} should fall back to 14 days`)
    assert.equal(resolved.fellBack, true)
  }
})

test('an empty or missing period is the default, and is not flagged as a mistake', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const resolved = resolveDashboardPeriod(empty)
    assert.equal(resolved.period, DEFAULT_DASHBOARD_PERIOD)
    // Nothing was requested, so nothing was rejected.
    assert.equal(resolved.fellBack, false)
  }
})

test('"all" is still available, and is the only period with no date filter', () => {
  const all = resolveDashboardPeriod('all')
  assert.equal(all.period, 'all')
  assert.equal(all.days, null)
  assert.equal(periodDateFilter(all), undefined)

  for (const key of Object.keys(DASHBOARD_PERIODS).filter((k) => k !== 'all')) {
    assert.notEqual(periodDateFilter(resolveDashboardPeriod(key)), undefined, `${key} needs a filter`)
  }
})

test('case and padding do not change the period', () => {
  assert.equal(resolveDashboardPeriod(' 14D ').period, '14d')
  assert.equal(resolveDashboardPeriod('ALL').period, 'all')
  assert.equal(resolveDashboardPeriod('1M').period, '1m')
})

test('the date filter is the requested distance back from now', () => {
  const now = new Date('2026-01-31T00:00:00.000Z')

  const twoWeeks = periodDateFilter(resolveDashboardPeriod('14d'), now)
  assert.equal(twoWeeks?.toISOString(), '2026-01-17T00:00:00.000Z')

  const aMonth = periodDateFilter(resolveDashboardPeriod('1m'), now)
  assert.equal(aMonth?.toISOString(), '2026-01-01T00:00:00.000Z')
})

test('every interval is a literal from the table, never caller input', () => {
  // `interval` is interpolated into SQL. Keeping its source a closed set is what
  // makes that safe, so assert the property rather than trusting it.
  const allowed = new Set(Object.values(DASHBOARD_PERIODS).map((entry) => entry.interval))

  for (const input of ['14d', 'all', 'nonsense', "'; DROP TABLE payment_intents; --"]) {
    const resolved = resolveDashboardPeriod(input)
    assert.ok(allowed.has(resolved.interval), `unsafe interval produced: ${resolved.interval}`)
    assert.match(resolved.interval, /^\d+ (days|years)$/)
  }
})

test('the fallback argument is itself validated', () => {
  // A bad fallback must not become an empty or unknown period.
  assert.equal(resolveDashboardPeriod('nope', 'not-a-period').period, DEFAULT_DASHBOARD_PERIOD)
  assert.equal(resolveDashboardPeriod('nope', '1y').period, '1y')
  assert.equal(resolveDashboardPeriod('nope', '1y').days, 365)
})
