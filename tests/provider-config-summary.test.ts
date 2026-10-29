/**
 * Provider-configuration summaries — the "what may reach a browser" boundary.
 *
 * `TenantProviderConfig.configJson` holds a tenant's LivePay API key and webhook
 * secret. The setup API used to return that column verbatim, and four read paths
 * still carry an `_encrypted` branch so that legacy plaintext rows keep working —
 * meaning upgraded deployments have rows whose `configJson` is
 * `{ apiKey, webhookSecret }` in the clear. Those were being shipped to the
 * dashboard.
 *
 * So these tests are mostly negative: they assert that credentials do NOT appear
 * in the output, in either storage format.
 *
 * Node's built-in runner, no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SECRET_CONFIG_FIELDS,
  shouldPreserveStoredSecret,
  summarizeProviderConfig,
} from '../src/lib/provider-config-summary.ts'

const PLAINTEXT_LEGACY_ROW = {
  apiKey: 'lp_live_supersecretkey123',
  accountNo: '1234567890',
  webhookSecret: 'whsec_supersecret456',
  baseUrl: 'https://livepay.me',
}

test('a legacy plaintext row never exposes its credential values', () => {
  const summary = summarizeProviderConfig(PLAINTEXT_LEGACY_ROW)
  const serialized = JSON.stringify(summary)

  assert.equal(serialized.includes('lp_live_supersecretkey123'), false, 'apiKey leaked')
  assert.equal(serialized.includes('whsec_supersecret456'), false, 'webhookSecret leaked')
})

test('every secret field name is redacted, not just the two we know about', () => {
  for (const field of SECRET_CONFIG_FIELDS) {
    const summary = summarizeProviderConfig({ [field]: 'a-secret-value-here' })
    assert.equal(
      JSON.stringify(summary).includes('a-secret-value-here'),
      false,
      `field ${field} leaked through the summary`
    )
  }
})

test('an unknown field is dropped rather than passed through', () => {
  // Deny-by-default: a field added to the credential blob later must fail closed.
  const summary = summarizeProviderConfig({
    apiKey: 'k',
    someFutureCredential: 'do-not-echo-this',
  })
  assert.equal(JSON.stringify(summary).includes('do-not-echo-this'), false)
})

test('the encrypted form is reported as configured without echoing the blob', () => {
  const summary = summarizeProviderConfig({ _encrypted: 'deadbeef:cafe:0011' })
  assert.equal(summary.encrypted, true)
  assert.equal(summary.hasApiKey, true)
  assert.equal(JSON.stringify(summary).includes('deadbeef'), false)
})

test('an unconfigured row is reported as unconfigured', () => {
  const empty = summarizeProviderConfig(null)
  assert.equal(empty.hasApiKey, false)
  assert.equal(empty.hasWebhookSecret, false)
  assert.equal(empty.accountNo, '')
  assert.equal(empty.baseUrl, '')
  assert.equal(empty.encrypted, false)

  assert.equal(summarizeProviderConfig({}).hasApiKey, false)
  assert.equal(summarizeProviderConfig({ apiKey: '   ' }).hasApiKey, false)
  assert.equal(summarizeProviderConfig(undefined).hasApiKey, false)
})

test('non-secret fields are still available so the dashboard can render them', () => {
  const summary = summarizeProviderConfig(PLAINTEXT_LEGACY_ROW)
  assert.equal(summary.accountNo, '1234567890')
  assert.equal(summary.baseUrl, 'https://livepay.me')

  // Legacy snake_case spellings must still resolve.
  const snake = summarizeProviderConfig({
    account_number: '999',
    base_url: 'https://example.org',
  })
  assert.equal(snake.accountNo, '999')
  assert.equal(snake.baseUrl, 'https://example.org')
})

test('a non-object configJson does not throw', () => {
  // The column is Json, so it can legitimately hold a string or array.
  assert.equal(summarizeProviderConfig('a string').hasApiKey, false)
  assert.equal(summarizeProviderConfig([1, 2, 3]).hasApiKey, false)
  assert.equal(summarizeProviderConfig(42).hasApiKey, false)
})

test('a blank submitted secret is treated as "keep the stored one"', () => {
  // The form is never given the secret, so blank must not mean "erase".
  assert.equal(shouldPreserveStoredSecret(''), true)
  assert.equal(shouldPreserveStoredSecret('   '), true)
  assert.equal(shouldPreserveStoredSecret(undefined), true)
  assert.equal(shouldPreserveStoredSecret(null), true)

  // A real value replaces it.
  assert.equal(shouldPreserveStoredSecret('new-key'), false)
})

/**
 * `undecryptable` — the flag that separates "configured" from "readable".
 *
 * `APP_ENCRYPTION_KEY` is not a namespace key: replacing it makes every blob
 * written under the old key permanently unreadable (AES-256-GCM authenticates
 * with the key, so decryption fails rather than returning garbage). The setup
 * route used to report such a row with the plain fallback summary, which is
 * byte-identical in shape to a healthy one — `hasApiKey` is true because the
 * `_encrypted` blob exists, and `accountNo` is empty because the value is
 * inside the blob. An operator could not tell the two apart.
 *
 * These tests pin the shapes so the distinction cannot be lost again.
 */
const ENCRYPTED_BLOB_ONLY = { _encrypted: 'aabbcc:ddeeff:00112233' }

test('an encrypted blob reports hasApiKey but no readable account number', () => {
  const summary = summarizeProviderConfig(ENCRYPTED_BLOB_ONLY)

  // Indistinguishable from a healthy row on these two fields alone.
  assert.equal(summary.hasApiKey, true)
  assert.equal(summary.encrypted, true)
  assert.equal(summary.accountNo, '')

  // Nothing marks it as broken, which is exactly why the route must say so.
  assert.equal(summary.undecryptable, undefined)
})

test('the undecryptable flag survives JSON serialisation to the dashboard', () => {
  // The route adds the flag after the spread; this pins that it is a plain
  // own-property on the object that reaches the browser.
  const reported = { ...summarizeProviderConfig(ENCRYPTED_BLOB_ONLY), encrypted: true, undecryptable: true }
  const roundTripped = JSON.parse(JSON.stringify(reported))

  assert.equal(roundTripped.undecryptable, true)
  assert.equal(roundTripped.hasApiKey, true)
  assert.equal(roundTripped.accountNo, '')
  // Still no credential material, in either direction.
  assert.equal(JSON.stringify(roundTripped).includes('aabbcc'), false)
})

test('a healthy plaintext row is never marked undecryptable', () => {
  const summary = summarizeProviderConfig(PLAINTEXT_LEGACY_ROW)
  assert.equal(summary.undecryptable, undefined)
  assert.equal(summary.accountNo, '1234567890')
})
