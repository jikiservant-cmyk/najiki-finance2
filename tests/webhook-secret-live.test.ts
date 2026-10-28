/**
 * "Does the signing secret actually work?" — tested the only way that answers
 * the question: a real signed HTTP request to a real endpoint that runs a real
 * verifier, and a second request with a deliberately wrong key.
 *
 * A local `sign(); verify()` pair proves nothing about the Church app's copy of
 * the secret. These tests therefore stand up an independent verifier on a
 * socket — no code shared with the gateway, written from the published contract:
 *
 *     X-Najiki-Timestamp: <ms>
 *     X-Najiki-Signature: t=<ms>,v=<hex hmac-sha256(secret, `${ms}.${rawBody}`)>
 *
 * and assert what the partner would conclude:
 *
 *   • a delivery signed with the secret the dashboard reveals is accepted, so
 *     "copy this value into the Church app" is a true instruction;
 *   • a wrong key is refused — and if it is NOT refused, the test says so
 *     instead of reporting success;
 *   • a rotation really revokes the old secret;
 *   • no key ever appears in the request, the response, or the dashboard.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { createFakeDb, type Row } from './helpers/fake-db.ts'
import { loadTsModule, srcPath } from './helpers/ts-load.ts'

process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64)
process.env.NEXTAUTH_URL = 'https://gateway.najiki.test'

const SIGNING_SECRET = 'njk_whsec_church_go_live_secret_4f19a'
const OTHER_SECRET = 'njk_whsec_someone_elses_secret_7c02b'
const CHURCH_BASE_URL = 'https://church.najiki.app'
const CHURCH_WEBHOOK_PATH = '/api/webhooks/najiki'
const CHURCH_WEBHOOK_URL = `${CHURCH_BASE_URL}${CHURCH_WEBHOOK_PATH}`

const { encrypt } = loadTsModule<{ encrypt: (value: string) => string }>('src/lib/encryption.ts', {})
const { webhookSecretFromRow } = loadTsModule<any>('src/lib/application-auth.ts', {
  [srcPath('lib/db.ts')]: { db: {} },
})
const realSafeFetchModule = loadTsModule<any>('src/lib/safe-fetch.ts', {})

// ── The partner's verifier, implemented independently ───────────────────────

type Received = {
  path: string
  body: string
  headers: http.IncomingHttpHeaders
  verifiedWith?: string | null
  reason?: string
}

type Receiver = {
  url: string
  received: Received[]
  close: () => Promise<void>
}

type ReceiverOptions = {
  /** Secrets this endpoint accepts. Empty ⇒ it does not verify at all. */
  secrets?: string[]
  /** Forces a status code, for the failure-classification cases. */
  forceStatus?: number
}

