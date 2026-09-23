/**
 * Client-IP derivation, and the callback authorisation built on it.
 *
 * Both existed in a form that read the FIRST entry of `x-forwarded-for`, which
 * is the one the caller supplies. That made per-IP rate limits rotatable at will
 * and let the Africa's Talking allow-list be satisfied by simply naming one of
 * AT's published addresses. These tests pin the direction the value must be read
 * from, and the rule that an allow-list cannot stand in for a secret.
 *
 * Node's built-in runner, no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  clientIpFromForwardedFor,
  resolveClientIp,
} from '../src/lib/client-ip.ts'

import { authorizeCallback, ipAllowed, secretMatches } from '../src/lib/callback-auth.ts'

// ─── x-forwarded-for parsing ─────────────────────────────────────────────────

test('an attacker-supplied first entry is not used as the client address', () => {
  // The header a caller can produce: their own value first, then whatever the
  // proxy appended. The spoofed entry must be ignored.
  assert.equal(clientIpFromForwardedFor('1.2.3.4, 203.0.113.9'), '203.0.113.9')
  assert.notEqual(clientIpFromForwardedFor('1.2.3.4, 203.0.113.9'), '1.2.3.4')
})

test('a single entry is used as-is', () => {
  // No proxy appended anything, so the only entry is what we have.
  assert.equal(clientIpFromForwardedFor('203.0.113.9'), '203.0.113.9')
})

test('extra trusted hops walk further left, for stacked infrastructure', () => {
  const chain = '1.2.3.4, 203.0.113.9, 10.0.0.1'
  // 1 hop  → the entry our own proxy appended (10.0.0.1 is our proxy's peer list end)
  assert.equal(clientIpFromForwardedFor(chain, 1), '10.0.0.1')
  // 2 hops → the proxy before it saw the real client
  assert.equal(clientIpFromForwardedFor(chain, 2), '203.0.113.9')
  // 3 hops → reaches the caller-supplied entry, which is why raising this
  // beyond the number of proxies you actually run is unsafe
  assert.equal(clientIpFromForwardedFor(chain, 3), '1.2.3.4')
})

test('the hop count is clamped so a short list cannot read out of bounds', () => {
  assert.equal(clientIpFromForwardedFor('203.0.113.9', 5), '203.0.113.9')
  assert.equal(clientIpFromForwardedFor('203.0.113.9, 10.0.0.1', 99), '203.0.113.9')
})

test('junk and empty values never become a usable identity', () => {
  assert.equal(clientIpFromForwardedFor(''), '')
  assert.equal(clientIpFromForwardedFor(null), '')
  assert.equal(clientIpFromForwardedFor(undefined), '')
  assert.equal(clientIpFromForwardedFor(', ,'), '')
  // Not 'unknown' — a placeholder would be treated as a real identity by callers.
  assert.notEqual(clientIpFromForwardedFor(''), 'unknown')
})

test('entries too long to be an address are discarded', () => {
  const huge = 'a'.repeat(200)
  assert.equal(clientIpFromForwardedFor(huge), '')
  assert.equal(clientIpFromForwardedFor(`${huge}, 203.0.113.9`), '203.0.113.9')
})

test('a malformed hop setting falls back to the default rather than to 0', () => {
  assert.equal(clientIpFromForwardedFor('1.2.3.4, 203.0.113.9', 'not-a-number'), '203.0.113.9')
  assert.equal(clientIpFromForwardedFor('1.2.3.4, 203.0.113.9', 0), '203.0.113.9')
  assert.equal(clientIpFromForwardedFor('1.2.3.4, 203.0.113.9', -3), '203.0.113.9')
  assert.equal(DEFAULT_TRUSTED_PROXY_HOPS, 1)
})

test('x-real-ip is ignored unless explicitly trusted', () => {
  // Anything that can set a header can set this one, so it is off by default.
  assert.equal(resolveClientIp({ forwardedFor: '', realIp: '203.0.113.9' }), '')
  assert.equal(resolveClientIp({ realIp: '203.0.113.9', trustRealIp: 'false' }), '')

  assert.equal(resolveClientIp({ realIp: '203.0.113.9', trustRealIp: 'true' }), '203.0.113.9')
  assert.equal(resolveClientIp({ realIp: '203.0.113.9', trustRealIp: true }), '203.0.113.9')
})

test('forwarded-for wins over x-real-ip when both are present', () => {
  assert.equal(
    resolveClientIp({
      forwardedFor: '1.2.3.4, 203.0.113.9',
      realIp: '9.9.9.9',
      trustRealIp: true,
    }),
    '203.0.113.9'
  )
})

// ─── callback authorisation ──────────────────────────────────────────────────

const SECRET = 'a-configured-callback-secret'
const AT_IP = '18.133.205.228'

test('a matching secret authorises', () => {
  const viaQuery = authorizeCallback({
    configuredSecret: SECRET,
    requestUrl: `https://example.com/api/webhooks/africastalking?key=${SECRET}`,
  })
  assert.deepEqual(viaQuery, { ok: true, via: 'query' })

  const viaHeader = authorizeCallback({
    configuredSecret: SECRET,
    headerSecret: SECRET,
  })
  assert.deepEqual(viaHeader, { ok: true, via: 'header' })
})

test('the allow-list cannot substitute for a configured secret', () => {
  // The bypass: present no secret, claim an allow-listed address. The header is
  // caller-populated, so this must not authorise.
  const result = authorizeCallback({
    configuredSecret: SECRET,
    configuredIps: AT_IP,
    clientIp: AT_IP,
    requestUrl: 'https://example.com/api/webhooks/africastalking',
  })
  assert.equal(result.ok, false)
  assert.equal((result as { reason: string }).reason, 'mismatch')
})

test('a wrong secret is rejected even when the IP is allow-listed', () => {
  const result = authorizeCallback({
    configuredSecret: SECRET,
    configuredIps: AT_IP,
    clientIp: AT_IP,
    requestUrl: 'https://example.com/api/webhooks/africastalking?key=wrong',
  })
  assert.equal(result.ok, false)
})

test('the allow-list still works on its own when no secret is configured', () => {
  // Unreachable in production (env.ts requires the secret) but supported for
  // operators who have not set a URL secret yet.
  const result = authorizeCallback({ configuredIps: AT_IP, clientIp: AT_IP })
  assert.deepEqual(result, { ok: true, via: 'ip' })
})

test('with no method configured the result is distinguishable from a mismatch', () => {
  assert.deepEqual(authorizeCallback({}), { ok: false, reason: 'no-method-configured' })
  assert.deepEqual(authorizeCallback({ clientIp: AT_IP }), {
    ok: false,
    reason: 'no-method-configured',
  })
  assert.deepEqual(authorizeCallback({ configuredSecret: SECRET, clientIp: AT_IP }), {
    ok: false,
    reason: 'mismatch',
  })
})

test('requiring both is opt-in and reported distinctly when the IP is wrong', () => {
  // Correct secret, IP not in the list → denied only because the operator asked
  // for the stricter mode.
  const strict = authorizeCallback({
    configuredSecret: SECRET,
    configuredIps: AT_IP,
    clientIp: '203.0.113.9',
    requestUrl: `https://example.com/x?key=${SECRET}`,
    requireAllowedIp: true,
  })
  assert.deepEqual(strict, { ok: false, reason: 'ip-not-allowed' })

  const satisfied = authorizeCallback({
    configuredSecret: SECRET,
    configuredIps: AT_IP,
    clientIp: AT_IP,
    requestUrl: `https://example.com/x?key=${SECRET}`,
    requireAllowedIp: true,
  })
  assert.deepEqual(satisfied, { ok: true, via: 'query' })

  // Not requesting it leaves the secret sufficient — the default must not
  // change behaviour for existing deployments whose IP derivation may differ.
  const lenient = authorizeCallback({
    configuredSecret: SECRET,
    configuredIps: AT_IP,
    clientIp: '203.0.113.9',
    requestUrl: `https://example.com/x?key=${SECRET}`,
  })
  assert.deepEqual(lenient, { ok: true, via: 'query' })
})

test('an empty configured secret never matches an empty presented one', () => {
  // Otherwise "no secret configured" would authorise everything.
  assert.equal(secretMatches('', ['']), false)
  assert.equal(secretMatches('', [null]), false)
  assert.equal(secretMatches(SECRET, ['']), false)
  assert.equal(secretMatches(SECRET, [null, undefined]), false)
})

test('the allow-list is an exact match and never matches when empty', () => {
  assert.equal(ipAllowed('', AT_IP), false)
  assert.equal(ipAllowed(AT_IP, AT_IP), true)
  assert.equal(ipAllowed(`${AT_IP}, 3.8.44.1`, '3.8.44.1'), true)
  assert.equal(ipAllowed(AT_IP, '18.133.205.229'), false)
  // A prefix must not match: indexOf/contains checks would allow this.
  assert.equal(ipAllowed(AT_IP, '18.133.205.22'), false)
  assert.equal(ipAllowed(AT_IP, '18.133.205.2280'), false)
})
