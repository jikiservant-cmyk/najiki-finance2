/**
 * Inbound webhooks — the hop FROM LivePay INTO this gateway (`/api/webhooks/livepay`)
 * and the Africa's Talking delivery-report callback.
 *
 * These tests drive the real route handler, the real LivePay HMAC verifier, the
 * real idempotency/hash helpers and the real body-size limiter. Only the
 * database, the settlement side effects and tenant-credential lookup are
 * stubbed, because there is no Postgres in CI.
 *
 * The point is to prove the properties a go-live depends on:
 *
 *   • nothing is written or settled before the signature verifies,
 *   • a forged, replayed, stale, oversized or malformed delivery is rejected,
 *   • a genuine retry settles exactly once (and a half-finished attempt resumes),
 *   • a correctly signed body cannot settle the wrong amount, currency or provider,
 *   • the provider-API fallback settles a payment when a tenant never configured
 *     a webhook secret — without trusting the unverified body,
 *   • the machine-to-machine routes are actually reachable through the middleware.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeDb, type Row } from './helpers/fake-db.ts'
import { loadTsModule, REPO_ROOT, srcPath } from './helpers/ts-load.ts'

// ── Fixtures ────────────────────────────────────────────────────────────────

const PLATFORM_SECRET = 'platform-livepay-webhook-secret'
const TENANT_SECRET = 'grace-church-webhook-secret-1234'
const GATEWAY = 'https://gateway.najiki.test'
const CHURCH_API_KEY = 'church_api_key_abcdefghijklmnop'
const CHURCH_WEBHOOK_SECRET = 'church-outbound-webhook-secret'

process.env.NEXTAUTH_URL = GATEWAY
process.env.LIVEPAY_WEBHOOK_SECRET = PLATFORM_SECRET
delete process.env.PUBLIC_BASE_URL
delete process.env.VERCEL_URL
delete process.env.URL
delete process.env.DEPLOY_PRIME_URL
delete process.env.QSTASH_TOKEN
delete process.env.UPSTASH_REDIS_REST_URL

const CHURCH_APPLICATION = {
  id: 'app_church',
  code: 'church',
  name: 'Church App',
  baseUrl: 'https://church.najiki.test',
  webhookPath: '/api/webhooks/najiki',
  apiKey: CHURCH_API_KEY,
  webhookSecretEncrypted: null,
  internalSecretRef: 'CHURCH_INTERNAL_SECRET',
}

const GRACE_CHURCH = { id: 'tenant_grace', code: 'grace-church', name: 'Grace Community Church' }
const TITHE = { id: 'pt_tithe', code: 'tithe', description: 'Tithe payment' }

function churchIntent(overrides: Row = {}): Row {
  return {
    id: 'pi_church_1',
    reference: 'CHURCH-0001',
    amount: 20000,
    currency: 'UGX',
    status: 'pending',
    providerPaymentId: null,
    failureReason: null,
    applicationId: CHURCH_APPLICATION.id,
    tenantId: GRACE_CHURCH.id,
    providerId: 'prov_livepay',
    externalEntityId: 'member_42',
    metadata: JSON.stringify({ paymentTypeCode: 'tithe' }),
    lastPolledAt: null,
    application: CHURCH_APPLICATION,
    tenant: GRACE_CHURCH,
    paymentType: TITHE,
    provider: { id: 'prov_livepay', code: 'livepay' },
    ...overrides,
  }
}

function baseSeed(intent: Row = churchIntent()): Record<string, Row[]> {
  return {
    provider: [
      { id: 'prov_livepay', code: 'livepay', name: 'LivePay', isActive: true },
      { id: 'prov_mtn', code: 'mtn', name: 'MTN MoMo', isActive: true },
      { id: 'prov_airtel', code: 'airtel', name: 'Airtel Money', isActive: false },
    ],
    application: [CHURCH_APPLICATION],
    tenant: [GRACE_CHURCH],
    paymentType: [TITHE],
    paymentIntent: [intent],
    webhookLog: [],
    paymentTransaction: [],
    internalNotification: [],
  }
}

// ── Builders ────────────────────────────────────────────────────────────────

type Harness = {
  POST: (request: Request, ctx: { params: Promise<{ provider: string }> }) => Promise<Response>
  db: any
  completePaymentCalls: any[]
  enqueueCalls: any[]
  flushCalls: string[]
  reconcileCalls: any[]
  tenantCredentialCalls: string[]
  resolveTenantCredentials: (value: any) => void
  reconcileResult: (value: any) => void
}

function loadWebhookRoute(
  intent: Row = churchIntent(),
  options: { seed?: Record<string, Row[]> } = {}
): Harness {
  const db = createFakeDb(options.seed ?? baseSeed(intent))
  const completePaymentCalls: any[] = []
  const enqueueCalls: any[] = []
  const flushCalls: string[] = []
  const reconcileCalls: any[] = []
  const tenantCredentialCalls: string[] = []

  let tenantCredentialResult: any = {
    credentials: {
      apiKey: 'tenant-livepay-api-key',
      accountNo: '256700000000',
      webhookSecret: TENANT_SECRET,
      baseUrl: 'https://livepay.me',
    },
  }
  let reconcileResultValue: any = { status: 'pending' }

  const dataStub = {
    // Mirrors src/lib/data.ts:createWebhookLog — provider must exist, and the
    // signatureHash is the dedupe key enforced by a unique index.
    async createWebhookLog(data: any) {
      const provider = await db.provider.findFirst({ where: { code: data.provider.toLowerCase() } })
      if (!provider) throw new Error(`No provider found for webhook: ${data.provider}`)
      const headers = JSON.stringify({
        signature: data.signature,
        eventType: data.eventType,
        ...(data.headersObj ?? {}),
      })
      return db.webhookLog.upsert({
        where: { signatureHash: data.signatureHash },
        update: {
          payload: data.payload,
          headers,
          signatureValid: data.verified,
          processed: data.processed,
          providerId: provider.id,
          ...(data.processingError !== undefined ? { processingError: data.processingError } : {}),
          ...(data.paymentIntentId ? { paymentIntentId: data.paymentIntentId } : {}),
        },
        create: {
          providerId: provider.id,
          payload: data.payload,
          headers,
          signatureHash: data.signatureHash,
          signatureValid: data.verified,
          processed: data.processed,
          processingError: data.processingError ?? null,
          paymentIntentId: data.paymentIntentId ?? null,
        },
      })
    },
    async getPaymentByReference(reference: string) {
      return db.paymentIntent.findUnique({ where: { reference } })
    },
  }

  const paymentsStub = {
    async completePayment(data: any) {
      completePaymentCalls.push(data)
      const row = db.rows.paymentIntent.find((candidate: Row) => candidate.id === data.paymentIntentId)
      if (row) row.status = data.status
      return { wasAlreadyProcessed: false }
    },
    async enqueueWebhookNotification(data: any) {
      enqueueCalls.push(data)
    },
  }

  const reconcileStub = {
    async flushPendingNotificationsForPayment(id: string) {
      flushCalls.push(id)
      return 0
    },
    async reconcileSinglePaymentById(id: string, opts: any) {
      reconcileCalls.push({ id, opts })
      return reconcileResultValue
    },
  }

  const tenantCredentialsStub = {
    async resolveTenantOrPlatformCredentials(tenantId: string) {
      tenantCredentialCalls.push(tenantId)
      return tenantCredentialResult
    },
  }

  const applicationAuthStub = {
    webhookSecretFromRow: () => CHURCH_WEBHOOK_SECRET,
    fallbackSigningSecretsFromRow: () => [CHURCH_API_KEY],
  }

  const route = loadTsModule<{ POST: Harness['POST'] }>(
    'src/app/api/webhooks/[provider]/route.ts',
    {
      [srcPath('lib/db.ts')]: { db },
      '@/lib/data': dataStub,
      '@/lib/payments': paymentsStub,
      '@/lib/reconcile-payments': reconcileStub,
      '@/lib/tenant-credentials': tenantCredentialsStub,
      '@/lib/application-auth': applicationAuthStub,
    }
  )

  return {
    POST: route.POST,
    db,
    completePaymentCalls,
    enqueueCalls,
    flushCalls,
    reconcileCalls,
    tenantCredentialCalls,
    resolveTenantCredentials: (value: any) => {
      tenantCredentialResult = value
    },
    reconcileResult: (value: any) => {
      reconcileResultValue = value
    },
  }
}

/** Official LivePay string-to-sign: `<url><timestamp>` then sorted `key+value` pairs. */
function livePaySignature(
  params: Record<string, string>,
  secret: string,
  opts: { url?: string; timestamp?: number } = {}
): string {
  const timestamp = opts.timestamp ?? Date.now()
  const url = opts.url ?? `${GATEWAY}/api/webhooks/livepay`
  let stringToSign = `${url}${timestamp}`
  for (const key of Object.keys(params).sort()) stringToSign += `${key}${params[key]}`
  const signature = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('hex')
  return `t=${timestamp},v=${signature}`
}

