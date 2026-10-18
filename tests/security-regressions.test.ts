import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import ts from 'typescript'
import { isConfirmedTerminalStatus, parseTenantProviderCredentials } from '../src/lib/payment-security.ts'
import { isAllowedSuperAdminEmail } from '../src/lib/admin-allowlist.ts'
import { allowInsecureDevAuth } from '../src/lib/dev-auth.ts'
import { readTextWithLimit, PayloadTooLargeError } from '../src/lib/request-body.ts'

// Load the real adapter with only its phone-formatting import stubbed. No HTTP
// server, provider credentials, database, or network access are required.
function livePayClass() {
  const file = path.resolve('src/lib/providers/livepay.ts')
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const loaded = new Module(file)
  loaded.filename = file
  loaded.paths = Module._nodeModulePaths(path.dirname(file))
  const originalRequire = loaded.require.bind(loaded)
  loaded.require = (name: string) => name === '@/lib/phone'
    ? { normalizePhone: (phone: string) => phone }
    : originalRequire(name)
  loaded._compile(code, file)
  return loaded.exports.LivePayProvider
}

const completeTenant = {
  apiKey: 'tenant-api', accountNo: 'tenant-account',
  webhookSecret: 'tenant-webhook-secret-123',
}

test('only an explicitly successful provider response can settle a payment', () => {
  assert.equal(isConfirmedTerminalStatus({ success: false, status: 'failed' }), false)
  assert.equal(isConfirmedTerminalStatus({ success: false, status: 'success' }), false)
  assert.equal(isConfirmedTerminalStatus({ success: true, status: 'processing' }), false)
  assert.equal(isConfirmedTerminalStatus({ success: true, status: 'failed' }), true)
  assert.equal(isConfirmedTerminalStatus({ success: true, status: 'success' }), true)
  const expected = { amount: 100, currency: 'UGX', providerPaymentId: 'provider-1' }
  assert.equal(isConfirmedTerminalStatus({ success: true, status: 'success', amount: 99, currency: 'UGX' }, expected), false)
  assert.equal(isConfirmedTerminalStatus({ success: true, status: 'success', amount: 100, currency: 'USD' }, expected), false)
  assert.equal(isConfirmedTerminalStatus({ success: true, status: 'success', amount: 100, providerPaymentId: 'other' }, expected), false)
  assert.equal(isConfirmedTerminalStatus({ success: true, status: 'success', amount: 100, currency: 'UGX' }, expected), true)
})

test('tenant credentials are complete or rejected, including legacy field names', () => {
  assert.equal(parseTenantProviderCredentials({ _encrypted: 'ciphertext' }), null)
  assert.equal(parseTenantProviderCredentials({ apiKey: 'key' }), null)
  assert.equal(parseTenantProviderCredentials({ ...completeTenant, webhookSecret: '' }), null)
  assert.equal(parseTenantProviderCredentials({ ...completeTenant, accountNo: ' ' }), null)
  assert.deepEqual(parseTenantProviderCredentials(completeTenant), {
    ...completeTenant, baseUrl: 'https://livepay.me',
  })
  assert.deepEqual(parseTenantProviderCredentials({
    api_key: 'legacy-key', account_number: 'legacy-account', webhook_secret: 'legacy-secret-12345',
  }), {
    apiKey: 'legacy-key', accountNo: 'legacy-account',
    webhookSecret: 'legacy-secret-12345', baseUrl: 'https://livepay.me',
  })
})

test('LivePay refuses incomplete tenant credentials rather than mixing platform fields', () => {
  const LivePayProvider = livePayClass()
  assert.throws(() => new LivePayProvider({ apiKey: 'tenant-key', accountNo: 'tenant-account' }),
    /Incomplete tenant LivePay credentials/)
  const client = new LivePayProvider(completeTenant)
  assert.equal(client.apiKey, 'tenant-api')
  assert.equal(client.webhookSecret, completeTenant.webhookSecret)
})

test('a provider 503 cannot produce a terminal failure', async () => {
  const LivePayProvider = livePayClass()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false, message: 'temporary outage' }), {
    status: 503, headers: { 'content-type': 'application/json' },
  })
  try {
    const provider = new LivePayProvider(completeTenant)
    const result = await provider.checkPaymentStatus('FAKE-REFERENCE')
    assert.equal(result.success, false)
    assert.equal(result.status, 'pending')
    assert.equal(isConfirmedTerminalStatus(result), false)
    const initiation = await provider.initiatePayment({
      reference: 'FAKE-REFERENCE', amount: 1, currency: 'UGX', phoneNumber: '256700000000',
    })
    assert.equal(initiation.status, 'processing')
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true, status: 'success', amount: 1, currency: 'UGX', internal_reference: 'provider-1',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const later = await provider.checkPaymentStatus('FAKE-REFERENCE', 'UGX', 'provider-1')
    assert.equal(isConfirmedTerminalStatus(later, {
      amount: 1, currency: 'UGX', providerPaymentId: 'provider-1',
    }), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('super-admin allowlist removal is enforced even if a stored role remains', () => {
  assert.equal(isAllowedSuperAdminEmail(' Former@Example.com ', 'new@example.com'), false)
  assert.equal(isAllowedSuperAdminEmail('FORMER@example.com', 'new@example.com, former@example.com'), true)
  assert.equal(isAllowedSuperAdminEmail('former@example.com', ''), false)
})

test('development auth bypass requires an explicit opt-in and cannot run in production', () => {
  assert.equal(allowInsecureDevAuth('development', undefined), false)
  assert.equal(allowInsecureDevAuth('development', 'true'), true)
  assert.equal(allowInsecureDevAuth('production', 'true'), false)
  assert.equal(allowInsecureDevAuth('test', 'true'), false)
})

test('a missing production rate limiter fails closed', async () => {
  const file = path.resolve('src/lib/rate-limit.ts')
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const loaded = new Module(file)
  loaded.filename = file
  loaded.paths = Module._nodeModulePaths(path.dirname(file))
  const originalRequire = loaded.require.bind(loaded)
  loaded.require = (name: string) => name === './client-ip'
    ? { resolveClientIp: () => '' }
    : originalRequire(name)
  loaded._compile(code, file)
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  }
  try {
    process.env.NODE_ENV = 'production'
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    const decision = await loaded.exports.checkRateLimit('local-test', 'anonymous', { tokens: 10, window: '1 m' })
    assert.deepEqual(decision, { ok: false, status: 503, message: 'Service temporarily unavailable' })
  } finally {
    for (const [key, value] of [
      ['NODE_ENV', previous.nodeEnv],
      ['UPSTASH_REDIS_REST_URL', previous.url],
      ['UPSTASH_REDIS_REST_TOKEN', previous.token],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('streaming callback body cap rejects chunked requests without Content-Length', async () => {
  const request = new Request('http://localhost/callback', { method: 'POST', body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(20)); controller.close() },
  }), duplex: 'half' } as RequestInit)
  await assert.rejects(readTextWithLimit(request, 16), PayloadTooLargeError)
})
