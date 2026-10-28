/**
 * Outbound webhooks — the hop FROM this gateway TO the Church app
 * (`POST {church baseUrl}{webhookPath}`, i.e. `/api/webhooks/najiki`).
 *
 * This is the half of the integration the church actually experiences, and the
 * half that cannot be exercised by a unit test of a pure function: it is a real
 * HTTP request, with a real HMAC header, to a real server.
 *
 * So a real HTTP server runs here, in the shape of the church's verifier: it
 * checks the timestamped signature the way the published contract says to check
 * it, and answers 200 / 401 / 500 on demand. The gateway's own delivery code
 * (`enqueueWebhookNotification`, `deliverQueuedNotification`, the legacy-path
 * self-heal, the fallback-secret retry and the retry bookkeeping) is the real
 * implementation — only Prisma and the socket's destination are stubbed.
 *
 * What is asserted, in terms of a go-live:
 *
 *   • the church can verify every notification with its stored secret,
 *   • the payload carries the tenant and payment-type attribution it needs,
 *   • a 401 falls back to the application API key, a 5xx schedules a retry,
 *     and a 404 on the legacy path self-heals instead of losing the event,
 *   • an unconfigured placeholder URL is refused permanently *and visibly*,
 *   • a captured delivery cannot be replayed and no secret ever travels in a header.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { createFakeDb, type Row } from './helpers/fake-db.ts'
import { loadTsModule, srcPath } from './helpers/ts-load.ts'

const CHURCH_WEBHOOK_SECRET = 'church-outbound-webhook-secret'
const CHURCH_API_KEY = 'church_api_key_abcdefghijklmnop'
const CHURCH_BASE_URL = 'https://church.test'
const CHURCH_WEBHOOK_PATH = '/api/webhooks/najiki'
const CHURCH_WEBHOOK_URL = `${CHURCH_BASE_URL}${CHURCH_WEBHOOK_PATH}`

const application: Row = {
  id: 'app_church',
  code: 'church',
  name: 'Church App',
  baseUrl: CHURCH_BASE_URL,
  webhookPath: CHURCH_WEBHOOK_PATH,
  apiKey: CHURCH_API_KEY,
  webhookSecretEncrypted: null,
  internalSecretRef: null,
}

// ── The church's side of the contract ───────────────────────────────────────

type RecordedRequest = {
  path: string
  method: string
  headers: http.IncomingHttpHeaders
  body: string
}

type ChurchOptions = {
  /** Secrets the church will accept, most preferred first. */
  secrets: string[]
  /** Override the reply for /api/webhooks/najiki. */
  mode?: 'ok' | 'always401' | 'error500'
}

/**
 * A deliberately independent implementation of the documented verification
 * scheme — no code is shared with the gateway, so a divergence between what we
 * send and what a partner is told to expect shows up as a failure here.
 *
 *   X-Najiki-Timestamp: <ms>
 *   X-Najiki-Signature: t=<ms>,v=<hex hmac-sha256(secret, `${ms}.${rawBody}`)>
 */
function churchVerify(
  rawBody: string,
  headers: http.IncomingHttpHeaders,
  secrets: string[],
  now: number = Date.now()
): { ok: boolean; reason?: string; secretIndex?: number } {
  const signature = String(headers['x-najiki-signature'] ?? '')
  const timestampHeader = String(headers['x-najiki-timestamp'] ?? '')

  const match = /^t=(\d+),v=([0-9a-f]{64})$/.exec(signature)
  if (!match) return { ok: false, reason: 'malformed-signature-header' }
  if (match[1] !== timestampHeader) return { ok: false, reason: 'timestamp-header-mismatch' }

  const signedAt = Number(match[1])
  if (Math.abs(now - signedAt) > 5 * 60 * 1000) return { ok: false, reason: 'outside-replay-window' }

  for (let index = 0; index < secrets.length; index++) {
    const expected = crypto
      .createHmac('sha256', secrets[index])
      .update(`${signedAt}.${rawBody}`)
      .digest('hex')
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) {
      return { ok: true, secretIndex: index }
    }
  }
  return { ok: false, reason: 'signature-mismatch' }
}