type Delivery = {
  body: string | Record<string, unknown>
  signature?: string
  headers?: Record<string, string>
  provider?: string
  url?: string
  ip?: string
  plainBody?: boolean
}

let ipCounter = 0

function buildRequest({
  body,
  signature,
  headers = {},
  provider = 'livepay',
  url = `${GATEWAY}/api/webhooks/${provider}`,
  ip,
  plainBody = false,
}: Delivery): Request {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body)
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': ip ?? `203.0.113.${(++ipCounter % 250) + 1}`,
    ...headers,
  }
  if (signature) requestHeaders['x-webhook-signature'] = signature
  return new Request(url, { method: 'POST', body: rawBody, headers: requestHeaders })
}

/** A valid, flat LivePay `/api/transaction-status` delivery for the church tithe. */
function validDelivery(overrides: Record<string, unknown> = {}, opts: { secret?: string; timestamp?: number } = {}) {
  const payload: Record<string, any> = {
    customer_reference: 'CHURCH-0001',
    internal_reference: 'LP_TX_9001',
    status: 'SUCCESSFUL',
    amount: 20000,
    currency: 'UGX',
    ...overrides,
  }

  const signedFields = {
    customer_reference: String(payload.customer_reference ?? ''),
    internal_reference: String(payload.internal_reference ?? ''),
    status: String(payload.status ?? ''),
  }

  return {
    payload,
    signature: livePaySignature(signedFields, opts.secret ?? TENANT_SECRET, { timestamp: opts.timestamp }),
    rawBody: JSON.stringify(payload),
  }
}

