/**
 * Unit tests for the phone-number retention policy.
 *
 * The failure mode these guard against is a policy that quietly does nothing:
 * if the window resolved to "disabled" on a typo, or the cutoff drifted, the
 * worker would report success every day while customer numbers accumulated
 * indefinitely. So the tests care most about the boundary and the config
 * parsing.
 *
 * Node's built-in runner, no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_PHONE_RETENTION_DAYS,
  describeRetentionWindow,
  isRedactionDue,
  isRetentionDisabled,
  resolvePhoneRetentionDays,
  resolveRetentionMode,
  retentionCutoff,
} from '../src/lib/retention.ts'

const DAY_MS = 24 * 60 * 60 * 1000

// ─── configuration ───────────────────────────────────────────────────────────

test('an unset window falls back to the documented default', () => {
  assert.equal(resolvePhoneRetentionDays(undefined), DEFAULT_PHONE_RETENTION_DAYS)
  assert.equal(resolvePhoneRetentionDays(null), DEFAULT_PHONE_RETENTION_DAYS)
  assert.equal(resolvePhoneRetentionDays(''), DEFAULT_PHONE_RETENTION_DAYS)
  assert.equal(DEFAULT_PHONE_RETENTION_DAYS, 90)
})

test('a valid window is honoured', () => {
  assert.equal(resolvePhoneRetentionDays('30'), 30)
  assert.equal(resolvePhoneRetentionDays('7'), 7)
  assert.equal(resolvePhoneRetentionDays(365), 365)
  assert.equal(resolvePhoneRetentionDays(' 45 '), 45)
})

test('0 is the only value that disables retention', () => {
  assert.equal(resolvePhoneRetentionDays('0'), 0)
  assert.equal(isRetentionDisabled(0), true)
  assert.equal(isRetentionDisabled(-1), true)

  // A negative number is nonsense as a window, but "disabled" is the safer
  // reading of `-5` than "keep for -5 days" (which would redact everything).
  assert.equal(resolvePhoneRetentionDays('-5'), 0)
})

test('a typo falls back to the default rather than disabling retention', () => {
  // The whole point: a bad config must not silently turn the worker off.
  assert.equal(resolvePhoneRetentionDays('ninety'), DEFAULT_PHONE_RETENTION_DAYS)
  assert.equal(resolvePhoneRetentionDays(''), DEFAULT_PHONE_RETENTION_DAYS)
  assert.notEqual(resolvePhoneRetentionDays('oops'), 0)
})

test('fractional windows are floored to whole days', () => {
  assert.equal(resolvePhoneRetentionDays('2.9'), 2)
})

test('only the exact string "purge" selects purge mode', () => {
  assert.equal(resolveRetentionMode('purge'), 'purge')
  assert.equal(resolveRetentionMode('PURGE'), 'purge')
  assert.equal(resolveRetentionMode(' purge '), 'purge')

  assert.equal(resolveRetentionMode('mask'), 'mask')
  assert.equal(resolveRetentionMode(undefined), 'mask')
  assert.equal(resolveRetentionMode(''), 'mask')
  // Anything unrecognised stays with the reversible option.
  assert.equal(resolveRetentionMode('delete'), 'mask')
})

// ─── the window ──────────────────────────────────────────────────────────────

test('the cutoff is exactly the window back from now', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')
  assert.equal(retentionCutoff(30, now).toISOString(), '2026-05-16T12:00:00.000Z')
  assert.equal(retentionCutoff(1, now).toISOString(), '2026-06-14T12:00:00.000Z')
  assert.equal(retentionCutoff(90, now).toISOString(), '2026-03-17T12:00:00.000Z')
})

test('records inside the window are left alone', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')
  assert.equal(isRedactionDue(new Date(now.getTime() - 1 * DAY_MS), 90, now), false)
  assert.equal(isRedactionDue(new Date(now.getTime() - 89 * DAY_MS), 90, now), false)
  assert.equal(isRedactionDue(new Date(now.getTime() - 89.9 * DAY_MS), 90, now), false)
})

test('records past the window are due', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')
  assert.equal(isRedactionDue(new Date(now.getTime() - 91 * DAY_MS), 90, now), true)
  assert.equal(isRedactionDue(new Date(now.getTime() - 365 * DAY_MS), 90, now), true)
})

test('the boundary itself is exclusive — a record is due strictly after the window', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')
  const exactlyAtCutoff = new Date(now.getTime() - 90 * DAY_MS)
  assert.equal(isRedactionDue(exactlyAtCutoff, 90, now), false)
  assert.equal(isRedactionDue(new Date(exactlyAtCutoff.getTime() - 1), 90, now), true)
})

test('a disabled window never redacts, however old the record', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')
  assert.equal(isRedactionDue(new Date('2000-01-01T00:00:00.000Z'), 0, now), false)
})

test('timestamps arrive from Prisma and from JSON alike', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')
  const old = new Date(now.getTime() - 200 * DAY_MS)

  assert.equal(isRedactionDue(old, 90, now), true)
  assert.equal(isRedactionDue(old.toISOString(), 90, now), true)
  assert.equal(isRedactionDue(old.getTime(), 90, now), true)
})

test('an unparseable timestamp is not treated as ancient', () => {
  // Failing towards "leave it alone" is the safe direction: the record is
  // picked up on the next run rather than redacted on a parse error.
  assert.equal(isRedactionDue('not-a-date' as any, 90, new Date()), false)
  assert.equal(isRedactionDue(NaN as any, 90, new Date()), false)
})

// ─── reporting ───────────────────────────────────────────────────────────────

test('the window is described in terms of what will actually happen', () => {
  assert.match(describeRetentionWindow(90, 'mask'), /masked 90 day/)
  assert.match(describeRetentionWindow(30, 'purge'), /deleted 30 day/)
  // Singular reads correctly.
  assert.match(describeRetentionWindow(1, 'mask'), /1 day\(s\)/)
})

test('a disabled window says so rather than claiming to operate', () => {
  const line = describeRetentionWindow(0, 'mask')
  assert.match(line, /disabled/i)
  assert.match(line, /indefinitely/i)
})
