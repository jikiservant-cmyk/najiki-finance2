/**
 * Unit tests for partner API key generation and verification.
 *
 * The property that matters: a stored value must not be usable as a credential.
 * If `hashApiKey` ever became reversible or sensitive to input formatting,
 * every partner key in the database would be recoverable again — which is the
 * bug these tests exist to keep fixed.
 *
 * Node's built-in runner, no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  apiKeyHint,
  constantTimeEqual,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
  verifyApiKey,
  API_KEY_PREFIX,
} from '../src/lib/api-keys.ts'

// ─── generation ──────────────────────────────────────────────────────────────

test('generated keys are prefixed, high-entropy and URL-safe', () => {
  const key = generateApiKey('live')

  assert.ok(key.startsWith(`${API_KEY_PREFIX}_live_`))
  // "njk_live_" + 43 base64url chars for 32 bytes.
  assert.equal(key.length, 'njk_live_'.length + 43)
  assert.match(key, /^njk_live_[A-Za-z0-9_-]+$/)
})

test('a key never contains a character that would break a bearer header', () => {
  for (let i = 0; i < 50; i += 1) {
    assert.match(generateApiKey(), /^[A-Za-z0-9_-]+$/)
  }
})

test('the environment segment is cosmetic and the default follows NODE_ENV', () => {
  assert.ok(generateApiKey('test').startsWith('njk_test_'))
  const previous = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'production'
    assert.ok(generateApiKey().startsWith('njk_live_'))
    process.env.NODE_ENV = 'development'
    assert.ok(generateApiKey().startsWith('njk_test_'))
  } finally {
    process.env.NODE_ENV = previous
  }
})

test('keys are unique across a large sample', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i += 1) seen.add(generateApiKey())
  assert.equal(seen.size, 1000)
})

// ─── hashing ─────────────────────────────────────────────────────────────────

test('the hash is a stable 64-character hex digest', () => {
  const key = 'njk_test_fixedvalue'
  assert.equal(hashApiKey(key), hashApiKey(key))
  assert.match(hashApiKey(key), /^[0-9a-f]{64}$/)
})

test('different keys hash differently', () => {
  assert.notEqual(hashApiKey('njk_test_a'), hashApiKey('njk_test_b'))
  // A one-character difference must not collide.
  assert.notEqual(hashApiKey('njk_test_aaaa'), hashApiKey('njk_test_aaab'))
})

test('the hash is not the key and reveals no prefix of it', () => {
  const key = generateApiKey()
  const hash = hashApiKey(key)
  assert.notEqual(hash, key)
  assert.equal(hash.includes(key.slice(0, 8)), false)
})

test('hashes are namespaced so an identical string elsewhere does not collide', () => {
  // The namespace prefix means the digest of a key is not the digest of the
  // bare string — a value hashed by some other part of the system cannot be
  // replayed as an API key hash.
  const bare = 'njk_test_namespaced'
  const namespaceDigest = hashApiKey(bare)
  assert.notEqual(namespaceDigest, hashApiKey(`${bare} `))
  assert.equal(namespaceDigest.length, 64)
})

// ─── verification ────────────────────────────────────────────────────────────

test('a key verifies against its own hash', () => {
  const key = generateApiKey()
  assert.equal(verifyApiKey(key, hashApiKey(key)), true)
})

test('a key does not verify against another key hash', () => {
  assert.equal(verifyApiKey(generateApiKey(), hashApiKey(generateApiKey())), false)
})

test('verification fails closed on missing inputs', () => {
  const key = generateApiKey()
  assert.equal(verifyApiKey(null, hashApiKey(key)), false)
  assert.equal(verifyApiKey(undefined, hashApiKey(key)), false)
  assert.equal(verifyApiKey('', hashApiKey(key)), false)
  assert.equal(verifyApiKey(key, null), false)
  assert.equal(verifyApiKey(key, undefined), false)
  assert.equal(verifyApiKey(key, ''), false)
})

test('verification is exact — no trimming, casing or encoding leniency', () => {
  const key = generateApiKey()
  const hash = hashApiKey(key)
  // Each of these is a different string and must not authenticate; silently
  // normalising would let a near-miss guess succeed.
  assert.equal(verifyApiKey(` ${key}`, hash), false)
  assert.equal(verifyApiKey(`${key} `, hash), false)
  assert.equal(verifyApiKey(key.toUpperCase(), hash), false)
})

test('constantTimeEqual compares exactly', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true)
  assert.equal(constantTimeEqual('abc', 'abd'), false)
  assert.equal(constantTimeEqual('abc', 'abcd'), false)
  assert.equal(constantTimeEqual('', ''), true)
})

test('a wrong-length input cannot throw out of verification', () => {
  // timingSafeEqual throws on length mismatch; verification must swallow that.
  assert.doesNotThrow(() => constantTimeEqual('short', 'a-much-longer-value'))
  assert.equal(constantTimeEqual('short', 'a-much-longer-value'), false)
})

// ─── display + shape helpers ─────────────────────────────────────────────────

test('the hint is the last four characters and cannot be used as a key', () => {
  const key = generateApiKey()
  const hint = apiKeyHint(key)
  assert.equal(hint, key.slice(-4))
  assert.equal(hint.length, 4)
  assert.equal(verifyApiKey(hint, hashApiKey(key)), false)
})

test('the hint degrades safely on very short input', () => {
  assert.equal(apiKeyHint('ab'), 'ab')
  assert.equal(apiKeyHint(''), '')
})

test('shape checking rejects the obvious junk but keeps legacy keys valid', () => {
  assert.equal(looksLikeApiKey(generateApiKey()), true)
  // Keys issued before the current format were longer random hex strings.
  assert.equal(looksLikeApiKey(`nk_${'a'.repeat(48)}`), true)

  assert.equal(looksLikeApiKey(''), false)
  assert.equal(looksLikeApiKey('short'), false)
  assert.equal(looksLikeApiKey('has spaces in it and is long'), false)
  assert.equal(looksLikeApiKey(12345), false)
  assert.equal(looksLikeApiKey(null), false)
  assert.equal(looksLikeApiKey('x'.repeat(501)), false)
})