function routeParams(provider: string) {
  return { params: Promise.resolve({ provider }) }
}

async function deliver(harness: Harness, request: Request, provider = 'livepay') {
  const response = await harness.POST(request, routeParams(provider))
  const text = await response.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

function logRows(harness: Harness): Row[] {
  return harness.db.rows.webhookLog
}

// ── Hop 1: LivePay → gateway ────────────────────────────────────────────────

test("webhook(hop 1): a correctly signed LivePay delivery settles the church tithe exactly once", async () => {
  const harness = loadWebhookRoute()
  const { payload, signature } = validDelivery()

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { success: true })

  assert.equal(harness.completePaymentCalls.length, 1)
  const settled = harness.completePaymentCalls[0]
  assert.equal(settled.paymentIntentId, 'pi_church_1')
  assert.equal(settled.status, 'success')
  assert.equal(settled.providerPaymentId, 'LP_TX_9001')
  // Amount and currency come from the stored intent, never from the provider body.
  assert.equal(settled.amount, 20000)
  assert.equal(settled.currency, 'UGX')

  assert.equal(harness.enqueueCalls.length, 1)
  const notification = harness.enqueueCalls[0]
  assert.equal(notification.reference, 'CHURCH-0001')
  assert.equal(notification.status, 'success')
  assert.equal(notification.tenantCode, 'grace-church')
  assert.equal(notification.paymentTypeCode, 'tithe')
  assert.equal(notification.webhookUrl, 'https://church.najiki.test/api/webhooks/najiki')
  assert.equal(notification.webhookSecret, CHURCH_WEBHOOK_SECRET)
  assert.deepEqual(notification.fallbackWebhookSecrets, [CHURCH_API_KEY])

  const logs = logRows(harness)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].signatureValid, true)
  assert.equal(logs[0].processed, true)
  assert.equal(logs[0].paymentIntentId, 'pi_church_1')
  assert.equal(logs[0].providerId, 'prov_livepay')

  // The tenant's own webhook secret verified this delivery.
  assert.deepEqual(harness.tenantCredentialCalls, [GRACE_CHURCH.id])
})

test('webhook(hop 1): an identical retry is acknowledged as a duplicate and never re-settles', async () => {
  const harness = loadWebhookRoute()
  const { payload, signature } = validDelivery()

  const first = await deliver(harness, buildRequest({ body: payload, signature }))
  const second = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(second.json, { success: true, duplicate: true })
  assert.equal(harness.completePaymentCalls.length, 1, 'a retry must not settle twice')
  assert.equal(harness.enqueueCalls.length, 1, 'a retry must not notify the church twice')
  assert.equal(logRows(harness).length, 1, 'a retry must reuse the audit row')
})

