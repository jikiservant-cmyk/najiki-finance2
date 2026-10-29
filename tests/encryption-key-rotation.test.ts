/**
 * What replacing APP_ENCRYPTION_KEY does to data already at rest.
 *
 * This is the mechanism behind the dashboard warning "A signing secret is
 * stored but cannot be decrypted with APP_ENCRYPTION_KEY, so notifications
 * would be sent UNSIGNED" — and behind a much quieter failure on the payment
 * side, where `loadTenantProviderCredentials` swallows the same error and falls
 * back to the platform LivePay account.
 *
 * The property that matters: the ciphertext is *bound to the key*. AES-256-GCM
 * derives its authentication tag from the key, so a wrong key produces an
 * outright failure at `decipher.final()` — never a silent garbage plaintext.
 * That is what makes the failure detectable at all.
 *
 * Node's built-in runner; no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

// Import after the environment is guaranteed non-production: `getEncryptionKey`
// reads NODE_ENV at call time, and the production branch throws instead of
// falling back, which would mask the behaviour under test.
const originalNodeEnv = process.env.NODE_ENV
const originalKey = process.env.APP_ENCRYPTION_KEY
process.env.NODE_ENV = 'test'

const { decrypt, encrypt } = await import('../src/lib/encryption.ts')

test.after(() => {
  process.env.NODE_ENV = originalNodeEnv
  if (originalKey === undefined) delete process.env.APP_ENCRYPTION_KEY
  else process.env.APP_ENCRYPTION_KEY = originalKey
})

test('a blob encrypted under one key cannot be decrypted under another', () => {
  process.env.APP_ENCRYPTION_KEY = KEY_A
  const sealed = encrypt('lp_live_tenant_api_key')

  process.env.APP_ENCRYPTION_KEY = KEY_B
  assert.throws(() => decrypt(sealed), /Decryption failed/)
})

test('the same key round-trips, so a failure means the key changed and not a corrupt row', () => {
  process.env.APP_ENCRYPTION_KEY = KEY_A
  assert.equal(decrypt(encrypt('njk_whsec_example')), 'njk_whsec_example')
})

test('ciphertext carries no marker of which key sealed it', () => {
  // `<iv>:<tag>:<ciphertext>` — nothing identifying the key. So a deployment
  // cannot tell old blobs from new ones, and there is no "try the previous key"
  // recovery path built into the format.
  process.env.APP_ENCRYPTION_KEY = KEY_A
  const sealed = encrypt('x')
  assert.match(sealed, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/)
  assert.equal(sealed.split(':').length, 3)
})

test('a wrong-length or non-hex key throws in production rather than encrypting under a fallback', () => {
  // The reason a half-migrated deployment is loud at boot but silent at rest:
  // `env.ts` refuses to start, yet rows written before the boot check existed
  // stay unreadable. Verified here so the two failure modes are not conflated.
  process.env.NODE_ENV = 'production'
  process.env.APP_ENCRYPTION_KEY = 'not-a-64-char-hex-key'

  assert.throws(() => encrypt('x'), /APP_ENCRYPTION_KEY must be a 64-character hex string/)

  process.env.NODE_ENV = 'test'
  process.env.APP_ENCRYPTION_KEY = KEY_A
})
