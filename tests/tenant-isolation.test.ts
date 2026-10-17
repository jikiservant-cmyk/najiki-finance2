/**
 * Tenant credential isolation.
 *
 * The invariant: money collected for a tenant lands in the TENANT's provider
 * account and is confirmed by the TENANT's webhook secret. Platform credentials
 * are for platform revenue only, and are never a silent fallback for tenant
 * money.
 *
 * These tests exist because of two pen-test findings:
 *
 *   F-1  enforcement was keyed to a hardcoded `['sacco']`, so an application
 *        called `sacco2` collected its tenants' money on the platform account
 *        with no error. The list is now env-overridable, and matching is
 *        deliberately EXACT — so the tests pin that `sacco2` is not covered, and
 *        that the operator can add it without a deploy.
 *
 *   F-2  `LivePayProvider` substitutes a platform env value PER FIELD, so a
 *        credential row with `apiKey` set and `accountNo` blank authenticated as
 *        the tenant and settled into the platform account number. Credentials
 *        are now all-or-nothing: a partial row is treated as no row.
 *
 * Node's built-in runner, no database, no network.
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  appRequiresTenantCredentials,
  tenantCredentialAppCodes,
  isPlatformFeeType,
  missingCredentialFields,
  isCompleteTenantCredentials,
  isLegacyPlaintextCredentialBlob,
  listUnenforcedApplications,
  DEFAULT_TENANT_CREDENTIAL_APP_CODES,
} from '../src/lib/constants.ts'

const COMPLETE = {
  apiKey: 'tenant-api-key',
  accountNo: '2500012345',
  webhookSecret: 'tenant-webhook-secret',
}

let savedEnv: string | undefined
beforeEach(() => {
  savedEnv = process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES
  else process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES = savedEnv
})

// ─────────────────────────────────────────────────────────────────────────────
// F-1 — which applications are under enforcement
// ─────────────────────────────────────────────────────────────────────────────

test('the default enforced list is exactly ["sacco"]', () => {
  delete process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES
  assert.deepEqual(tenantCredentialAppCodes(), DEFAULT_TENANT_CREDENTIAL_APP_CODES)
  assert.deepEqual(DEFAULT_TENANT_CREDENTIAL_APP_CODES, ['sacco'])
})

test('the seeded sacco application is enforced, case-insensitively', () => {
  delete process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES
  assert.equal(appRequiresTenantCredentials('sacco'), true)
  assert.equal(appRequiresTenantCredentials('SACCO'), true)
  assert.equal(appRequiresTenantCredentials('  sacco  '), true)
})

/**
 * Pinned deliberately. This is the F-1 gap: matching is EXACT, so a second
 * SACCO application is NOT covered unless an operator adds it. The test exists
 * so nobody "fixes" this by accident in either direction without noticing.
 */
test('a differently-coded SACCO application is NOT enforced by default', () => {
  delete process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES
  assert.equal(appRequiresTenantCredentials('sacco2'), false)
  assert.equal(appRequiresTenantCredentials('sacco-uganda'), false)
  assert.equal(appRequiresTenantCredentials('mysacco'), false)
  assert.equal(appRequiresTenantCredentials('church'), false)
  assert.equal(appRequiresTenantCredentials('school'), false)
})

test('the enforced list can be extended via env without a deploy', () => {
  process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES = 'sacco, church ,sacco2'
  assert.deepEqual(tenantCredentialAppCodes(), ['sacco', 'church', 'sacco2'])
  assert.equal(appRequiresTenantCredentials('church'), true)
  assert.equal(appRequiresTenantCredentials('SACCO2'), true)
  assert.equal(appRequiresTenantCredentials('school'), false)
})

test('a blank or whitespace-only env value falls back to the default', () => {
  process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES = '   '
  assert.deepEqual(tenantCredentialAppCodes(), DEFAULT_TENANT_CREDENTIAL_APP_CODES)
  process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES = ',,,'
  assert.deepEqual(tenantCredentialAppCodes(), DEFAULT_TENANT_CREDENTIAL_APP_CODES)
})