type ChurchApp = {
  url: string
  requests: RecordedRequest[]
  setMode: (mode: ChurchOptions['mode']) => void
  close: () => Promise<void>
}

async function startChurchApp(options: ChurchOptions): Promise<ChurchApp> {
  const requests: RecordedRequest[] = []
  let mode = options.mode ?? 'ok'

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')

    requests.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers, body })

    // The legacy path the seeder still writes. A 404 here is what makes the
    // gateway's self-heal path observable.
    if ((req.url ?? '').startsWith('/api/internal/payment-completed')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found')
      return
    }

    if (req.url !== CHURCH_WEBHOOK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found')
      return
    }

    if (mode === 'error500') {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'boom' }))
      return
    }

    if (mode === 'always401') {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad signature' }))
      return
    }

    const verdict = churchVerify(body, req.headers, options.secrets)
    if (!verdict.ok) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'bad signature', reason: verdict.reason }))
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ received: true }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setMode: (next) => {
      mode = next
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// ── Gateway harness ─────────────────────────────────────────────────────────

type GatewayHarness = {
  payments: any
  db: any
}

/**
 * Load the real delivery code with Prisma and the socket destination stubbed.
 *
 * `safeFetch` is replaced by one that rewrites the church's hostname to the
 * local server. The SSRF guard itself still runs (against the real
 * implementation), which is why the tests below can assert that loopback,
 * link-local and placeholder targets are refused — those checks happen before
 * the rewrite could ever be reached.
 */
function loadGateway(churchApp: ChurchApp, seed: Record<string, Row[]>): GatewayHarness {
  const db = createFakeDb(seed)
  const realSafeFetch = loadTsModule<{ validateSafeUrl: (url: string) => Promise<URL> }>(
    'src/lib/safe-fetch.ts',
    {}
  )

  const socketFetch = async (input: any, init?: any): Promise<Response> => {
    const original = typeof input === 'string' ? input : input.url
    const rewritten = original.replace(`https://church.test`, churchApp.url)
    return fetch(rewritten, init)
  }

  const payments = loadTsModule<any>('src/lib/payments.ts', {
    [srcPath('lib/db.ts')]: { db },
    [srcPath('lib/tenant-credentials.ts')]: {
      resolveTenantOrPlatformCredentials: async () => null,
    },
    [srcPath('lib/application-auth.ts')]: {
      webhookSecretFromRow: (row: Row) => (row?.webhookSecret ?? CHURCH_WEBHOOK_SECRET),
      fallbackSigningSecretsFromRow: (row: Row) => (row?.apiKey ? [row.apiKey] : []),
    },
    [srcPath('lib/safe-fetch.ts')]: {
      safeFetch: socketFetch,
      validateSafeUrl: realSafeFetch.validateSafeUrl,
    },
  })

  return { payments, db }
}

function notificationRow(overrides: Row = {}): Row {
  return {
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
    ...overrides,
  }
}

function intentRow(overrides: Row = {}): Row {
  return {
    id: 'pi_church_1',
    reference: 'CHURCH-0001',
    amount: 20000,
    currency: 'UGX',
    status: 'success',
    providerPaymentId: 'LP_TX_9001',
    failureReason: null,
    applicationId: 'app_church',
    tenantId: 'tenant_grace',
    externalEntityId: 'member_42',
    metadata: JSON.stringify({ paymentTypeCode: 'tithe' }),
    ...overrides,
  }
}

function baseSeed(options: { applicationRow?: Row; notification?: Row } = {}): Record<string, Row[]> {
  return {
    application: [options.applicationRow ?? application],
    paymentIntent: [intentRow()],
    internalNotification: [options.notification ?? notificationRow()],
    tenant: [{ id: 'tenant_grace', code: 'grace-church', name: 'Grace Community Church' }],
    webhookLog: [],
  }
}

type EnqueueArgs = Parameters<any>[0]

function enqueueArgs(overrides: Record<string, any> = {}) {
  return {
    paymentIntentId: 'pi_church_1',
    reference: 'CHURCH-0001',
    status: 'success',
    amount: 20000,
    currency: 'UGX',
    providerPaymentId: 'LP_TX_9001',
    failureReason: null,
    applicationId: 'app_church',
    webhookUrl: CHURCH_WEBHOOK_URL,
    webhookSecret: CHURCH_WEBHOOK_SECRET,
    fallbackWebhookSecret: CHURCH_API_KEY,
    externalEntityId: 'member_42',
    tenantId: 'tenant_grace',
    tenantCode: 'grace-church',
    paymentTypeCode: 'tithe',
    metadata: { paymentTypeCode: 'tithe' },
    ...overrides,
  } as any
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('webhook(hop 2): the church verifies the notification signature and receives a 200', async () => {
  const church = await startChurchApp({ secrets: [CHURCH_WEBHOOK_SECRET] })
  try {
    const { payments, db } = loadGateway(church, baseSeed())

    await payments.enqueueWebhookNotification(enqueueArgs())

    assert.equal(church.requests.length, 1, 'exactly one delivery to the church')
    const delivered = church.requests[0]
    assert.equal(delivered.path, CHURCH_WEBHOOK_PATH)
    assert.equal(delivered.method, 'POST')

    const verdict = churchVerify(delivered.body, delivered.headers, [CHURCH_WEBHOOK_SECRET])
    assert.equal(verdict.ok, true, `partner verification failed: ${verdict.reason}`)

    // The row records the real outcome, so /api/webhooks can show it afterwards.
    const row = db.rows.internalNotification[0]
    assert.equal(row.status, 'delivered')
    assert.equal(row.lastResponseStatus, 200)
    assert.match(row.lastResponseBody, /received/)
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): the signed payload carries the tenant, payment type and money the church needs', async () => {
  const church = await startChurchApp({ secrets: [CHURCH_WEBHOOK_SECRET] })
  try {
    const { payments } = loadGateway(church, baseSeed())
    await payments.enqueueWebhookNotification(enqueueArgs())

    const payload = JSON.parse(church.requests[0].body)

    assert.equal(payload.reference, 'CHURCH-0001')
    assert.equal(payload.status, 'success')
    assert.equal(payload.amount, 20000)
    assert.equal(payload.currency, 'UGX')
    assert.equal(payload.providerPaymentId, 'LP_TX_9001')
    assert.equal(payload.tenantId, 'tenant_grace')
    assert.equal(payload.tenantCode, 'grace-church')
    assert.equal(payload.paymentType, 'tithe')
    assert.equal(payload.paymentTypeCode, 'tithe')
    assert.equal(payload.externalEntityId, 'member_42')
    assert.equal(payload.failureReason, null)
    assert.deepEqual(payload.metadata, { paymentTypeCode: 'tithe' })

    for (const key of ['paymentIntentId', 'reference', 'status', 'amount', 'currency', 'providerPaymentId', 'tenantCode', 'paymentTypeCode']) {
      assert.ok(key in payload, `payload must include ${key}`)
    }
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): no secret is ever placed in a header, and the marker identifies the sender', async () => {
  const church = await startChurchApp({ secrets: [CHURCH_WEBHOOK_SECRET] })
  try {
    const { payments } = loadGateway(church, baseSeed())
    await payments.enqueueWebhookNotification(enqueueArgs())

    const { headers } = church.requests[0]
    assert.equal(headers['x-najiki-notification'], 'true')
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['authorization'], undefined, 'the signing secret must never travel in a header')

    const serializedHeaders = JSON.stringify(headers)
    assert.equal(serializedHeaders.includes(CHURCH_WEBHOOK_SECRET), false)
    assert.equal(serializedHeaders.includes(CHURCH_API_KEY), false)
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): a captured delivery cannot be replayed later or with a modified body', async () => {
  const church = await startChurchApp({ secrets: [CHURCH_WEBHOOK_SECRET] })
  try {
    const { payments } = loadGateway(church, baseSeed())
    await payments.enqueueWebhookNotification(enqueueArgs())

    const { body, headers } = church.requests[0]

    assert.equal(churchVerify(body, headers, [CHURCH_WEBHOOK_SECRET]).ok, true)
    assert.equal(
      churchVerify(body.replace('20000', '900000'), headers, [CHURCH_WEBHOOK_SECRET]).ok,
      false,
      'a modified body must not verify'
    )
    assert.equal(
      churchVerify(body, headers, [CHURCH_WEBHOOK_SECRET], Date.now() + 10 * 60 * 1000).ok,
      false,
      'the same delivery must not verify ten minutes later'
    )
    assert.equal(churchVerify(body, headers, ['some-other-secret']).ok, false)
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): the legacy seeded path self-heals to /api/webhooks/najiki instead of losing the event', async () => {
  const church = await startChurchApp({ secrets: [CHURCH_WEBHOOK_SECRET] })
  try {
    const { payments, db } = loadGateway(
      church,
      baseSeed({
        applicationRow: {
          ...application,
          baseUrl: CHURCH_BASE_URL,
          webhookPath: '/api/internal/payment-completed',
        },
      })
    )

    await payments.enqueueWebhookNotification(
      enqueueArgs({ webhookUrl: `${CHURCH_BASE_URL}/api/internal/payment-completed` })
    )

    assert.equal(church.requests.length, 2, 'the legacy attempt, then the healed one')
    assert.equal(church.requests[0].path, '/api/internal/payment-completed')
    assert.equal(church.requests[1].path, CHURCH_WEBHOOK_PATH)

    const healed = church.requests[1]
    assert.equal(churchVerify(healed.body, healed.headers, [CHURCH_WEBHOOK_SECRET]).ok, true)
    assert.equal(db.rows.internalNotification[0].status, 'delivered')
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): a 401 from the church retries with the application API key and succeeds', async () => {
  // The church deployment verifies with NAJIKI_API_KEY, not with the generated
  // webhook secret — a documented fallback, since partners existed first.
  const church = await startChurchApp({ secrets: [CHURCH_API_KEY] })
  try {
    const { payments, db } = loadGateway(church, baseSeed())

    await payments.enqueueWebhookNotification(
      enqueueArgs({
        webhookSecret: 'a-secret-the-church-does-not-know',
        fallbackWebhookSecret: CHURCH_API_KEY,
        fallbackWebhookSecrets: [CHURCH_API_KEY],
      })
    )

    assert.equal(church.requests.length, 2, 'primary attempt, one 401, then the fallback secret')
    assert.equal(db.rows.internalNotification[0].status, 'delivered')

    const final = church.requests[1]
    const verdict = churchVerify(final.body, final.headers, [CHURCH_API_KEY])
    assert.equal(verdict.ok, true, 'the fallback signature must verify with the API key')
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): a 5xx schedules a retry with backoff instead of dropping the event', async () => {
  const church = await startChurchApp({ secrets: [CHURCH_WEBHOOK_SECRET], mode: 'error500' })
  try {
    const { payments, db } = loadGateway(church, baseSeed())
    await payments.enqueueWebhookNotification(enqueueArgs())

    const row = db.rows.internalNotification[0]
    assert.equal(row.status, 'failed_retrying')
    assert.equal(row.attemptCount, 1)
    assert.equal(row.lastResponseStatus, 500)
    assert.ok(row.nextRetryAt instanceof Date, 'a retry must be scheduled')
    assert.match(row.lastResponseBody, /HTTP 500/)
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): an unconfigured placeholder URL is refused permanently — and never retried', async () => {
  const church = await startChurchApp({ secrets: [CHURCH_WEBHOOK_SECRET] })
  try {
    // This is the value scripts/seed.ts writes for the church app. If it is
    // still in the database on go-live, every notification is refused here.
    const { payments, db } = loadGateway(
      church,
      baseSeed({
        applicationRow: { ...application, baseUrl: 'https://church.yourdomain.com' },
      })
    )

    await payments.enqueueWebhookNotification(
      enqueueArgs({ webhookUrl: 'https://church.yourdomain.com/api/internal/payment-completed' })
    )

    assert.equal(church.requests.length, 0, 'an unconfigured placeholder domain must never be contacted')
    const row = db.rows.internalNotification[0]
    assert.equal(row.status, 'failed_exhausted')
    assert.match(row.lastResponseBody, /placeholder/i)
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): the cron retry path re-signs with the application secret and the resolved URL', async () => {
  const church = await startChurchApp({ secrets: [CHURCH_WEBHOOK_SECRET] })
  try {
    const { payments, db } = loadGateway(church, baseSeed())

    const outcome = await payments.deliverQueuedNotification(
      {
        id: 'notif_1',
        url: CHURCH_WEBHOOK_URL,
        payload: JSON.stringify({ reference: 'CHURCH-0001', status: 'success' }),
        applicationId: 'app_church',
      },
      {}
    )

    assert.equal(outcome.success, true)
    assert.equal(outcome.statusCode, 200)
    assert.equal(church.requests.length, 1)
    assert.equal(
      churchVerify(church.requests[0].body, church.requests[0].headers, [CHURCH_WEBHOOK_SECRET]).ok,
      true
    )
    // deliverQueuedNotification reports the outcome; the caller (cron worker)
    // owns the retry bookkeeping, so the row is deliberately untouched here.
    assert.equal(db.rows.internalNotification[0].status, 'pending')
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): a stored URL pointing at cloud metadata is refused without any request', async () => {
  const church = await startChurchApp({ secrets: [CHURCH_WEBHOOK_SECRET] })
  try {
    const { payments } = loadGateway(
      church,
      baseSeed({
        applicationRow: { ...application, baseUrl: 'http://169.254.169.254', webhookPath: '/latest/meta-data/' },
      })
    )

    const outcome = await payments.deliverQueuedNotification({
      id: 'notif_1',
      url: 'http://169.254.169.254/latest/meta-data/',
      payload: '{}',
      applicationId: 'app_church',
    })

    assert.equal(outcome.success, false)
    assert.match(outcome.error, /Unsafe webhook URL/)
    assert.equal(church.requests.length, 0)
  } finally {
    await church.close()
  }
})

test('webhook(hop 2): the SSRF guard refuses loopback, private ranges and placeholder domains', async () => {
  const { validateSafeUrl } = loadTsModule<{ validateSafeUrl: (url: string) => Promise<URL> }>(
    'src/lib/safe-fetch.ts',
    {}
  )

  const refused = [
    'http://127.0.0.1/api/webhooks/najiki',
    'http://localhost:3000/api/webhooks/najiki',
    'http://10.1.2.3/api/webhooks/najiki',
    'http://192.168.0.10/api/webhooks/najiki',
    'http://169.254.169.254/latest/meta-data/',
    'https://church.yourdomain.com/api/webhooks/najiki',
    'https://example.com/api/webhooks/najiki',
    'file:///etc/passwd',
  ]

  for (const url of refused) {
    await assert.rejects(() => validateSafeUrl(url), `must refuse ${url}`)
  }

  // A real public host is what a church deployment looks like.
  const allowed = await validateSafeUrl('https://church.najiki.app/api/webhooks/najiki')
  assert.equal(allowed.hostname, 'church.najiki.app')
})

test('webhook(hop 2): SSRF guard gap — bracketed IPv6 literals are not recognised as IP literals', async () => {
  // `URL.hostname` keeps the brackets, and `net.isIP('[::1]')` is 0, so the
  // literal check is skipped and these fall through to the DNS branch (which
  // fails open, because an unresolvable host is tolerated). They are therefore
  // accepted today. This test pins the *current* behaviour so a fix is a
  // deliberate change rather than a surprise; the guard's intent is to refuse
  // them, and webhook URLs are only settable by a super admin.
  const { validateSafeUrl } = loadTsModule<{ validateSafeUrl: (url: string) => Promise<URL> }>(
    'src/lib/safe-fetch.ts',
    {}
  )

  for (const url of ['http://[::1]/x', 'http://[::ffff:169.254.169.254]/x', 'http://[fd00::1]/x']) {
    const parsed = await validateSafeUrl(url)
    assert.ok(parsed instanceof URL, `${url} is currently accepted (see finding W-3)`)
  }
})
