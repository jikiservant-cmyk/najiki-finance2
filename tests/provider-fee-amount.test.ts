/**
 * Provider fees: gross vs net.
 *
 * The bug this locks down, from production on 2026-10-28:
 *
 *   tenant `sdfg`, LivePay txn c14be48a-3590-46af-af1d-3106c6aa1862
 *   we requested ............ UGX 17,000
 *   webhook said ............ amount 17,510, charge 510
 *   merchant dashboard ...... "Account Balance UGX 17,000.00"
 *
 * The amount gate compared the intent to the GROSS, so a perfectly good payment
 * was refused with `AMOUNT_MISMATCH expected=17000 reported=17510`, marked
 * `disputed`, never credited and never announced to the Church app. The same
 * thing happened to the SACCO partner (expected 5,000 / reported 5,150).
 *
 * Every case below is written so that the fix cannot be "relax the gate":
 * the comparison must move to the NET, and a short payment must still fail.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeDb, type Row } from './helpers/fake-db.ts'
import { loadTsModule, srcPath } from './helpers/ts-load.ts'
import { checkProviderAmount, parseProviderCharge } from '../src/lib/provider-amount.ts'

const { isConfirmedTerminalStatus } = loadTsModule<{
  isConfirmedTerminalStatus: (result: any, expected?: any) => boolean
}>('src/lib/payment-security.ts')

const { LivePayProvider } = loadTsModule<{ LivePayProvider: any }>('src/lib/providers/livepay.ts')

// ── 1. The pure rule ────────────────────────────────────────────────────────

test('provider fee: the LivePay production delivery settles (gross 17,510, charge 510, intent 17,000)', () => {
  const check = checkProviderAmount({ expected: 17000, reported: 17510, charge: 510 })
  assert.equal(check.ok, true)
  assert.equal(check.net, 17000)
  assert.equal(check.charge, 510)
  assert.equal(check.reason, 'OK')
})

test('provider fee: the SACCO production delivery settles too (gross 5,150, charge 150, intent 5,000)', () => {
  assert.equal(checkProviderAmount({ expected: 5000, reported: 5150, charge: 150 }).ok, true)
})

test('provider fee: LivePay\'s DOCUMENTED shape (amount is the net, fee reported alongside) also settles', () => {
  // docs.livepay.me flat payload, as used by the existing deposit-resilience
  // fixture: amount 5000 / charge 150 for a 5,000 request. Here `amount` is what
  // the merchant gets and the fee sits beside it — the opposite convention to
  // the 17,510 production delivery. Both must be readable, exactly.
  const check = checkProviderAmount({ expected: 5000, reported: 5000, charge: 150 })
  assert.equal(check.ok, true)
  assert.equal(check.match, 'GROSS', 'amount already equals the intent amount')

  // And the production shape is identified as the net convention.
  assert.equal(checkProviderAmount({ expected: 17000, reported: 17510, charge: 510 }).match, 'NET')
  assert.equal(checkProviderAmount({ expected: 20000, reported: 20000 }).match, 'GROSS')
})

test('provider fee: a provider that reports a NET amount and no charge still behaves exactly as before', () => {
  assert.equal(checkProviderAmount({ expected: 20000, reported: 20000 }).ok, true)
  assert.equal(checkProviderAmount({ expected: 20000, reported: 20000, charge: 0 }).ok, true)
  // …and a body with no amount at all is still assumed to be the intent amount.
  assert.equal(checkProviderAmount({ expected: 20000, reported: undefined }).ok, true)
  assert.equal(checkProviderAmount({ expected: 20000, reported: null }).ok, true)
})

test('provider fee: a SHORT payment is still refused — the fix is not a tolerance band', () => {
  // 100 against a 20,000 intent: the original attack this gate exists for.
  assert.equal(checkProviderAmount({ expected: 20000, reported: 100, charge: 0 }).ok, false)
  // One shilling short is still short.
  assert.equal(checkProviderAmount({ expected: 20000, reported: 19999, charge: 0 }).ok, false)
  // Short by the fee: gross looks almost right, net is 16,000.
  const check = checkProviderAmount({ expected: 17000, reported: 16510, charge: 510 })
  assert.equal(check.ok, false)
  assert.equal(check.net, 16000)
  assert.match(check.detail, /AMOUNT_MISMATCH expected=17000 reported=16510 charge=510 net=16000/)
})

test('provider fee: a fee that does not reconcile to the intent is refused', () => {
  // Gross 17,510 but a claimed fee of 100 => net 17,410 (over-paid by 410).
  assert.equal(checkProviderAmount({ expected: 17000, reported: 17510, charge: 100 }).ok, false)
  // Gross 17,510 with an inflated fee => net 16,000.
  assert.equal(checkProviderAmount({ expected: 17000, reported: 17510, charge: 1510 }).ok, false)
  // No amount reported for the fee at all but gross is over: refused, because we
  // cannot prove the surplus is a fee.
  assert.equal(checkProviderAmount({ expected: 17000, reported: 17510 }).ok, false)
})

test('provider fee: a negative or non-numeric charge can never widen the gate', () => {
  // A negative "charge" would make gross - charge EXCEED gross: a 100-shilling
  // payment must not become a 20,000-shilling settlement.
  const negative = checkProviderAmount({ expected: 20000, reported: 19900, charge: -100 })
  assert.equal(negative.ok, false)
  assert.equal(negative.reason, 'INVALID_CHARGE')

  const junk = checkProviderAmount({ expected: 20000, reported: 20000, charge: 'lots' })
  assert.equal(junk.ok, false)
  assert.equal(junk.reason, 'INVALID_CHARGE')

  const junkAmount = checkProviderAmount({ expected: 20000, reported: 'n/a', charge: 0 })
  assert.equal(junkAmount.ok, false)
  assert.equal(junkAmount.reason, 'INVALID_AMOUNT')

  assert.equal(parseProviderCharge(undefined), 0)
  assert.equal(parseProviderCharge(''), 0)
  assert.equal(parseProviderCharge('510'), 510)
  assert.equal(parseProviderCharge(-1), null)
  assert.equal(parseProviderCharge(NaN), null)
})

// ── 2. The adapter must actually surface `charge` ───────────────────────────

test('provider fee: LivePay parseWebhookPayload keeps the provider charge (it used to be dropped)', async () => {
  const provider = new LivePayProvider({
    apiKey: 'k',
    accountNo: 'acc',
    webhookSecret: 'tenant-livepay-secret-0123456789',
    baseUrl: 'https://livepay.me',
  })

  const parsed = await provider.parseWebhookPayload({
    customer_reference: 'CHURCH-ACC-82A982D1-E1121A6875',
    internal_reference: 'c14be48a-3590-46af-af1d-3106c6aa1862',
    status: 'SUCCESSFUL',
    amount: 17510,
    charge: 510,
    currency: 'UGX',
  })

  assert.equal(parsed.amount, 17510)
  assert.equal(parsed.charge, 510)
  assert.equal(checkProviderAmount({ expected: 17000, reported: parsed.amount, charge: parsed.charge }).ok, true)

  // Nested in `data`, which is the other shape LivePay uses.
  const nested = await provider.parseWebhookPayload({
    data: {
      customer_reference: 'X',
      internal_reference: 'Y',
      status: 'SUCCESSFUL',
      amount: 17510,
      charge: 510,
      currency: 'UGX',
    },
  })
  assert.equal(nested.charge, 510)
})

test('provider fee: LivePay with no charge field is unchanged (no invented fee)', async () => {
  const provider = new LivePayProvider({
    apiKey: 'k',
    accountNo: 'acc',
    webhookSecret: 'tenant-livepay-secret-0123456789',
    baseUrl: 'https://livepay.me',
  })
  const parsed = await provider.parseWebhookPayload({
    customer_reference: 'A',
    internal_reference: 'B',
    status: 'SUCCESSFUL',
    amount: 20000,
    currency: 'UGX',
  })
  assert.equal(parsed.charge, undefined)
})

// ── 3. The poll / cron confirmation path ───────────────────────────────────

test('provider fee: the status-poll gate confirms a fee-bearing settlement (this is what kept payments stuck forever)', () => {
  const expected = { amount: 17000, currency: 'UGX', providerPaymentId: 'c14be48a' }

  // LivePay reports the payer's gross plus its fee.
  assert.equal(
    isConfirmedTerminalStatus(
      { success: true, status: 'success', amount: 17510, charge: 510, currency: 'UGX', providerPaymentId: 'c14be48a' },
      expected
    ),
    true
  )

  // Gross with no fee reported: still refused — we cannot prove the surplus.
  assert.equal(
    isConfirmedTerminalStatus(
      { success: true, status: 'success', amount: 17510, currency: 'UGX', providerPaymentId: 'c14be48a' },
      expected
    ),
    false
  )

  // Wrong net.
  assert.equal(
    isConfirmedTerminalStatus(
      { success: true, status: 'success', amount: 17510, charge: 1510, currency: 'UGX', providerPaymentId: 'c14be48a' },
      expected
    ),
    false
  )

  // Documented LivePay shape: the fee is reported beside an already-net amount.
  assert.equal(
    isConfirmedTerminalStatus(
      { success: true, status: 'success', amount: 5000, charge: 150, currency: 'UGX' },
      { amount: 5000, currency: 'UGX' }
    ),
    true
  )

  // Net amount with no fee: unchanged behaviour.
  assert.equal(
    isConfirmedTerminalStatus(
      { success: true, status: 'success', amount: 17000, currency: 'UGX', providerPaymentId: 'c14be48a' },
      expected
    ),
    true
  )
})

test('provider fee: currency and provider-id gates still apply on top of the amount check', () => {
  const expected = { amount: 17000, currency: 'UGX', providerPaymentId: 'c14be48a' }
  assert.equal(
    isConfirmedTerminalStatus(
      { success: true, status: 'success', amount: 17510, charge: 510, currency: 'USD', providerPaymentId: 'c14be48a' },
      expected
    ),
    false
  )
  assert.equal(
    isConfirmedTerminalStatus(
      { success: true, status: 'success', amount: 17510, charge: 510, currency: 'UGX', providerPaymentId: 'someone-else' },
      expected
    ),
    false
  )
})

// ── 4. End-to-end: the webhook route settles instead of disputing ──────────
//
// Same harness shape as tests/webhook-inbound.test.ts: the real route, the real
// LivePay HMAC verifier and the real amount gate; only the DB and settlement
// side effects are stubbed.

import crypto from 'node:crypto'

// The tenant's own LivePay secret: a configured tenant is verified against its
// own secret first, exactly as the route does in production.
const TENANT_SECRET = 'tenant-livepay-secret-0123456789'
const GATEWAY = 'https://gateway.najiki.test'
const CHURCH_API_KEY = 'church_api_key_abcdefghijklmnop'

process.env.NEXTAUTH_URL = GATEWAY
process.env.LIVEPAY_WEBHOOK_SECRET = 'platform-livepay-webhook-secret'
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

function churchIntent(overrides: Row = {}): Row {
  return {
    id: 'pi_church_fee',
    reference: 'CHURCH-ACC-82A982D1-E1121A6875',
    amount: 17000,
    currency: 'UGX',
    status: 'processing',
    providerPaymentId: 'c14be48a-3590-46af-af1d-3106c6aa1862',
    failureReason: null,
    applicationId: CHURCH_APPLICATION.id,
    tenantId: 'tenant_sdfg',
    providerId: 'prov_livepay',
    externalEntityId: 'member_7',
    metadata: JSON.stringify({ paymentTypeCode: 'tithe' }),
    lastPolledAt: null,
    application: CHURCH_APPLICATION,
    tenant: { id: 'tenant_sdfg', code: 'sdfg', name: 'SDFG Church' },
    paymentType: { id: 'pt_tithe', code: 'tithe', description: 'Tithe' },
    provider: { id: 'prov_livepay', code: 'livepay' },
    ...overrides,
  }
}

function loadRoute(intent: Row = churchIntent()) {
  const db = createFakeDb({
    provider: [{ id: 'prov_livepay', code: 'livepay', name: 'LivePay', isActive: true }],
    application: [CHURCH_APPLICATION],
    tenant: [{ id: 'tenant_sdfg', code: 'sdfg', name: 'SDFG Church' }],
    paymentType: [{ id: 'pt_tithe', code: 'tithe', description: 'Tithe' }],
    paymentIntent: [intent],
    webhookLog: [],
    paymentTransaction: [],
    internalNotification: [],
  })
  const completePaymentCalls: any[] = []

  const dataStub = {
    async createWebhookLog(data: any) {
      const provider = await db.provider.findFirst({ where: { code: data.provider.toLowerCase() } })
      if (!provider) throw new Error('no provider')
      return db.webhookLog.upsert({
        where: { signatureHash: data.signatureHash },
        update: {
          payload: data.payload,
          headers: '{}',
          signatureValid: data.verified,
          processed: data.processed,
          providerId: provider.id,
          ...(data.paymentIntentId ? { paymentIntentId: data.paymentIntentId } : {}),
        },
        create: {
          providerId: provider.id,
          payload: data.payload,
          headers: '{}',
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
    async enqueueWebhookNotification() {},
  }

  const route = loadTsModule<{ POST: (request: Request, ctx: any) => Promise<Response> }>(
    'src/app/api/webhooks/[provider]/route.ts',
    {
      [srcPath('lib/db.ts')]: { db },
      '@/lib/data': dataStub,
      '@/lib/payments': paymentsStub,
      '@/lib/reconcile-payments': {
        async flushPendingNotificationsForPayment() {
          return 0
        },
        async reconcileSinglePaymentById() {
          return { status: 'processing', transitioned: false }
        },
      },
      '@/lib/tenant-credentials': {
        async resolveTenantOrPlatformCredentials() {
          return {
            credentials: {
              apiKey: 'tenant-livepay-api-key',
              accountNo: '256700000000',
              webhookSecret: 'tenant-livepay-secret-0123456789',
              baseUrl: 'https://livepay.me',
            },
          }
        },
      },
      '@/lib/application-auth': {
        webhookSecretFromRow: () => 'church-outbound-secret',
        fallbackSigningSecretsFromRow: () => [CHURCH_API_KEY],
      },
    }
  )

  return { POST: route.POST, db, completePaymentCalls }
}

function signedDelivery(body: Record<string, unknown>) {
  const timestamp = Date.now()
  const params: Record<string, string> = {
    customer_reference: String(body.customer_reference ?? ''),
    internal_reference: String(body.internal_reference ?? ''),
    status: String(body.status ?? ''),
  }
  let stringToSign = `${GATEWAY}/api/webhooks/livepay${timestamp}`
  for (const key of Object.keys(params).sort()) stringToSign += `${key}${params[key]}`
  const signature = crypto.createHmac('sha256', TENANT_SECRET).update(stringToSign, 'utf8').digest('hex')
  return `t=${timestamp},v=${signature}`
}

function buildRequest(body: Record<string, unknown>) {
  return new Request(`${GATEWAY}/api/webhooks/livepay`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.77',
      'x-webhook-signature': signedDelivery(body),
    },
  })
}

test('provider fee: a fee-bearing LivePay delivery SETTLES the 17,000 intent (production regression)', async () => {
  const harness = loadRoute()
  const body = {
    customer_reference: 'CHURCH-ACC-82A982D1-E1121A6875',
    internal_reference: 'c14be48a-3590-46af-af1d-3106c6aa1862',
    status: 'SUCCESSFUL',
    amount: 17510,
    charge: 510,
    currency: 'UGX',
  }

  const response = await harness.POST(buildRequest(body), {
    params: Promise.resolve({ provider: 'livepay' }),
  })

  assert.equal(response.status, 200, 'a valid, fully paid delivery must not be refused for its fee')
  assert.equal(harness.completePaymentCalls.length, 1)

  const call = harness.completePaymentCalls[0]
  assert.equal(call.status, 'success')
  // The ledger is credited the INTENT amount, never the gross.
  assert.equal(call.amount, 17000)

  assert.equal(harness.db.rows.paymentTransaction.length, 0, 'nothing should be recorded as disputed')
  const log = harness.db.rows.webhookLog[0]
  assert.equal(log.processed, true)
  assert.equal(log.processingError ?? null, null)
})

test('provider fee: a delivery whose net does not equal the intent is STILL refused and recorded', async () => {
  const harness = loadRoute()
  const body = {
    customer_reference: 'CHURCH-ACC-82A982D1-E1121A6875',
    internal_reference: 'c14be48a-3590-46af-af1d-3106c6aa1862',
    status: 'SUCCESSFUL',
    amount: 17510,
    charge: 1510,
    currency: 'UGX',
  }

  const response = await harness.POST(buildRequest(body), {
    params: Promise.resolve({ provider: 'livepay' }),
  })

  assert.equal(response.status, 422)
  assert.equal(harness.completePaymentCalls.length, 0)

  const dispute = harness.db.rows.paymentTransaction[0]
  assert.equal(dispute.status, 'disputed')
  assert.match(dispute.note, /AMOUNT_MISMATCH/)
  assert.match(dispute.note, /net 16000/)

  const log = harness.db.rows.webhookLog[0]
  assert.match(log.processingError, /AMOUNT_MISMATCH expected=17000 reported=17510 charge=1510 net=16000/)
})