test('webhook(hop 1): a delivery that died half-way is resumed, not written off as a duplicate', async () => {
  // The row exists with processed:false — exactly what a crash between the
  // insert and completePayment() leaves behind. The provider is retrying.
  const harness = loadWebhookRoute()
  const { payload } = validDelivery()

  const { computeWebhookEventHash } = loadTsModule<{ computeWebhookEventHash: any }>(
    'src/lib/webhook-hash.ts',
    { __loaderCache: new Map() }
  )
  const { hash } = computeWebhookEventHash({
    providerCode: 'livepay',
    rawBody: JSON.stringify(payload),
    parsedBody: payload,
  })

  await harness.db.webhookLog.create({
    data: {
      providerId: 'prov_livepay',
      payload: JSON.stringify(payload),
      signatureHash: hash,
      signatureValid: true,
      processed: false,
      processingError: 'ECONNRESET while crediting wallet',
    },
  })

  const { signature } = validDelivery()
  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { success: true })
  assert.equal(harness.completePaymentCalls.length, 1, 'the resumed delivery must settle the payment')
  assert.equal(logRows(harness).length, 1)
  assert.equal(logRows(harness)[0].processed, true)
})

test('webhook(hop 1): a missing signature is rejected and never settles', async () => {
  const harness = loadWebhookRoute()
  const { payload } = validDelivery()

  const result = await deliver(harness, buildRequest({ body: payload }))

  assert.equal(result.status, 401)
  assert.equal(result.json.error, 'Invalid signature')
  assert.equal(harness.completePaymentCalls.length, 0)
  assert.equal(harness.enqueueCalls.length, 0)
  assert.match(logRows(harness)[0].processingError, /missing X-Webhook-Signature/)
})

test('webhook(hop 1): a forged signature signed with the platform secret is rejected for a tenant payment', async () => {
  const harness = loadWebhookRoute()
  const { payload, signature } = validDelivery({}, { secret: PLATFORM_SECRET })

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 401)
  assert.equal(harness.completePaymentCalls.length, 0)
})

test('webhook(hop 1): a body tampered with after signing is rejected', async () => {
  const harness = loadWebhookRoute()
  const { payload, signature } = validDelivery()
  const tampered = { ...payload, status: 'FAILED' }

  const result = await deliver(harness, buildRequest({ body: tampered, signature }))

  assert.equal(result.status, 401, 'the signed status must not be alterable in flight')
  assert.equal(harness.completePaymentCalls.length, 0)
})

test('webhook(hop 1): a replayed delivery outside the 5-minute window is rejected', async () => {
  const harness = loadWebhookRoute()
  const { payload, signature } = validDelivery({}, { timestamp: Date.now() - 6 * 60 * 1000 })

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 401)
  assert.equal(harness.completePaymentCalls.length, 0)
})

test('webhook(hop 1): an unverified delivery does not pre-seed the dedupe hash, so the genuine one still settles', async () => {
  const harness = loadWebhookRoute()
  const { payload } = validDelivery()

  const forged = await deliver(harness, buildRequest({ body: payload, signature: 't=1,v=deadbeef' }))
  assert.equal(forged.status, 401)

  const rowsAfterForge = logRows(harness)
  assert.equal(rowsAfterForge.length, 1)
  assert.match(rowsAfterForge[0].signatureHash, /^unverified:/)
  assert.equal(rowsAfterForge[0].signatureValid, false)

  const { signature } = validDelivery()
  const genuine = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(genuine.status, 200)
  assert.deepEqual(genuine.json, { success: true })
  assert.equal(harness.completePaymentCalls.length, 1)
})

test('webhook(hop 1): a tenant whose webhook secret does not match is settled only via an authenticated provider status check', async () => {
  const harness = loadWebhookRoute(churchIntent({ lastPolledAt: new Date(Date.now() - 5000) }))
  // LivePay's authenticated status endpoint is the source of truth here.
  harness.reconcileResult({ status: 'success' })
  const { payload } = validDelivery()

  const result = await deliver(harness, buildRequest({ body: payload, signature: 't=1,v=whatever' }))

  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { success: true, verifiedViaProviderPoll: true, status: 'success' })
  assert.equal(harness.reconcileCalls.length, 1)
  assert.equal(harness.completePaymentCalls.length, 0, 'the unverified body must never be the thing that settles')
  assert.equal(logRows(harness)[0].signatureValid, false)
  assert.equal(logRows(harness)[0].processed, true)
})

