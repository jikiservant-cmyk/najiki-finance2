/**
 * Whether a tenant can actually take a payment through its default provider.
 *
 * `scripts/seed.ts` points `xyz-sacco` at MTN and `hope-academy` at Pesapal.
 * `IMPLEMENTED_PROVIDER_CODES` is `['livepay']` only, so those tenants cannot
 * take a payment at all — and nothing in the product said so. These tests pin
 * the classification that `GET /api/setup` now reports.
 *
 * Node's built-in runner, no database.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  IMPLEMENTED_PROVIDER_CODES,
  defaultProviderIssue,
  isProviderImplemented,
  tenantsWithDefaultProviderIssue,
} from '../src/lib/providers/availability.ts'

const active = (code: string) => ({ code, name: code, isActive: true })
const inactive = (code: string) => ({ code, name: code, isActive: false })

test('only LivePay has a working adapter', () => {
  assert.deepEqual([...IMPLEMENTED_PROVIDER_CODES], ['livepay'])
  assert.equal(isProviderImplemented('livepay'), true)
  assert.equal(isProviderImplemented('LivePay'), true, 'matching is case-insensitive')
  for (const code of ['mtn', 'airtel', 'pesapal', 'stub', '', null, undefined]) {
    assert.equal(isProviderImplemented(code), false, String(code))
  }
})

test('a tenant on an implemented, active provider is fine', () => {
  assert.equal(defaultProviderIssue({ code: 'abc-sacco', isActive: true, defaultProvider: active('livepay') }), null)
})

test('no default provider is allowed — provider is chosen at payment time', () => {
  assert.equal(defaultProviderIssue({ code: 't', isActive: true, defaultProvider: null }), null)
  assert.equal(defaultProviderIssue({ code: 't', isActive: true }), null)
})

/** The seeded xyz-sacco / hope-academy case. */
test('an unimplemented provider is reported', () => {
  assert.equal(
    defaultProviderIssue({ code: 'xyz-sacco', isActive: true, defaultProvider: active('mtn') }),
    'unimplemented'
  )
  assert.equal(
    defaultProviderIssue({ code: 'hope-academy', isActive: true, defaultProvider: active('pesapal') }),
    'unimplemented'
  )
})

test('a deactivated implemented provider is reported separately', () => {
  assert.equal(
    defaultProviderIssue({ code: 't', isActive: true, defaultProvider: inactive('livepay') }),
    'inactive'
  )
})

test('both problems at once are reported together', () => {
  assert.equal(
    defaultProviderIssue({ code: 't', isActive: true, defaultProvider: inactive('mtn') }),
    'unimplemented-and-inactive'
  )
})

test('the list helper returns only the problem tenants, with their provider code', () => {
  const problems = tenantsWithDefaultProviderIssue([
    { code: 'abc-sacco', isActive: true, defaultProvider: active('livepay') },
    { code: 'xyz-sacco', isActive: true, defaultProvider: active('mtn') },
    { code: 'no-default', isActive: true, defaultProvider: null },
    { code: 'hope-academy', isActive: true, defaultProvider: active('pesapal') },
  ])

  assert.deepEqual(problems, [
    { code: 'xyz-sacco', providerCode: 'mtn', issue: 'unimplemented' },
    { code: 'hope-academy', providerCode: 'pesapal', issue: 'unimplemented' },
  ])
})

test('an empty tenant list yields no problems', () => {
  assert.deepEqual(tenantsWithDefaultProviderIssue([]), [])
})
