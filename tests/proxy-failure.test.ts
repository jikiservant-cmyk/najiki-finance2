/**
 * Static-IP proxy CONNECT failures must never masquerade as LivePay rejections.
 *
 * Production incident this locks in: the proxy vendor answered every tunnel
 * with "HTTP/1.1 402 Payment Required" (account out of credit), the provider
 * reported it as a generic "LivePay network error", and /api/payments returned
 * 422 "Payment provider rejected collection" — pointing operators at SACCO
 * credentials that were never the problem. These tests pin the classification:
 * proxy/egress failures are infrastructure errors (502, actionable), genuine
 * LivePay refusals stay 422.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { loadTsModule } from './helpers/ts-load.ts'
import {
  classifyPaymentFailure,
  presentPaymentFailure,
} from '../src/lib/payment-errors.ts'

type LivePayModule = {
  LivePayProvider: any
  resolveLivePayProxy: (explicit?: string | null) => { url: string; source: string | null }
  resolveLivePayProxyUrl: (explicit?: string | null) => string
  LivePayProxyConnectError: any
}

const PROXY_ENV_KEYS = ['LIVEPAY_PROXY_URL', 'QUOTAGUARDSTATIC_URL', 'FIXIE_URL'] as const

function stashProxyEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const key of PROXY_ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  return saved
}

function restoreProxyEnv(saved: Record<string, string | undefined>): void {
  for (const key of PROXY_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  })
}

function closeServer(server: http.Server | net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function loadLivePay(): LivePayModule {
  return loadTsModule<LivePayModule>('src/lib/providers/livepay.ts')
}

const TENANT_CREDS = {
  apiKey: 'lp_live_key',
  accountNo: 'LP260099',
  webhookSecret: 'lpwhsec_0123456789abcdef',
}

test('proxy answering HTTP 402 on CONNECT fails the payment as infrastructure, LivePay never contacted', async () => {
  const savedEnv = stashProxyEnv()

  // Origin that must NEVER be reached: if the tunnel is refused, no request
  // may leak to LivePay (no PIN could fire).
  let originHits = 0
  const origin = http.createServer((_req, res) => {
    originHits++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, internal_reference: 'LP-SHOULD-NOT-EXIST' }))
  })
  const originPort = await listen(origin)

  // Proxy that behaves like an out-of-credit vendor: refuse every CONNECT
  // with 402 Payment Required (the exact production failure).
  let connectHits = 0
  const proxy = http.createServer()
  proxy.on('connect', (_req, socket) => {
    connectHits++
    socket.write('HTTP/1.1 402 Payment Required\r\nX-Vendor: out-of-credit\r\n\r\n')
    socket.destroy()
  })
  const proxyPort = await listen(proxy)

  process.env.LIVEPAY_PROXY_URL = `http://user:pass@127.0.0.1:${proxyPort}`

  try {
    const { LivePayProvider, resolveLivePayProxy } = loadLivePay()
    assert.deepEqual(resolveLivePayProxy(), {
      url: process.env.LIVEPAY_PROXY_URL,
      source: 'LIVEPAY_PROXY_URL',
    })

    const provider = new LivePayProvider({
      ...TENANT_CREDS,
      baseUrl: `http://127.0.0.1:${originPort}`,
    })

    const init = await provider.initiatePayment({
      amount: 5000,
      currency: 'UGX',
      phoneNumber: '0772123456',
      reference: 'SACCO-DEP-PROXY-402',
    })

    assert.equal(init.success, false)
    assert.equal(init.status, 'failed')
    assert.ok(connectHits >= 1, 'proxy must have received the CONNECT attempt')

    const reason: string = init.failureReason
    assert.ok(reason.startsWith('Static IP proxy error via LIVEPAY_PROXY_URL'), reason)
    assert.match(reason, /402 Payment Required/)
    assert.match(reason, /out of credits or billing is past due/)
    assert.match(reason, /LIVEPAY_PROXY_URL/)
    assert.match(reason, /LivePay was never contacted, so no PIN was sent/)
    // The old wording blamed LivePay for the proxy's own failure:
    assert.doesNotMatch(reason, /^LivePay network error/)

    // LivePay origin never saw a byte — no PIN could have been triggered.
    assert.equal(originHits, 0)

    // And the API layer classifies it as retryable infrastructure, not a 422.
    assert.equal(classifyPaymentFailure(reason), 'proxy_unavailable')
    const presented = presentPaymentFailure(reason)
    assert.equal(presented.httpStatus, 502)
    assert.equal(presented.code, 'PAYMENT_STATIC_PROXY_UNAVAILABLE')
    assert.equal(presented.retryable, true)
    assert.match(presented.error, /LivePay was never contacted/)
    assert.doesNotMatch(presented.error, /^Payment provider rejected collection/)
    assert.match(presented.hint, /NOT a LivePay rejection and NOT SACCO credentials/)
  } finally {
    restoreProxyEnv(savedEnv)
    await closeServer(proxy)
    await closeServer(origin)
  }
})

test('proxy answering HTTP 407 on CONNECT points the operator at the proxy credentials', async () => {
  const savedEnv = stashProxyEnv()

  const proxy = http.createServer()
  proxy.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    socket.destroy()
  })
  const proxyPort = await listen(proxy)

  process.env.LIVEPAY_PROXY_URL = `http://wronguser:wrongpass@127.0.0.1:${proxyPort}`

  try {
    const { LivePayProvider } = loadLivePay()
    const provider = new LivePayProvider({
      ...TENANT_CREDS,
      baseUrl: 'http://127.0.0.1:9', // unreachable on purpose — must never be tried
    })

    const init = await provider.initiatePayment({
      amount: 1000,
      currency: 'UGX',
      phoneNumber: '0772123456',
      reference: 'SACCO-DEP-PROXY-407',
    })

    assert.equal(init.success, false)
    assert.equal(init.status, 'failed')
    assert.match(init.failureReason, /Static IP proxy error/)
    assert.match(init.failureReason, /407 Proxy Authentication Required/)
    assert.match(init.failureReason, /fix the username:password embedded in LIVEPAY_PROXY_URL/)
    assert.equal(classifyPaymentFailure(init.failureReason), 'proxy_unavailable')
  } finally {
    restoreProxyEnv(savedEnv)
    await closeServer(proxy)
  }
})

test('unreachable or malformed proxy URL is a proxy failure too (connectStatus 0)', async () => {
  const savedEnv = stashProxyEnv()

  // Grab a port, then close the listener so nothing answers on it.
  const probe = http.createServer()
  const deadPort = await listen(probe)
  await closeServer(probe)

  try {
    const { LivePayProvider } = loadLivePay()

    // 1. Connection refused → wrapped as a proxy failure, not "LivePay network error".
    process.env.LIVEPAY_PROXY_URL = `http://user:pass@127.0.0.1:${deadPort}`
    const refused = new LivePayProvider({
      ...TENANT_CREDS,
      baseUrl: 'http://127.0.0.1:9',
    })
    const init = await refused.initiatePayment({
      amount: 1000,
      currency: 'UGX',
      phoneNumber: '0772123456',
      reference: 'SACCO-DEP-PROXY-REFUSED',
    })
    assert.equal(init.success, false)
    assert.equal(init.status, 'failed')
    assert.match(init.failureReason, /Static IP proxy error via LIVEPAY_PROXY_URL/)
    assert.match(init.failureReason, /connection to proxy failed/)
    assert.equal(classifyPaymentFailure(init.failureReason), 'proxy_unavailable')

    // 2. Malformed proxy URL → operator config error, still not LivePay's fault.
    process.env.LIVEPAY_PROXY_URL = '::::not-a-url::::'
    const malformed = new LivePayProvider({
      ...TENANT_CREDS,
      baseUrl: 'http://127.0.0.1:9',
    })
    const badInit = await malformed.initiatePayment({
      amount: 1000,
      currency: 'UGX',
      phoneNumber: '0772123456',
      reference: 'SACCO-DEP-PROXY-BADURL',
    })
    assert.equal(badInit.success, false)
    assert.match(badInit.failureReason, /invalid proxy URL in LIVEPAY_PROXY_URL/)
    assert.equal(classifyPaymentFailure(badInit.failureReason), 'proxy_unavailable')
  } finally {
    restoreProxyEnv(savedEnv)
  }
})

test('resolveLivePayProxy reports which env var supplied the URL, in precedence order', async () => {
  const savedEnv = stashProxyEnv()
  try {
    const { resolveLivePayProxy, resolveLivePayProxyUrl } = loadLivePay()

    assert.deepEqual(resolveLivePayProxy(), { url: '', source: null })
    assert.equal(resolveLivePayProxyUrl(), '')

    process.env.FIXIE_URL = 'http://fixie:secret@fixie.example:3128'
    assert.deepEqual(resolveLivePayProxy(), {
      url: 'http://fixie:secret@fixie.example:3128',
      source: 'FIXIE_URL',
    })

    process.env.QUOTAGUARDSTATIC_URL = 'http://qg:secret@qg.example:3129'
    assert.deepEqual(resolveLivePayProxy(), {
      url: 'http://qg:secret@qg.example:3129',
      source: 'QUOTAGUARDSTATIC_URL',
    })

    process.env.LIVEPAY_PROXY_URL = 'http://ws:secret@ws.example:8080'
    assert.deepEqual(resolveLivePayProxy(), {
      url: 'http://ws:secret@ws.example:8080',
      source: 'LIVEPAY_PROXY_URL',
    })

    // Explicit argument wins over every env var.
    assert.deepEqual(resolveLivePayProxy('http://explicit:3128'), {
      url: 'http://explicit:3128',
      source: 'explicit',
    })
  } finally {
    restoreProxyEnv(savedEnv)
  }
})

test('classifyPaymentFailure separates provider rejections (422) from infrastructure failures (502)', () => {
  // Current proxy failure text.
  assert.equal(
    classifyPaymentFailure(
      'Static IP proxy error via LIVEPAY_PROXY_URL → proxy.example:3129: CONNECT failed (HTTP/1.1 402 Payment Required). The proxy vendor refused service with HTTP 402 Payment Required — its account is out of credits or billing is past due. Top up the proxy account, or point LIVEPAY_PROXY_URL at a static-IP proxy with balance. LivePay was never contacted, so no PIN was sent.'
    ),
    'proxy_unavailable'
  )
  // Legacy in-flight rows written by the old error path.
  assert.equal(
    classifyPaymentFailure(
      'LivePay network error: Static IP proxy CONNECT failed (HTTP/1.1 402 Payment Required)'
    ),
    'proxy_unavailable'
  )
  // Genuine egress-to-LivePay failure.
  assert.equal(
    classifyPaymentFailure('LivePay network error: connect ECONNREFUSED 104.20.1.1:443'),
    'provider_unreachable'
  )
  // Genuine LivePay rejection.
  assert.equal(
    classifyPaymentFailure('Account number does not match API key owner'),
    'provider_rejected'
  )
  assert.equal(classifyPaymentFailure(null), 'provider_rejected')
  assert.equal(classifyPaymentFailure(undefined), 'provider_rejected')
  assert.equal(classifyPaymentFailure(''), 'provider_rejected')

  // Presentation contract partners rely on:
  const rejected = presentPaymentFailure('Reference already used')
  assert.equal(rejected.httpStatus, 422)
  assert.equal(rejected.code, 'PAYMENT_PROVIDER_REJECTED')
  assert.equal(rejected.retryable, false)
  assert.equal(rejected.error, 'Payment provider rejected collection: Reference already used')

  const nothing = presentPaymentFailure(null)
  assert.equal(nothing.httpStatus, 422)
  assert.equal(nothing.error, 'Payment provider rejected collection request.')

  const unreachable = presentPaymentFailure('LivePay network error: fetch failed')
  assert.equal(unreachable.httpStatus, 502)
  assert.equal(unreachable.code, 'PAYMENT_PROVIDER_UNREACHABLE')
  assert.equal(unreachable.retryable, true)
  assert.doesNotMatch(unreachable.error, /^Payment provider rejected collection/)
})