function verifyLikeChurch(
  rawBody: string,
  headers: http.IncomingHttpHeaders,
  secrets: string[]
): { ok: boolean; secret?: string; reason?: string } {
  const signature = String(headers['x-najiki-signature'] ?? '')
  const timestampHeader = String(headers['x-najiki-timestamp'] ?? '')
  const match = /^t=(\d+),v=([0-9a-f]{64})$/.exec(signature)
  if (!match) return { ok: false, reason: 'malformed-signature-header' }
  if (match[1] !== timestampHeader) return { ok: false, reason: 'timestamp-header-mismatch' }

  const signedAt = Number(match[1])
  if (Math.abs(Date.now() - signedAt) > 5 * 60 * 1000) {
    return { ok: false, reason: 'outside-replay-window' }
  }

  for (const secret of secrets) {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${signedAt}.${rawBody}`)
      .digest('hex')
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) {
      return { ok: true, secret }
    }
  }
  return { ok: false, reason: 'signature-mismatch' }
}

async function startReceiver(options: ReceiverOptions = {}): Promise<Receiver> {
  const received: Received[] = []
  const secrets = options.secrets ?? []

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const record: Received = { path: req.url ?? '', body, headers: req.headers }
    received.push(record)

    if (options.forceStatus) {
      res.writeHead(options.forceStatus, { 'content-type': 'application/json' }).end('{"forced":true}')
      return
    }

    // No secrets configured: the endpoint answers 200 without looking at the
    // signature. This is the dangerous case the bad-signature test must catch.
    if (secrets.length === 0) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}')
      return
    }

    const verdict = verifyLikeChurch(body, req.headers, secrets)
    record.verifiedWith = verdict.secret ?? null
    record.reason = verdict.reason
    if (!verdict.ok) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: verdict.reason }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }

  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// ── Loading the real code under test ────────────────────────────────────────

/**
 * `safeFetch` is redirected at the socket only: the SSRF/placeholder guard is
 * still the real one, so the "blocked" verdicts below are genuine refusals.
 */
function socketSafeFetch(receiver: Receiver) {
  return async (input: any, init?: any): Promise<Response> => {
    const original = typeof input === 'string' ? input : input.url
    return fetch(original.replace(CHURCH_BASE_URL, receiver.url), init)
  }
}

function loadSelfTest(receiver: Receiver) {
  return loadTsModule<any>('src/lib/webhook-selftest.ts', {
    [srcPath('lib/safe-fetch.ts')]: {
      ...realSafeFetchModule,
      safeFetch: socketSafeFetch(receiver),
    },
  })
}

// ── The two requests, against a real verifier ───────────────────────────────

test('live secret: a delivery signed with the stored secret is ACCEPTED by a real verifier', async (t) => {
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { runWebhookSelfTest } = loadSelfTest(receiver)

  const result = await runWebhookSelfTest({
    applicationCode: 'church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    secret: SIGNING_SECRET,
    mode: 'valid',
  })

  assert.equal(result.verdict, 'accepted')
  assert.equal(result.ok, true)
  assert.equal(result.statusCode, 200)
  assert.equal(result.sent, true)
  assert.equal(result.locallyValid, true)

  // The partner's independent verifier says the signature matched THIS secret.
  assert.equal(receiver.received.length, 1)
  assert.equal(receiver.received[0].path, CHURCH_WEBHOOK_PATH)
  assert.equal(receiver.received[0].verifiedWith, SIGNING_SECRET)
  assert.equal(receiver.received[0].headers['x-najiki-notification'], 'true')
  assert.equal(receiver.received[0].headers['x-najiki-test'], 'true')

  // The body is a test, not a payment anyone could credit.
  const sent = JSON.parse(receiver.received[0].body)
  assert.equal(sent.event, 'webhook.test')
  assert.equal(sent.test, true)
  assert.equal(sent.paymentIntentId, undefined)
})

test('live secret: the signing key never travels in the request', async (t) => {
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { runWebhookSelfTest } = loadSelfTest(receiver)

  const result = await runWebhookSelfTest({
    applicationCode: 'church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    secret: SIGNING_SECRET,
    mode: 'valid',
  })

  const wire = JSON.stringify({
    headers: receiver.received[0].headers,
    body: receiver.received[0].body,
  })
  assert.equal(wire.includes(SIGNING_SECRET), false, 'the HMAC key must never be on the wire')

  // Nor in the browser payload: only t=…,v=… is shown, which is not a credential.
  const toBrowser = JSON.stringify(result)
  assert.equal(toBrowser.includes(SIGNING_SECRET), false)
  assert.match(result.signature, /^t=\d{13},v=[0-9a-f]{64}$/)
})

test('live secret: a wrong key is REFUSED by a real verifier (so the pass above means something)', async (t) => {
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { runWebhookSelfTest } = loadSelfTest(receiver)

  const result = await runWebhookSelfTest({
    applicationCode: 'church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    secret: SIGNING_SECRET,
    mode: 'invalid',
  })

  assert.equal(result.verdict, 'rejected-as-expected')
  assert.equal(result.ok, true)
  assert.equal(result.statusCode, 401)
  // We really did send a bad signature — not a broken header that would fail
  // for the wrong reason.
  assert.equal(result.locallyValid, false)
  assert.equal(receiver.received[0].reason, 'signature-mismatch')
  assert.match(result.headline, /verifies the signature/)
})

test('live secret: an endpoint that does not verify is reported as a finding, not a pass', async (t) => {
  // Accepts everything without looking at the signature — a real and common
  // state for a partner integration that was never finished.
  const receiver = await startReceiver({ secrets: [] })
  t.after(() => receiver.close())
  const { runWebhookSelfTest } = loadSelfTest(receiver)

  const result = await runWebhookSelfTest({
    applicationCode: 'church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    secret: SIGNING_SECRET,
    mode: 'invalid',
  })

  assert.equal(result.verdict, 'signature-not-checked')
  assert.equal(result.ok, false, 'a 2xx to a forged signature must never be a pass')
  assert.match(result.headline, /not verifying/)
  assert.match(result.detail, /forged|fake/)
  assert.ok(result.nextSteps.some((step) => /reject/i.test(step)))
})

test('live secret: the Church app holding a different secret shows up as signature-rejected', async (t) => {
  const receiver = await startReceiver({ secrets: [OTHER_SECRET] })
  t.after(() => receiver.close())
  const { runWebhookSelfTest } = loadSelfTest(receiver)

  const result = await runWebhookSelfTest({
    applicationCode: 'church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    secret: SIGNING_SECRET,
    mode: 'valid',
  })

  assert.equal(result.verdict, 'signature-rejected')
  assert.equal(result.ok, false)
  assert.equal(result.statusCode, 401)
  assert.match(result.detail, /a different secret/)
  assert.ok(result.nextSteps.some((step) => /NAJIKI_WEBHOOK_SECRET/.test(step)))
})

test('live secret: HTTP failures are classified, not lumped together', async (t) => {
  const cases: Array<{ status: number; verdict: string }> = [
    { status: 404, verdict: 'endpoint-missing' },
    { status: 405, verdict: 'endpoint-missing' },
    { status: 429, verdict: 'rate-limited' },
    { status: 500, verdict: 'endpoint-error' },
    { status: 503, verdict: 'endpoint-error' },
  ]

  for (const item of cases) {
    const receiver = await startReceiver({ forceStatus: item.status })
    try {
      const { runWebhookSelfTest } = loadSelfTest(receiver)
      const result = await runWebhookSelfTest({
        applicationCode: 'church',
        webhookUrl: CHURCH_WEBHOOK_URL,
        secret: SIGNING_SECRET,
        mode: 'valid',
      })
      assert.equal(result.verdict, item.verdict, `HTTP ${item.status}`)
      assert.equal(result.statusCode, item.status)
      assert.equal(result.ok, false)
    } finally {
      await receiver.close()
    }
  }
})

test('live secret: a placeholder host is refused before a socket is opened', async (t) => {
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { runWebhookSelfTest } = loadSelfTest(receiver)

  const result = await runWebhookSelfTest({
    applicationCode: 'church',
    webhookUrl: 'https://church.yourdomain.com/api/internal/payment-completed',
    secret: SIGNING_SECRET,
    mode: 'valid',
  })

  assert.equal(result.verdict, 'blocked')
  assert.equal(result.sent, false)
  assert.equal(result.ok, false)
  assert.match(result.detail, /placeholder/)
  assert.equal(receiver.received.length, 0)
})

test('live secret: with no secret stored there is nothing to test, and it says how to fix it', async (t) => {
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { runWebhookSelfTest } = loadSelfTest(receiver)

  const result = await runWebhookSelfTest({
    applicationCode: 'church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    secret: null,
    mode: 'valid',
  })

  assert.equal(result.verdict, 'blocked')
  assert.equal(result.sent, false)
  assert.ok(result.nextSteps.some((step) => /Rotate the webhook secret/.test(step)))
})

// ── Through the dashboard API, end to end ───────────────────────────────────

function churchApplication(overrides: Row = {}): Row {
  return {
    id: 'app_church',
    code: 'church',
    name: 'Church App',
    baseUrl: CHURCH_BASE_URL,
    webhookPath: CHURCH_WEBHOOK_PATH,
    apiKey: null,
    apiKeyHash: 'sha256-of-the-app-key',
    apiKeyHint: 'abcd',
    webhookSecretEncrypted: encrypt(SIGNING_SECRET),
    internalSecretRef: '',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    tenants: [],
    paymentTypes: [],
    ...overrides,
  }
}

type SetupRoute = {
  GET: () => Promise<Response>
  POST: (request: Request) => Promise<Response>
}

function loadSetupRoute(receiver: Receiver, seed: Row[] = [churchApplication()]) {
  const db = createFakeDb({
    application: seed,
    provider: [],
    tenantProviderConfig: [],
    tenant: [],
  })

  const route = loadTsModule<SetupRoute>('src/app/api/setup/route.ts', {
    [srcPath('lib/db.ts')]: { db },
    [srcPath('lib/safe-fetch.ts')]: {
      ...realSafeFetchModule,
      safeFetch: socketSafeFetch(receiver),
    },
    '@/lib/auth': {
      requireSuperAdmin: async () => ({ id: 'admin_1', role: 'super_admin' }),
    },
  })

  return { route, db }
}

function post(body: unknown): Request {
  return new Request('https://gateway.najiki.test/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('dashboard: the secret REVEALED on the page is the one the partner accepts', async (t) => {
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { route } = loadSetupRoute(receiver)

  const revealed = await route.POST(post({ type: 'revealWebhookSecret', data: { id: 'app_church' } }))
  assert.equal(revealed.status, 200)
  const { webhookSecret } = await revealed.json()
  assert.equal(webhookSecret, SIGNING_SECRET)

  // Whatever the operator copied is what the test signs with — that is the
  // promise the dashboard makes when it says "copy this into the Church app".
  const response = await route.POST(post({ type: 'sendTestWebhook', data: { id: 'app_church' } }))
  assert.equal(response.status, 200)
  const result: any = await response.json()

  assert.equal(result.verdict, 'accepted')
  assert.equal(result.ok, true)
  assert.equal(receiver.received[0].verifiedWith, webhookSecret)
})

test('dashboard: sendTestWebhook never returns the key, only the signature', async (t) => {
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { route } = loadSetupRoute(receiver)

  const response = await route.POST(post({ type: 'sendTestWebhook', data: { id: 'app_church' } }))
  const serialized = JSON.stringify(await response.json())

  assert.equal(serialized.includes(SIGNING_SECRET), false)
  assert.equal(serialized.includes('webhookSecretEncrypted'), false)
  assert.match(serialized, /"signature":"t=\d+,v=[0-9a-f]{64}"/)
})

test('dashboard: the bad-signature test through the API distinguishes verifying from not', async (t) => {
  const verifying = await startReceiver({ secrets: [SIGNING_SECRET] })
  const careless = await startReceiver({ secrets: [] })
  t.after(() => Promise.all([verifying.close(), careless.close()]))

  const good = loadSetupRoute(verifying).route
  const bad = loadSetupRoute(careless).route

  const goodResult: any = await (
    await good.POST(post({ type: 'sendTestWebhook', data: { id: 'app_church', mode: 'invalid' } }))
  ).json()
  assert.equal(goodResult.verdict, 'rejected-as-expected')
  assert.equal(goodResult.ok, true)

  const badResult: any = await (
    await bad.POST(post({ type: 'sendTestWebhook', data: { id: 'app_church', mode: 'invalid' } }))
  ).json()
  assert.equal(badResult.verdict, 'signature-not-checked')
  assert.equal(badResult.ok, false)
})

test('dashboard: rotating the secret really revokes the old one', async (t) => {
  // Two receivers: one configured with the secret the Church app holds today,
  // one configured with the new one after rotation. The old secret must stop
  // being accepted everywhere, or "rotate" is just "issue another key".
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { route, db } = loadSetupRoute(receiver)

  const rotated: any = await (
    await route.POST(post({ type: 'rotateApplication', data: { id: 'app_church', rotateWebhookSecret: true } }))
  ).json()
  assert.match(rotated.webhookSecret, /^njk_whsec_/)

  const newSecret = webhookSecretFromRow(db.rows.application[0])
  assert.equal(newSecret, rotated.webhookSecret, 'the stored secret is the rotated one')

  // Signed with the new secret, against a verifier updated to accept it.
  const updatedReceiver = await startReceiver({ secrets: [newSecret] })
  t.after(() => updatedReceiver.close())
  const afterRotation = loadSelfTest(updatedReceiver)
  const accepted = await afterRotation.runWebhookSelfTest({
    applicationCode: 'church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    secret: newSecret,
    mode: 'valid',
  })
  assert.equal(accepted.verdict, 'accepted')

  // Signed with the secret the partner still has, against a verifier updated to
  // the new one: refused. This is what "rotated" has to mean.
  const stale = await afterRotation.runWebhookSelfTest({
    applicationCode: 'church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    secret: SIGNING_SECRET,
    mode: 'valid',
  })
  assert.equal(stale.verdict, 'signature-rejected')
  assert.equal(stale.statusCode, 401)
})

test('dashboard: the test refuses to run for an application with no usable secret', async (t) => {
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { route } = loadSetupRoute(receiver, [churchApplication({ webhookSecretEncrypted: null })])

  const response = await route.POST(post({ type: 'sendTestWebhook', data: { id: 'app_church' } }))
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /Rotate the webhook secret/)
  assert.equal(receiver.received.length, 0, 'nothing may be sent unsigned')
})

test('dashboard: an unknown application and a bad mode are rejected, not guessed at', async (t) => {
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())
  const { route } = loadSetupRoute(receiver)

  const missing = await route.POST(post({ type: 'sendTestWebhook', data: { id: 'app_nope' } }))
  assert.equal(missing.status, 404)

  const invalidMode = await route.POST(
    post({ type: 'sendTestWebhook', data: { id: 'app_church', mode: 'sometimes' } })
  )
  assert.equal(invalidMode.status, 400)
  assert.equal(receiver.received.length, 0)
})

test('dashboard: a REAL settlement notification verifies with the secret the page reveals', async (t) => {
  // The self-test proves the test path signs correctly. This proves the same
  // secret verifies an actual settlement delivery, produced by the real
  // payments code — otherwise "the test passed" could mean the test signs
  // differently from production, which is the one thing a self-test must not do.
  const receiver = await startReceiver({ secrets: [SIGNING_SECRET] })
  t.after(() => receiver.close())

  const { route } = loadSetupRoute(receiver)
  const revealed: any = await (
    await route.POST(post({ type: 'revealWebhookSecret', data: { id: 'app_church' } }))
  ).json()

  const db = createFakeDb({
    application: [churchApplication()],
    internalNotification: [
      {
        id: 'notif_1',
        paymentIntentId: 'pi_church_1',
        applicationId: 'app_church',
        url: CHURCH_WEBHOOK_URL,
        payload: '{}',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 5,
        lastAttemptAt: null,
        nextRetryAt: new Date(),
        lastResponseStatus: null,
        lastResponseBody: null,
      },
    ],
    tenant: [{ id: 'tenant_grace', code: 'grace-church', name: 'Grace Community Church' }],
    webhookLog: [],
  })

  const payments = loadTsModule<any>('src/lib/payments.ts', {
    [srcPath('lib/db.ts')]: { db },
    [srcPath('lib/tenant-credentials.ts')]: { resolveTenantOrPlatformCredentials: async () => null },
    [srcPath('lib/application-auth.ts')]: {
      webhookSecretFromRow,
      fallbackSigningSecretsFromRow: () => [],
    },
    [srcPath('lib/safe-fetch.ts')]: {
      ...realSafeFetchModule,
      safeFetch: socketSafeFetch(receiver),
    },
  })

  await payments.enqueueWebhookNotification({
    paymentIntentId: 'pi_church_1',
    reference: 'CHURCH-0001',
    status: 'success',
    amount: 20000,
    currency: 'UGX',
    providerPaymentId: 'LP_TX_9001',
    applicationId: 'app_church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    webhookSecret: webhookSecretFromRow(db.rows.application[0]),
    externalEntityId: 'member_42',
    tenantId: 'tenant_grace',
    tenantCode: 'grace-church',
    paymentTypeCode: 'tithe',
    metadata: { paymentTypeCode: 'tithe' },
  })

  assert.equal(receiver.received.length, 1)
  assert.equal(
    receiver.received[0].verifiedWith,
    revealed.webhookSecret,
    'the payment notification must verify with the secret the dashboard hands out'
  )
  assert.equal(JSON.parse(receiver.received[0].body).status, 'success')
})