test('webhook(hop 1): a signed delivery whose amount disagrees with the intent is disputed, not settled', async () => {
  const harness = loadWebhookRoute()
  // LivePay's official signature covers reference + status only, so amount is
  // attacker-mutable in flight — this gate is the only thing stopping a
  // UGX 100 payment being recorded against a UGX 20,000 intent.
  const { payload, signature } = validDelivery({ amount: 100 })

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 422)
  assert.equal(result.json.error, 'Amount mismatch')
  assert.equal(harness.completePaymentCalls.length, 0)

  const disputes = harness.db.rows.paymentTransaction
  assert.equal(disputes.length, 1)
  assert.equal(disputes[0].status, 'disputed')
  assert.match(disputes[0].note, /AMOUNT_MISMATCH/)

  const log = logRows(harness)[0]
  assert.equal(log.processed, true)
  assert.match(log.processingError, /AMOUNT_MISMATCH expected=20000 reported=100/)
})

test('webhook(hop 1): a signed delivery in the wrong currency is disputed, not settled', async () => {
  const harness = loadWebhookRoute()
  const { payload, signature } = validDelivery({ currency: 'USD' })

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 422)
  assert.equal(result.json.error, 'Currency mismatch')
  assert.equal(harness.completePaymentCalls.length, 0)
  assert.match(harness.db.rows.paymentTransaction[0].note, /CURRENCY_MISMATCH/)
})

test('webhook(hop 1): a callback signed by provider A cannot settle a payment created on provider B', async () => {
  const harness = loadWebhookRoute(churchIntent({ provider: { id: 'prov_mtn', code: 'mtn' }, providerId: 'prov_mtn' }))
  const { payload, signature } = validDelivery()

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 409)
  assert.equal(result.json.error, 'Provider mismatch')
  assert.equal(harness.completePaymentCalls.length, 0)
  assert.match(logRows(harness)[0].processingError, /PROVIDER_MISMATCH/)
})

test('webhook(hop 1): a delivery for an unknown reference is logged and rejected with 404', async () => {
  const harness = loadWebhookRoute()
  const { payload, signature } = validDelivery({ customer_reference: 'CHURCH-NOPE' }, { secret: PLATFORM_SECRET })

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 404)
  assert.equal(result.json.error, 'Payment not found')
  assert.equal(harness.completePaymentCalls.length, 0)
})

test('webhook(hop 1): a delivery with no reference at all is rejected with 400', async () => {
  const harness = loadWebhookRoute()
  const payload = { internal_reference: 'LP_TX_1', status: 'SUCCESSFUL', amount: 20000, currency: 'UGX' }
  const signature = livePaySignature(
    { customer_reference: '', internal_reference: 'LP_TX_1', status: 'SUCCESSFUL' },
    PLATFORM_SECRET
  )

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 400)
  assert.equal(result.json.error, 'Missing payment reference')
})

test('webhook(hop 1): a malformed JSON body fails closed with 401 rather than 500', async () => {
  const harness = loadWebhookRoute()
  const rawBody = '{"customer_reference":"CHURCH-0001",'
  const signature = livePaySignature(
    { customer_reference: 'CHURCH-0001', internal_reference: '', status: '' },
    PLATFORM_SECRET
  )

  const result = await deliver(harness, buildRequest({ body: rawBody, signature }))

  assert.equal(result.status, 401)
  assert.equal(harness.completePaymentCalls.length, 0)
})

test('webhook(hop 1): an oversized body is refused with 413 before it is buffered', async () => {
  const harness = loadWebhookRoute()
  const huge = JSON.stringify({ customer_reference: 'CHURCH-0001', padding: 'x'.repeat(70 * 1024) })

  const result = await deliver(harness, buildRequest({ body: huge }))

  assert.equal(result.status, 413)
  assert.equal(result.json.error, 'Payload too large')
})

test('webhook(hop 1): an unimplemented provider code is refused before any database work', async () => {
  const harness = loadWebhookRoute()

  // MTN/Airtel/Pesapal exist as seeded rows but have no adapter. A webhook
  // addressed to them must be refused outright — a stub verifier would be a
  // fail-open endpoint.
  for (const provider of ['pesapal', 'mtn', 'airtel']) {
    const response = await deliver(harness, buildRequest({ body: {}, provider }), provider)
    assert.equal(response.status, 400, `${provider} must be refused`)
    assert.equal(response.json.error, 'Invalid provider')
  }

  assert.equal(harness.completePaymentCalls.length, 0)
})

test('webhook(hop 1): a provider row that exists but is deactivated returns 404', async () => {
  const seed = baseSeed()
  seed.provider = [{ id: 'prov_livepay', code: 'livepay', name: 'LivePay', isActive: false }]
  const harness = loadWebhookRoute(churchIntent(), { seed })

  const { payload, signature } = validDelivery()
  const response = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(response.status, 404)
  assert.equal(response.json.error, 'Provider not active')
  assert.equal(harness.completePaymentCalls.length, 0)
})

