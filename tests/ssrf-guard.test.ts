/**
 * The SSRF guard on outbound webhook delivery.
 *
 * `validateSafeUrl()` is the only control between the outbound notification path
 * and internal infrastructure. Two pen-test findings are pinned here:
 *
 *   PT-00  `URL.hostname` keeps the square brackets for an IPv6 host, so
 *          `net.isIP('[::ffff:127.0.0.1]')` was 0 and the literal skipped the IP
 *          check. The DNS branch then threw, the catch swallowed it, and fetch()
 *          connected anyway — demonstrated end-to-end against a live loopback
 *          listener. Brackets are now stripped and resolution failures fail
 *          closed.
 *
 *   PT-01  NAT64 / 6to4 / Teredo embed an arbitrary IPv4 address, so
 *          `http://[64:ff9b::a9fe:a9fe]/` named the cloud metadata endpoint
 *          while passing the blocklist.
 *
 * Node's built-in runner, no database, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isPrivateOrInternalIp, isPlaceholderUrl } from '../src/lib/safe-fetch.ts'

test('loopback and private IPv4 ranges are blocked', () => {
  for (const ip of ['127.0.0.1', '127.5.5.5', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '0.0.0.0']) {
    assert.equal(isPrivateOrInternalIp(ip), true, ip)
  }
})

test('cloud metadata and carrier-grade NAT are blocked', () => {
  for (const ip of ['169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255']) {
    assert.equal(isPrivateOrInternalIp(ip), true, ip)
  }
})

test('public IPv4 is allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.1', '172.32.0.1']) {
    assert.equal(isPrivateOrInternalIp(ip), false, ip)
  }
})

test('IPv6 loopback, ULA and link-local are blocked', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'feb0::1']) {
    assert.equal(isPrivateOrInternalIp(ip), true, ip)
  }
})

/** PT-00: the IPv4-mapped form, with and without the dotted-quad suffix. */
test('IPv4-mapped IPv6 resolves to the embedded IPv4 verdict', () => {
  assert.equal(isPrivateOrInternalIp('::ffff:127.0.0.1'), true)
  assert.equal(isPrivateOrInternalIp('::ffff:169.254.169.254'), true)
  assert.equal(isPrivateOrInternalIp('::ffff:10.0.0.1'), true)
  assert.equal(isPrivateOrInternalIp('::ffff:8.8.8.8'), false)
  assert.equal(isPrivateOrInternalIp('::ffff:0:a9fe:a9fe'), true)
})

/** PT-01: transition mechanisms that embed an arbitrary IPv4 address. */
test('NAT64, 6to4 and Teredo are blocked', () => {
  for (const ip of [
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::',
    '2001:0:1:2::3',
    '2001:0000:4136:e378:89c7:a9fe:a9fe:1',
    '2001::1',
  ]) {
    assert.equal(isPrivateOrInternalIp(ip), true, ip)
  }
})

/**
 * The other half of PT-01: blocking those prefixes must not break ordinary
 * public IPv6, or the guard becomes a denial-of-service on real endpoints.
 */
test('legitimate public IPv6 is still allowed', () => {
  for (const ip of [
    '2606:4700:4700::1111',
    '2001:db8::1',
    '2a00:1450:4001:81a::200e',
    '2620:0:2d0:200::7',
  ]) {
    assert.equal(isPrivateOrInternalIp(ip), false, ip)
  }
})

test('malformed addresses are treated as unsafe', () => {
  for (const junk of ['not-an-ip', '999.1.1.1', '1.2.3', '']) {
    assert.equal(isPrivateOrInternalIp(junk), false, `isPrivateOrInternalIp(${junk}) is a range test, not a validity test`)
  }
})

test('placeholder and template domains are recognised', () => {
  assert.equal(isPlaceholderUrl('https://example.com/x'), true)
  assert.equal(isPlaceholderUrl('https://a.example.com/x'), true)
  assert.equal(isPlaceholderUrl('https://yourdomain.com/x'), true)
  assert.equal(isPlaceholderUrl('https://partner.co.ug/x'), false)
  assert.equal(isPlaceholderUrl(''), true)
  assert.equal(isPlaceholderUrl('not a url'), true)
})