test('a null/undefined/empty application code is never enforced', () => {
  assert.equal(appRequiresTenantCredentials(null), false)
  assert.equal(appRequiresTenantCredentials(undefined), false)
  assert.equal(appRequiresTenantCredentials(''), false)
  assert.equal(appRequiresTenantCredentials('   '), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// F-2 — credential completeness is all-or-nothing
// ─────────────────────────────────────────────────────────────────────────────

test('a fully-populated credential row is complete', () => {
  assert.deepEqual(missingCredentialFields(COMPLETE), [])
  assert.equal(isCompleteTenantCredentials(COMPLETE), true)
})

test('an empty object is missing all three fields', () => {
  assert.deepEqual(missingCredentialFields({}), ['apiKey', 'accountNo', 'webhookSecret'])
  assert.equal(isCompleteTenantCredentials({}), false)
})

/**
 * THE regression. This row used to pass a presence-of-webhookSecret check and
 * then had the platform account number substituted by the provider constructor:
 * it authenticated as the tenant and paid into the platform account.
 */
test('a row with a secret but no account number is INCOMPLETE', () => {
  const partial = { apiKey: 'k', webhookSecret: 's' }
  assert.deepEqual(missingCredentialFields(partial), ['accountNo'])
  assert.equal(isCompleteTenantCredentials(partial), false)
})

test('a row with an account number but no API key is INCOMPLETE', () => {
  assert.deepEqual(missingCredentialFields({ accountNo: '2500012345', webhookSecret: 's' }), ['apiKey'])
})

test('a row with an API key but no webhook secret is INCOMPLETE', () => {
  assert.deepEqual(missingCredentialFields({ apiKey: 'k', accountNo: '2500012345' }), ['webhookSecret'])
})

test('blank and whitespace-only values count as missing', () => {
  assert.equal(isCompleteTenantCredentials({ apiKey: '', accountNo: '2500012345', webhookSecret: 's' }), false)
  assert.equal(isCompleteTenantCredentials({ apiKey: 'k', accountNo: '   ', webhookSecret: 's' }), false)
  assert.equal(isCompleteTenantCredentials({ apiKey: 'k', accountNo: '2500012345', webhookSecret: null }), false)
})

test('every accepted spelling of each field satisfies the check', () => {
  const spellings = [
    { apiKey: 'k', accountNo: 'a', webhookSecret: 's' },
    { api_key: 'k', account_number: 'a', webhook_secret: 's' },
    { apiKey: 'k', accountNumber: 'a', webhook_secret: 's' },
    { api_key: 'k', accountNo: 'a', webhookSecret: 's' },
  ]
  for (const spelling of spellings) {
    assert.equal(isCompleteTenantCredentials(spelling), true, JSON.stringify(spelling))
  }
})

test('a numeric account number is accepted', () => {
  assert.equal(isCompleteTenantCredentials({ apiKey: 'k', accountNo: 2500012345, webhookSecret: 's' }), true)
})

test('non-object input is treated as missing everything, never as complete', () => {
  for (const junk of [null, undefined, '', 'apiKey', 42, []]) {
    assert.equal(isCompleteTenantCredentials(junk), false, String(junk))
  }
})

test('legacy plaintext blobs are distinguishable from encrypted ones', () => {
  assert.equal(isLegacyPlaintextCredentialBlob(COMPLETE), true)
  assert.equal(isLegacyPlaintextCredentialBlob({ _encrypted: 'ab:cd:ef' }), false)
  assert.equal(isLegacyPlaintextCredentialBlob({}), false)
  assert.equal(isLegacyPlaintextCredentialBlob(null), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// Platform-fee exemption
// ─────────────────────────────────────────────────────────────────────────────

test('platform fee types are recognised case-insensitively', () => {
  for (const code of ['SMS', 'sms', ' Buy_SMS ', 'ACCOUNT_ACTIVATION', 'SUBSCRIPTION', 'PLATFORM_FEE']) {
    assert.equal(isPlatformFeeType(code), true, code)
  }
})

/** A SACCO's core money types must NOT be exempt — that is the whole point. */
test('tenant collection types are NOT platform fees', () => {
  for (const code of ['deposit', 'loan_repayment', 'tithe', 'offering', 'tuition', 'share_purchase']) {
    assert.equal(isPlatformFeeType(code), false, code)
  }
})

test('a null or empty payment type is not a platform fee', () => {
  assert.equal(isPlatformFeeType(null), false)
  assert.equal(isPlatformFeeType(undefined), false)
  assert.equal(isPlatformFeeType(''), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// Visibility — the gap should be seeable, not discovered by an accountant
// ─────────────────────────────────────────────────────────────────────────────

test('applications with tenants that are not enforced are listed', () => {
  delete process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES
  const apps = [
    { code: 'sacco', tenants: [{}, {}] },
    { code: 'church', tenants: [{}] },
    { code: 'school', tenants: [] },
    { code: 'marketing-site' },
  ]
  assert.deepEqual(listUnenforcedApplications(apps), ['church'])
})

test('the list works from a Prisma _count as well as an included relation', () => {
  delete process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES
  const apps = [
    { code: 'sacco', _count: { tenants: 4 } },
    { code: 'sacco2', _count: { tenants: 2 } },
    { code: 'docs', _count: { tenants: 0 } },
  ]
  assert.deepEqual(listUnenforcedApplications(apps), ['sacco2'])
})

test('extending the env list clears the warning', () => {
  process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES = 'sacco,church,school'
  const apps = [
    { code: 'sacco', tenants: [{}] },
    { code: 'church', tenants: [{}] },
    { code: 'school', tenants: [{}] },
  ]
  assert.deepEqual(listUnenforcedApplications(apps), [])
})