test('webhook(hop 1): a tenant with unusable LivePay credentials is refused rather than falling back to the platform account', async () => {
  const harness = loadWebhookRoute(churchIntent({ lastPolledAt: new Date(Date.now() - 5000) }))
  harness.resolveTenantCredentials(null)
  const { payload, signature } = validDelivery()

  const response = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(response.status, 401)
  assert.equal(response.json.error, 'Invalid signature')
  assert.equal(harness.completePaymentCalls.length, 0)
  assert.equal(
    harness.reconcileCalls.length,
    0,
    'without usable credentials there is nothing to verify the payment against'
  )
})

test('webhook(hop 1): a payment already settled is acknowledged without double-crediting', async () => {
  const harness = loadWebhookRoute(churchIntent({ status: 'success' }))
  const { payload, signature } = validDelivery()

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { success: true, duplicate: true })
  assert.equal(harness.completePaymentCalls.length, 0)
  assert.deepEqual(harness.flushCalls, ['pi_church_1'], 'a stuck partner notification should be flushed')
})

test('webhook(hop 1): the signature verifies against the configured public origin, not the proxy host header', async () => {
  const harness = loadWebhookRoute()
  const { payload, signature } = validDelivery()

  // The request arrives over plain HTTP at an internal host (reverse proxy).
  // The signed URL is the public canonical origin plus the webhook path.
  const request = buildRequest({
    body: payload,
    signature,
    url: 'http://10.0.0.5:3000/api/webhooks/livepay',
  })

  const result = await deliver(harness, request)

  assert.equal(result.status, 200, 'canonical-origin signatures must verify behind a proxy')
  assert.equal(harness.completePaymentCalls.length, 1)
})

test('webhook(hop 1): a platform-fee payment (no tenant) is verified with the platform secret', async () => {
  const harness = loadWebhookRoute(
    churchIntent({
      reference: 'SMS-TOPUP-1',
      tenantId: null,
      tenant: null,
      paymentType: { code: 'SMS_TOPUP' },
      metadata: JSON.stringify({ paymentTypeCode: 'SMS_TOPUP' }),
    })
  )

  const payload = {
    customer_reference: 'SMS-TOPUP-1',
    internal_reference: 'LP_TX_PLATFORM',
    status: 'SUCCESSFUL',
    amount: 20000,
    currency: 'UGX',
  }
  const signature = livePaySignature(
    { customer_reference: 'SMS-TOPUP-1', internal_reference: 'LP_TX_PLATFORM', status: 'SUCCESSFUL' },
    PLATFORM_SECRET
  )

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 200)
  assert.equal(harness.completePaymentCalls.length, 1)
  assert.deepEqual(harness.tenantCredentialCalls, [], 'platform fees must not resolve tenant credentials')
})

test('webhook(hop 1): a failed payment is recorded as failed and never notified as a success', async () => {
  const harness = loadWebhookRoute()
  const { payload, signature } = validDelivery({ status: 'FAILED' })

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 200)
  assert.equal(harness.completePaymentCalls.length, 1)
  assert.equal(harness.completePaymentCalls[0].status, 'failed')
  assert.equal(harness.enqueueCalls.length, 1)
  assert.equal(harness.enqueueCalls[0].status, 'failed')
  assert.ok(harness.enqueueCalls[0].failureReason)
})

test('webhook(hop 1): the nested `data` envelope LivePay also sends is accepted', async () => {
  const harness = loadWebhookRoute()
  const inner = {
    customer_reference: 'CHURCH-0001',
    internal_reference: 'LP_TX_9002',
    status: 'successful',
    amount: 20000,
    currency: 'UGX',
  }
  const payload = { event: 'transaction.status', data: inner }
  const signature = livePaySignature(
    { customer_reference: 'CHURCH-0001', internal_reference: 'LP_TX_9002', status: 'successful' },
    TENANT_SECRET
  )

  const result = await deliver(harness, buildRequest({ body: payload, signature }))

  assert.equal(result.status, 200)
  assert.equal(harness.completePaymentCalls[0].providerPaymentId, 'LP_TX_9002')
})

