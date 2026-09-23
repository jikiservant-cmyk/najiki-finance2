/**
 * Partner API key generation and verification.
 *
 * Keys used to live in `applications.api_key` in cleartext, so anyone who could
 * read a row — a database dump, a backup, a misconfigured Supabase anon key —
 * held a working credential for every partner. Verification is now done against
 * a SHA-256 hash and the plaintext is shown exactly once, at creation or
 * rotation.
 *
 * WHY NO SALT OR PEPPER
 * ---------------------
 * Salting defeats brute force over a *guessable* keyspace — passwords, short
 * PINs, anything a human chose. These keys are 32 bytes from a CSPRNG, so there
 * is nothing to guess and no rainbow table can exist. Adding a pepper would
 * only introduce a secret that, if rotated, silently invalidates every stored
 * hash; the namespace prefix below is enough to keep the digest from being
 * confused with a hash of the same value used elsewhere.
 *
 * This is the same approach as the payment processors whose API this mirrors.
 *
 * Zero imports beyond Node's `crypto`, so the test suite can reach it (see the
 * note in `ledger-core.ts` about ESM specifier resolution).
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto'

/** Every key this service issues starts with this, so leaks are greppable. */
export const API_KEY_PREFIX = 'njk'

/** 32 bytes of CSPRNG output — 256 bits, encoded base64url (43 chars). */
export const API_KEY_BYTES = 32

/** Keeps the digest distinct from a SHA-256 of the same string anywhere else. */
const HASH_NAMESPACE = 'najiki-finance2:application-api-key:v1:'

export type ApiKeyEnvironment = 'live' | 'test'

/**
 * Mint a new API key.
 *
 *   generateApiKey('live') → 'njk_live_9f3c...'   (43 chars of base64url)
 *
 * The environment segment is cosmetic — it lets support tell a staging key from
 * a production one at a glance. It carries no authority of its own; the key is
 * only ever as valid as the row its hash matches.
 */
export function generateApiKey(environment?: ApiKeyEnvironment): string {
  const env =
    environment ?? (process.env.NODE_ENV === 'production' ? 'live' : 'test')
  return `${API_KEY_PREFIX}_${env}_${randomBytes(API_KEY_BYTES).toString('base64url')}`
}

/** SHA-256 hex of an API key. This is what gets stored. */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256')
    .update(HASH_NAMESPACE + String(apiKey ?? ''))
    .digest('hex')
}

/**
 * Compare a presented key against a stored hash in constant time.
 *
 * `timingSafeEqual` throws on length mismatch, so short-circuit first — but on
 * the *hash* length, which is fixed, not on the secret.
 */
export function verifyApiKey(
  apiKey: string | null | undefined,
  expectedHash: string | null | undefined
): boolean {
  if (!apiKey || !expectedHash) return false
  return constantTimeEqual(hashApiKey(apiKey), expectedHash)
}

/** Constant-time string comparison. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Last four characters of a key, for display in the dashboard. Enough to
 * identify which key is in use, not enough to use it.
 */
export function apiKeyHint(apiKey: string): string {
  const text = String(apiKey ?? '')
  return text.length <= 4 ? text : text.slice(-4)
}

/**
 * Shape check for a presented token, used to reject obvious junk before
 * touching the database.
 *
 * Deliberately permissive: keys issued before the current format are still
 * valid until rotated, so this rejects only what no key could ever be.
 */
export function looksLikeApiKey(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return text.length >= 16 && text.length <= 500 && !/\s/.test(text)
}