test('webhook(hop 1): a Sunday-scale burst from one provider IP is not throttled', async () => {
  // 300 settlements inside one minute all arrive from the provider's egress
  // address. At the old 120/min ceiling two thirds of these were answered 429
  // and the congregation's payments stayed "pending" until the retry landed.
  const harness = loadWebhookRoute()
  const ip = '198.51.100.10'
  const body = { customer_reference: 'CHURCH-0001', status: 'PENDING' }

  const statuses: number[] = []
  for (let i = 0; i < 300; i++) {
    const response = await deliver(harness, buildRequest({ body, provider: 'mtn', ip }), 'mtn')
    statuses.push(response.status)
  }

  assert.equal(
    statuses.filter((status) => status === 429).length,
    0,
    'a 300-payment burst must not be throttled at the default ceiling'
  )
})

test('webhook(hop 1): the inbound ceiling still exists and is tunable per deployment', async () => {
  const previous = process.env.WEBHOOK_INBOUND_RATE_LIMIT_PER_MINUTE
  process.env.WEBHOOK_INBOUND_RATE_LIMIT_PER_MINUTE = '60'
  try {
    const harness = loadWebhookRoute()
    const ip = '198.51.100.20'
    const body = { customer_reference: 'CHURCH-0001', status: 'PENDING' }

    const statuses: number[] = []
    for (let i = 0; i < 61; i++) {
      const response = await deliver(harness, buildRequest({ body, provider: 'mtn', ip }), 'mtn')
      statuses.push(response.status)
    }

    assert.ok(
      statuses.slice(0, 60).every((status) => status !== 429),
      'the configured allowance must be honoured'
    )
    assert.equal(statuses[60], 429, 'past the allowance the request must be throttled')
  } finally {
    if (previous === undefined) delete process.env.WEBHOOK_INBOUND_RATE_LIMIT_PER_MINUTE
    else process.env.WEBHOOK_INBOUND_RATE_LIMIT_PER_MINUTE = previous
  }
})

// ── Africa's Talking delivery reports ──────────────────────────────────────

type SmsHarness = {
  POST: (request: Request) => Promise<Response>
  GET: () => Promise<Response>
  reports: Array<{ id: string; status: string }>
  resolved: string[]
  notified: any[]
}

function loadSmsCallback(options: { rememberReturns?: any } = {}): SmsHarness {
  const reports: Array<{ id: string; status: string }> = []
  const resolved: string[] = []
  const notified: any[] = []

  const smsStoreStub = {
    smsStore: {
      async rememberDeliveryReport(id: string, status: string) {
        reports.push({ id, status })
      },
      async resolveDeliveryReport(id: string) {
        resolved.push(id)
        return options.rememberReturns === undefined
          ? { id: 'sms_1', providerMessageId: id, status: 'delivered', applicationId: 'app_church' }
          : options.rememberReturns
      },
    },
  }
  const smsQueueStub = {
    async deliverSmsNotification(row: any) {
      notified.push(row)
    },
  }

  const route = loadTsModule<{ POST: SmsHarness['POST']; GET: SmsHarness['GET'] }>(
    'src/app/api/webhooks/africastalking/route.ts',
    {
      '@/lib/sms-store': smsStoreStub,
      '@/lib/sms-queue': smsQueueStub,
    }
  )

  return { POST: route.POST, GET: route.GET, reports, resolved, notified }
}

function formRequest(fields: Record<string, string>, opts: { query?: string; headers?: Record<string, string> } = {}) {
  const query = opts.query ? `?${opts.query}` : ''
  return new Request(`https://gateway.najiki.test/api/webhooks/africastalking${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': `203.0.113.${(++ipCounter % 250) + 1}`,
      ...opts.headers,
    },
    body: new URLSearchParams(fields).toString(),
  })
}

test("webhook(Africa's Talking): a delivery report with the URL secret marks the SMS delivered", async () => {
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'at-callback-secret-123456'
  try {
    const harness = loadSmsCallback()
    const response = await harness.POST(
      formRequest(
        { id: 'ATXid_1', status: 'Success', phoneNumber: '+256700000000', retryCount: '0' },
        { query: 'key=at-callback-secret-123456' }
      )
    )

    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'OK')
    assert.deepEqual(harness.reports, [{ id: 'ATXid_1', status: 'delivered' }])
    assert.deepEqual(harness.resolved, ['ATXid_1'])
    assert.equal(harness.notified.length, 1)
  } finally {
    delete process.env.AFRICASTALKING_CALLBACK_SECRET
  }
})

test("webhook(Africa's Talking): the header secret is still accepted", async () => {
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'at-callback-secret-123456'
  try {
    const harness = loadSmsCallback()
    const response = await harness.POST(
      formRequest(
        { id: 'ATXid_2', status: 'Failed' },
        { headers: { 'x-callback-secret': 'at-callback-secret-123456' } }
      )
    )

    assert.equal(response.status, 200)
    assert.deepEqual(harness.reports, [{ id: 'ATXid_2', status: 'failed' }])
  } finally {
    delete process.env.AFRICASTALKING_CALLBACK_SECRET
  }
})

test("webhook(Africa's Talking): a wrong or absent secret is rejected", async () => {
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'at-callback-secret-123456'
  try {
    const harness = loadSmsCallback()
    const wrong = await harness.POST(formRequest({ id: 'ATXid_3', status: 'Success' }, { query: 'key=nope' }))
    const absent = await harness.POST(formRequest({ id: 'ATXid_3', status: 'Success' }))

    assert.equal(wrong.status, 401)
    assert.equal(absent.status, 401)
    assert.equal(harness.reports.length, 0)
  } finally {
    delete process.env.AFRICASTALKING_CALLBACK_SECRET
  }
})

test("webhook(Africa's Talking): production without any configured credential fails closed", async () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  delete process.env.AFRICASTALKING_CALLBACK_SECRET
  delete process.env.AFRICASTALKING_ALLOWED_IPS
  try {
    const harness = loadSmsCallback()
    const response = await harness.POST(formRequest({ id: 'ATXid_4', status: 'Success' }))

    assert.equal(response.status, 401)
    assert.equal(harness.reports.length, 0)
  } finally {
    process.env.NODE_ENV = previous
  }
})

test("webhook(Africa's Talking): acceptance events do not change a message's state", async () => {
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'at-callback-secret-123456'
  try {
    const harness = loadSmsCallback()
    const response = await harness.POST(
      formRequest({ id: 'ATXid_5', status: 'Buffered' }, { query: 'key=at-callback-secret-123456' })
    )

    assert.equal(response.status, 200)
    assert.equal(harness.reports.length, 0, '"buffered" is not proof of delivery')
  } finally {
    delete process.env.AFRICASTALKING_CALLBACK_SECRET
  }
})

test("webhook(Africa's Talking): an oversized delivery report is refused", async () => {
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'at-callback-secret-123456'
  try {
    const harness = loadSmsCallback()
    const response = await harness.POST(
      formRequest({ id: 'ATXid_6', status: 'Success', junk: 'x'.repeat(20 * 1024) }, { query: 'key=at-callback-secret-123456' })
    )

    assert.equal(response.status, 413)
    assert.equal(harness.reports.length, 0)
  } finally {
    delete process.env.AFRICASTALKING_CALLBACK_SECRET
  }
})

test("webhook(Africa's Talking): GET reports the callback as reachable", async () => {
  const harness = loadSmsCallback()
  const response = await harness.GET()

  assert.equal(response.status, 200)
  assert.match(await response.text(), /Webhook Active/)
})

// ── Reachability ────────────────────────────────────────────────────────────

test('webhook(reachability): the middleware matcher exempts every machine-to-machine webhook path', () => {
  const middleware = loadTsModule<{ config: { matcher: string[] } }>('src/middleware.ts', {
    '@supabase/ssr': { createServerClient: () => ({}), type: {} },
  })

  const matcher = new RegExp(`^${middleware.config.matcher[0]}$`)

  const machineToMachine = [
    '/api/webhooks/livepay',
    '/api/webhooks/africastalking',
    '/api/messaging/callback',
    '/api/cron/notifications',
    '/api/qstash/sms-cron',
    '/api/payments',
  ]
  for (const route of machineToMachine) {
    assert.equal(matcher.test(route), false, `${route} must not sit behind the dashboard session gate`)
  }

  // The diagnostics endpoint is a *dashboard* route despite the shared prefix,
  // so it must stay gated. `api/webhooks/` (with the slash) is what exempts the
  // provider callbacks, and it deliberately does not match the bare path.
  const sessionGated = ['/', '/dashboard', '/transactions', '/webhooks', '/api/webhooks', '/api/dashboard', '/api/setup']
  for (const route of sessionGated) {
    assert.equal(matcher.test(route), true, `${route} must stay behind the session gate`)
  }
})

test('webhook(reachability): the callback route module exists at the path Africa\'s Talking is told to call', () => {
  for (const route of [
    'src/app/api/webhooks/livepay/route.ts',
    'src/app/api/webhooks/africastalking/route.ts',
    'src/app/api/messaging/callback/route.ts',
  ]) {
    // `[provider]` serves /api/webhooks/livepay; the explicit directories must
    // not exist for the dynamic segment to be shadowed.
    if (route.includes('/livepay/')) continue
    assert.ok(fs.existsSync(path.join(REPO_ROOT, route)), `${route} is missing`)
  }
})
