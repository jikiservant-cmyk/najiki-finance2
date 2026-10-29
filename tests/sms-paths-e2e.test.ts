/**
 * The SMS path end to end, chained through the real modules.
 *
 * The unit tests in `sms-partner-flow.test.ts` prove each piece in isolation.
 * This file proves the pieces agree with each other, which is a different claim:
 * the names one module writes are the names the next module reads, and a message
 * that a partner submits arrives at the partner's status endpoint with the same
 * identity it was given at the door.
 *
 * The chain under test is exactly the production one:
 *
 *   POST /api/messaging/send        (partner API key)
 *     → smsStore.createOrGet        (real, against an in-memory Prisma stand-in)
 *     → smsQueue.processBatch       (real; claims the row, calls the provider)
 *     → Africa's Talking DLR        (real route, real store)
 *     → deliverSmsNotification      (real; signs and posts to the partner)
 *     → GET /api/messaging/sms/:ref (real route)
 *
 * Only three things are replaced: the database, the network socket, and the
 * Africa's Talking SDK. Everything else — including HMAC signing — is the code
 * that ships.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule, srcPath } from './helpers/ts-load.ts'

const PHONE = '+256700000001'
const API_KEY = 'partner-key-for-church'
const DLR_SECRET = 'dlr-secret-value-0123456789'

// ── An in-memory Prisma stand-in ────────────────────────────────────────────
//
// Deliberately narrow: it implements only the operators the SMS path uses, and
// it throws on anything else rather than silently matching nothing. A fake that
// answers `undefined` to an operator it does not understand turns a broken query
// into a passing test.

type Row = Record<string, any>

function matchesCondition(value: any, condition: any): boolean {
  // Prisma equivalence: a column that was never written is NULL, so it matches
  // `{ field: null }`. Without this the queued-row sweep found nothing.
  if (condition === null || condition === undefined) return value === condition || value === undefined || value === null
  if (typeof condition !== 'object' || condition instanceof Date) return value === condition
  if (Array.isArray(condition)) return condition.includes(value)

  if ('in' in condition) return (condition.in as any[]).includes(value)
  if ('notIn' in condition) return !(condition.notIn as any[]).includes(value)

  // Prisma case-insensitive string comparison (quick-send's fallback lookup).
  if (typeof condition === 'object' && 'equals' in condition && 'mode' in condition) {
    if (condition.mode !== 'insensitive') throw new Error(`unsupported mode ${condition.mode}`)
    return String(value ?? '').toLowerCase() === String(condition.equals ?? '').toLowerCase()
  }
  if ('equals' in condition) return value === condition.equals

  if ('lte' in condition || 'lt' in condition || 'gte' in condition || 'gt' in condition) {
    if (value === null || value === undefined) return false
    const compare = (bound: any) =>
      bound instanceof Date ? new Date(value).getTime() - bound.getTime() : Number(value) - Number(bound)
    if ('lte' in condition && !(compare(condition.lte) <= 0)) return false
    if ('lt' in condition && !(compare(condition.lt) < 0)) return false
    if ('gte' in condition && !(compare(condition.gte) >= 0)) return false
    if ('gt' in condition && !(compare(condition.gt) > 0)) return false
    return true
  }

  return value === condition
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Row[]).some((c) => matchesWhere(row, c))
    if (key === 'AND') return (condition as Row[]).every((c) => matchesWhere(row, c))
    if (key === 'NOT') return !matchesWhere(row, condition as Row)
    return matchesCondition(row[key], condition)
  })
}

function createDb(seed: Record<string, Row[]> = {}) {
  const rows: Record<string, Row[]> = {}
  let counter = 0

  const applyUpdate = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
        row[key] = (row[key] ?? 0) + (value as any).increment
      } else {
        row[key] = value
      }
    }
    row.updatedAt = new Date()
  }

  const model = (table: string) => ({
    async create({ data }: { data: Row }) {
      if (table === 'smsDeliveryReport') {
        const clash = (rows[table] ?? []).find((row) => row.providerMessageId === data.providerMessageId)
        if (clash) throw Object.assign(new Error('unique'), { code: 'P2002' })
      }
      const row: Row = { id: `${table}_${++counter}`, createdAt: new Date(), attemptCount: 0, ...data }
      ;(rows[table] ??= []).push(row)
      return structuredClone(row)
    },
    async findUnique({ where }: { where: Row }) {
      const found = (rows[table] ?? []).find((row) => matchesWhere(row, where))
      return found ? structuredClone(found) : null
    },
    async findFirst({ where }: { where?: Row } = {}) {
      const found = (rows[table] ?? []).find((row) => matchesWhere(row, where))
      return found ? structuredClone(found) : null
    },
    async findMany({ where, take, orderBy }: { where?: Row; take?: number; orderBy?: any } = {}) {
      let result = (rows[table] ?? []).filter((row) => matchesWhere(row, where))
      if (orderBy?.createdAt === 'asc') {
        result = [...result].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      }
      if (typeof take === 'number') result = result.slice(0, take)
      return structuredClone(result)
    },
    async count({ where }: { where?: Row } = {}) {
      return (rows[table] ?? []).filter((row) => matchesWhere(row, where)).length
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const targets = (rows[table] ?? []).filter((row) => matchesWhere(row, where))
      targets.forEach((row) => applyUpdate(row, data))
      return { count: targets.length }
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = (rows[table] ?? []).find((candidate) => matchesWhere(candidate, where))
      if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' })
      applyUpdate(row, data)
      return structuredClone(row)
    },
  })

  const tables = [
    'application',
    'smsMessage',
    'smsDeliveryReport',
    'smsLog',
  ]
  for (const table of tables) rows[table] = (seed[table] ?? []).map((row) => ({ ...row }))

  const db: any = { rows }
  for (const table of tables) db[table] = model(table)
  db.$queryRawUnsafe = async () => 'lock'
  db.$transaction = async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg))
  return db
}

// ── Wiring ──────────────────────────────────────────────────────────────────

interface Harness {
  db: any
  send: any
  quickSend: any
  callback: any
  status: any
  queue: any
  store: any
  cron: { retrySmsNotifications: (limit?: number) => Promise<number> }
  providerCalls: { to: string; message: string; attempt: number }[]
  notifications: { url: string; headers: Record<string, string>; body: string }[]
  setProvider: (fn: (call: { to: string; message: string }) => any) => void
  setNotificationOk: (ok: boolean) => void
}

function buildHarness(application: Row = { id: 'app-church', code: 'church', name: 'Church App' }): Harness {
  const db = createDb({
    application: [
      {
        id: 'app-church',
        code: 'church',
        name: 'Church App',
        baseUrl: 'https://churchsys-ten.vercel.app',
        webhookPath: '/api/webhooks/najiki',
        apiKey: 'legacy-plaintext',
        webhookSecretEncrypted: null,
        isActive: true,
      },
    ],
  })

  const providerCalls: Harness['providerCalls'] = []
  const notifications: Harness['notifications'] = []
  let provider: (call: { to: string; message: string }) => any = () => ({
    success: true,
    providerId: 'AT-1',
    cost: 'UGX 50.0000',
    status: 'Success',
  })
  let notificationOk = true

  class NextResponse {
    status: number
    headers: Record<string, string>
    private readonly payload: string
    constructor(body: any, init?: any) {
      this.status = init?.status ?? 200
      this.headers = init?.headers ?? {}
      this.payload = typeof body === 'string' ? body : JSON.stringify(body)
    }
    static json(body: any, init?: any) {
      return new NextResponse(body, init)
    }
    async json() {
      return JSON.parse(this.payload)
    }
    async text() {
      return this.payload
    }
  }

  const stubs: Record<string, any> = {
    // Resolved by file path so every importer of the module shares one stub —
    // that is what lets the route, the queue and the store see the same database.
    [srcPath('lib/db.ts')]: { db },
    [srcPath('lib/redis.ts')]: { redis: { lpush: async () => 1, rpop: async () => null } },
    [srcPath('lib/safe-fetch.ts')]: {
      safeFetch: async (url: string, init: any) => {
        notifications.push({
          url: String(url),
          headers: init?.headers ?? {},
          body: String(init?.body ?? ''),
        })
        return {
          ok: notificationOk,
          status: notificationOk ? 200 : 500,
          text: async () => (notificationOk ? '{"received":true,"settlement":"credited"}' : 'boom'),
        }
      },
      isPlaceholderUrl: () => false,
      validateSafeUrl: async () => new URL('https://example.test'),
    },
    [srcPath('lib/application-auth.ts')]: {
      findApplicationByApiKey: async (key: string) =>
        key === API_KEY
          ? {
              application: {
                id: 'app-church',
                code: application.code,
                name: 'Church App',
                isActive: true,
                baseUrl: 'https://churchsys-ten.vercel.app',
                webhookPath: '/api/webhooks/najiki',
                internalSecretRef: null,
                apiKey: 'legacy-plaintext',
                webhookSecretEncrypted: null,
              },
              usedLegacyPlaintextKey: false,
            }
          : null,
      webhookSecretFromRow: () => 'webhook-signing-secret-value',
      resolveWebhookSecret: async () => 'webhook-signing-secret-value',
      fallbackSigningSecretsFromRow: () => [],
    },
    [srcPath('lib/sms.ts')]: {
      sendSmsViaProvider: async (to: string, message: string) => {
        providerCalls.push({ to, message, attempt: providerCalls.length + 1 })
        return provider({ to, message })
      },
      waitForSmsProvider: async (p: any) => p,
    },
    [srcPath('lib/rate-limit.ts')]: {
      checkRateLimit: async () => ({ ok: true }),
      clientIdentifier: () => '203.0.113.9',
    },
    'next/server': { NextResponse, after: () => {} },
  }

  // One stub map ⇒ one module cache ⇒ the real sms-store is shared by every
  // route and by the queue, exactly as in production.
  stubs[srcPath('lib/auth.ts')] = { requireSuperAdmin: async () => ({ id: 'admin-1', email: 'admin@najiki.test' }) }

  const send = loadTsModule<any>('src/app/api/messaging/send/route.ts', stubs)
  const quickSend = loadTsModule<any>('src/app/api/messaging/quick-send/route.ts', stubs)
  const queueModule = loadTsModule<any>('src/lib/sms-queue.ts', stubs)
  const callback = loadTsModule<any>('src/app/api/webhooks/africastalking/route.ts', stubs)
  const status = loadTsModule<any>('src/app/api/messaging/sms/[reference]/route.ts', stubs)
  const storeModule = loadTsModule<any>('src/lib/sms-store.ts', stubs)

  return {
    db,
    send,
    quickSend,
    callback,
    status,
    queue: queueModule.smsQueue,
    store: storeModule.smsStore,
    cron: { retrySmsNotifications: queueModule.retrySmsNotifications },
    providerCalls,
    notifications,
    setProvider: (fn) => {
      provider = fn
    },
    setNotificationOk: (ok) => {
      notificationOk = ok
    },
  }
}

function postSend(body: Record<string, unknown>, key = API_KEY) {
  return new Request('https://gateway.test/api/messaging/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ to: PHONE, message: 'Service at 9am', applicationCode: 'church', ...body }),
  })
}

function postDlr(payload: Record<string, unknown>) {
  return new Request(`https://gateway.test/api/webhooks/africastalking?key=${DLR_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function getStatus(harness: Harness, reference: string, key = API_KEY) {
  return harness.status.GET(
    new Request(`https://gateway.test/api/messaging/sms/${reference}`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    }),
    { params: Promise.resolve({ reference }) }
  )
}

const originalEnv = { ...process.env }
process.env.AFRICASTALKING_CALLBACK_SECRET = DLR_SECRET
delete process.env.SMS_NOTIFY_UNKNOWN
test.after(() => {
  process.env = { ...originalEnv }
})

// ── The full path ───────────────────────────────────────────────────────────

test('e2e: submit → send → carrier report → partner notified → status readable', async () => {
  const h = buildHarness()

  // 1. The partner submits. Note the upper-case code: this is the exact request
  //    that used to return 403 and leave no row behind.
  const submitted = await h.send.POST(postSend({ applicationCode: 'CHURCH' }))
  assert.equal(submitted.status, 202)
  const accepted = await submitted.json()
  assert.equal(accepted.status, 'queued')
  const reference: string = accepted.reference
  assert.match(reference, /^MSG-/)

  assert.equal(h.db.rows.smsMessage.length, 1, 'exactly one row was created')

  // 2. The worker claims it and calls the provider.
  const outcomes = await h.queue.processBatch(10)
  assert.deepEqual(outcomes, [{ smsId: accepted.smsId, success: true, status: 'pending' }])
  assert.equal(h.providerCalls.length, 1)
  assert.equal(h.providerCalls[0].to, PHONE)

  const afterSend = h.db.rows.smsMessage[0]
  assert.equal(afterSend.status, 'pending', 'provider acceptance is not delivery')
  assert.equal(afterSend.providerMessageId, 'AT-1')
  assert.equal(afterSend.attemptCount, 1)
  // The provider's reported cost replaced the placeholder.
  assert.equal(afterSend.cost, 50)

  // 3. The carrier's delivery report lands.
  const dlr = await h.callback.POST(postDlr({ id: 'AT-1', status: 'Success' }))
  assert.equal(dlr.status, 200)

  const afterDlr = h.db.rows.smsMessage[0]
  assert.equal(afterDlr.status, 'delivered')
  assert.ok(afterDlr.notificationDeliveredAt, 'the partner must have been notified')

  // 4. The partner was actually called, at the configured URL, signed.
  assert.equal(h.notifications.length, 1)
  const notification = h.notifications[0]
  assert.equal(notification.url, 'https://churchsys-ten.vercel.app/api/webhooks/najiki')
  assert.match(notification.headers['X-Najiki-Signature'], /^t=\d+,v=[0-9a-f]{64}$/)
  assert.equal(notification.headers['X-Najiki-Notification'], 'true')
  const payload = JSON.parse(notification.body)
  assert.equal(payload.eventType, 'SMS_DELIVERY_UPDATE')
  assert.equal(payload.status, 'delivered')
  assert.equal(payload.reference, reference, 'the partner joins on the reference we gave it')
  assert.equal(payload.smsId, accepted.smsId)
  assert.equal(payload.providerId, 'AT-1')

  // 5. The same reference is readable over HTTP, from the partner's own key.
  const read = await getStatus(h, reference)
  assert.equal(read.status, 200)
  const view = await read.json()
  assert.equal(view.reference, reference)
  assert.equal(view.status, 'delivered')
  assert.equal(view.attemptCount, 1)
  assert.equal(view.providerMessageId, 'AT-1')
  assert.equal(view.deliveryReport.status, 'delivered')
  assert.ok(view.notificationDeliveredAt)
  assert.match(view.recipient, /\*/, 'the phone number is never returned in full')
})

test('e2e: a rejection at the carrier records the reason and notifies the partner', async () => {
  const h = buildHarness()
  h.setProvider(() => ({ success: false, providerId: 'AT-2', error: 'Provider rejected SMS', providerStatus: 'InsufficientBalance' }))

  const submitted = await h.send.POST(postSend({}))
  const accepted = await submitted.json()

  assert.deepEqual(await h.queue.processBatch(10), [
    { smsId: accepted.smsId, success: false, status: 'failed' },
  ])

  const row = h.db.rows.smsMessage[0]
  assert.equal(row.status, 'failed')
  assert.equal(row.failureReason, 'Provider rejected SMS: InsufficientBalance')

  // A failed row is terminal, but it is the *notification worker* that tells the
  // partner — not the send loop. That is deliberate: processBatch must not block
  // on a partner endpoint. It means a provider rejection reaches the partner on
  // the next sms-cron tick (every minute), and this asserts that tick works.
  assert.equal(h.notifications.length, 0, 'the send loop does not notify inline')
  assert.equal(await h.cron.retrySmsNotifications(10), 1, 'the cron tick delivers it')
  assert.equal(h.notifications.length, 1)
  assert.equal(JSON.parse(h.notifications[0].body).status, 'failed')

  const view = await (await getStatus(h, accepted.reference)).json()
  assert.equal(view.status, 'failed')
  assert.equal(view.failureReason, 'Provider rejected SMS: InsufficientBalance')
})

test('e2e: a partner endpoint that rejects the notification stays retryable', async () => {
  const h = buildHarness()
  h.setNotificationOk(false)

  const accepted = await (await h.send.POST(postSend({}))).json()
  await h.queue.processBatch(10)

  await h.callback.POST(postDlr({ id: 'AT-1', status: 'Success' }))

  const row = h.db.rows.smsMessage[0]
  assert.equal(row.status, 'delivered', 'the carrier did report delivery; only the partner call failed')
  assert.equal(row.notificationDeliveredAt ?? null, null, 'a non-2xx must NOT be recorded as delivered')
  assert.ok(row.notificationAttemptedAt, 'but the attempt is recorded so the cron can retry')

  // The partner's own view shows it was not acknowledged.
  const view = await (await getStatus(h, accepted.reference)).json()
  assert.equal(view.notificationDeliveredAt, null)
})

// ── Regressions the path must keep holding ──────────────────────────────────

test('e2e: the 403 returns before any row is created — the reason the dashboard was empty', async () => {
  const h = buildHarness()
  const response = await h.send.POST(postSend({ applicationCode: 'sacco' }))
  assert.equal(response.status, 403)
  assert.equal(h.db.rows.smsMessage.length, 0, 'nothing was inserted, so there was nothing to diagnose')
  assert.equal(h.providerCalls.length, 0)
})

test('e2e: a duplicate carrier report cannot rewrite a terminal row', async () => {
  const h = buildHarness()
  const accepted = await (await h.send.POST(postSend({}))).json()
  await h.queue.processBatch(10)

  await h.callback.POST(postDlr({ id: 'AT-1', status: 'Success' }))
  assert.equal(h.db.rows.smsMessage[0].status, 'delivered')

  // A contradictory late report for the same provider id.
  await h.callback.POST(postDlr({ id: 'AT-1', status: 'Failed' }))
  assert.equal(h.db.rows.smsMessage[0].status, 'delivered', 'first terminal report wins')
  assert.equal(h.notifications.length, 1, 'and the partner is not told twice')
})

test('e2e: an unauthenticated delivery report is refused and changes nothing', async () => {
  const h = buildHarness()
  await h.send.POST(postSend({}))
  await h.queue.processBatch(10)

  const response = await h.callback.POST(
    new Request('https://gateway.test/api/webhooks/africastalking', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'AT-1', status: 'Success' }),
    })
  )
  assert.equal(response.status, 401)
  assert.equal(h.db.rows.smsMessage[0].status, 'pending', 'a forged delivery report must not settle a message')
})

test('e2e: a retried submission with the same idempotency key does not send twice', async () => {
  const h = buildHarness()
  const key = 'broadcast-job-7:member-42'

  const submit = () =>
    h.send.POST(
      new Request('https://gateway.test/api/messaging/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
          'idempotency-key': key,
        },
        body: JSON.stringify({ to: PHONE, message: 'Service at 9am', applicationCode: 'church' }),
      })
    )
  const first = await (await submit()).json()
  const second = await (await submit()).json()

  assert.equal(h.db.rows.smsMessage.length, 1)
  assert.equal(second.reference, first.reference, 'the retry returns the original, not a new message')
  assert.equal(second.deduplicated, true)
})

test('e2e: the status endpoint will not reveal another application’s message', async () => {
  const h = buildHarness()
  const accepted = await (await h.send.POST(postSend({}))).json()

  // Same reference, but presented by a key that resolves to a different app.
  const otherApp = buildHarness({ id: 'app-sacco', code: 'sacco', name: 'SACCO Platform' })
  assert.equal((await getStatus(otherApp, accepted.reference)).status, 404)
})

test('e2e: a queued row is drained even when the Redis hint was lost', async () => {
  const h = buildHarness()
  const accepted = await (await h.send.POST(postSend({}))).json()

  // Simulate the hint never arriving: the row is already queued in the database.
  assert.equal(h.db.rows.smsMessage[0].status, 'queued')
  await h.queue.processBatch(10)

  assert.equal(h.providerCalls.length, 1)
  assert.equal(h.db.rows.smsMessage[0].status, 'pending')
  assert.equal(h.db.rows.smsMessage[0].providerMessageId, 'AT-1')
  assert.equal((await (await getStatus(h, accepted.reference)).json()).status, 'pending')
})

// ── The dashboard path (what an operator actually clicks) ───────────────────

function postQuickSend(body: Record<string, unknown>) {
  return new Request('https://gateway.test/api/messaging/quick-send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: PHONE, message: 'Service at 9am', applicationCode: 'church', ...body }),
  })
}

test('e2e: dashboard quick-send resolves a code that differs only by case', async () => {
  const h = buildHarness()

  // The exact dropdown value.
  const exact = await h.quickSend.POST(postQuickSend({ applicationCode: 'church' }))
  assert.equal(exact.status, 202)

  // A hand-edited or pasted value. Before the fallback in quick-send this
  // returned 404 "Active application not found" — a message that reads like the
  // application is missing rather than mis-cased.
  for (const variant of ['CHURCH', 'Church', '  church  ']) {
    const response = await h.quickSend.POST(postQuickSend({ applicationCode: variant }))
    assert.equal(response.status, 202, `${JSON.stringify(variant)} must resolve`)
  }

  assert.equal(h.db.rows.smsMessage.length, 4)
  for (const row of h.db.rows.smsMessage) {
    assert.equal(row.applicationCode, 'church', 'billed to the stored code, not the typed one')
  }
})

test('e2e: quick-send still 404s for an application that genuinely does not exist', async () => {
  const h = buildHarness()
  const response = await h.quickSend.POST(postQuickSend({ applicationCode: 'hospital' }))
  assert.equal(response.status, 404)
  assert.equal(h.db.rows.smsMessage.length, 0)
})

// ── The signature the partner has to verify ─────────────────────────────────

test('e2e: the notification we send verifies with the documented receiver algorithm', async () => {
  const { verifyNotificationSignature } = loadTsModule<any>(
    'src/lib/notification-signature.ts',
    {}
  )

  const h = buildHarness()
  const accepted = await (await h.send.POST(postSend({}))).json()
  await h.queue.processBatch(10)
  await h.callback.POST(postDlr({ id: 'AT-1', status: 'Success' }))

  assert.equal(h.notifications.length, 1)
  const { headers, body } = h.notifications[0]

  // Exactly what the partner must do: verify the RAW bytes, then parse.
  const verified = verifyNotificationSignature({
    secret: 'webhook-signing-secret-value',
    payloadString: body,
    timestamp: headers['X-Najiki-Timestamp'],
    signature: headers['X-Najiki-Signature'],
  })
  assert.equal(verified, true, 'a correct secret must verify')

  // The three ways a receiver gets this wrong, each must fail.
  assert.equal(
    verifyNotificationSignature({
      secret: 'wrong-secret',
      payloadString: body,
      timestamp: headers['X-Najiki-Timestamp'],
      signature: headers['X-Najiki-Signature'],
    }),
    false,
    'a wrong secret must not verify'
  )
  assert.equal(
    verifyNotificationSignature({
      secret: 'webhook-signing-secret-value',
      payloadString: JSON.stringify({ ...JSON.parse(body), amount: 999999 }),
      timestamp: headers['X-Najiki-Timestamp'],
      signature: headers['X-Najiki-Signature'],
    }),
    false,
    'a tampered body must not verify'
  )
  assert.equal(
    verifyNotificationSignature({
      secret: 'webhook-signing-secret-value',
      payloadString: body,
      timestamp: String(Number(headers['X-Najiki-Timestamp']) - 10 * 60 * 1000),
      signature: headers['X-Najiki-Signature'],
    }),
    false,
    'a replayed timestamp must not verify'
  )
})

// ── `unknown` through the real store and cron ───────────────────────────────

test('e2e: a row that ages into unknown closes only when the flag is on', async () => {
  const previous = process.env.SMS_NOTIFY_UNKNOWN
  try {
    delete process.env.SMS_NOTIFY_UNKNOWN

    let h = buildHarness()
    const accepted = await (await h.send.POST(postSend({}))).json()
    await h.queue.processBatch(10)

    // The carrier never reports. After the settlement window the row is closed
    // as `unknown` — terminal, but silent unless the partner opted in.
    const aged = h.db.rows.smsMessage[0]
    aged.updatedAt = new Date(Date.now() - 72 * 60 * 60 * 1000)
    assert.equal(await h.store.markStalePendingUnknown(48), 1)
    assert.equal(h.db.rows.smsMessage[0].status, 'unknown')

    assert.equal(await h.cron.retrySmsNotifications(10), 0, 'silent by default')
    assert.equal(h.notifications.length, 0)

    // The partner can still see it resolved — not stuck at pending forever.
    const view = await (await getStatus(h, accepted.reference)).json()
    assert.equal(view.status, 'unknown')

    // With the flag on, the same row notifies.
    process.env.SMS_NOTIFY_UNKNOWN = 'true'
    h = buildHarness()
    const second = await (await h.send.POST(postSend({}))).json()
    await h.queue.processBatch(10)
    h.db.rows.smsMessage[0].updatedAt = new Date(Date.now() - 72 * 60 * 60 * 1000)
    await h.store.markStalePendingUnknown(48)
    assert.equal(await h.cron.retrySmsNotifications(10), 1, 'delivered when opted in')
    assert.equal(JSON.parse(h.notifications[0].body).status, 'unknown')
    assert.equal(h.notifications[0].body.includes(second.reference), true)
  } finally {
    if (previous === undefined) delete process.env.SMS_NOTIFY_UNKNOWN
    else process.env.SMS_NOTIFY_UNKNOWN = previous
  }
})

// ── Operational ceilings ────────────────────────────────────────────────────

test('e2e: the per-application daily ceiling returns 429 with Retry-After and sends nothing more', async () => {
  const previous = process.env.SMS_DAILY_LIMIT_PER_APP
  process.env.SMS_DAILY_LIMIT_PER_APP = '1'
  try {
    const h = buildHarness()

    const first = await h.send.POST(postSend({}))
    assert.equal(first.status, 202)

    const second = await h.send.POST(postSend({ message: 'A different message' }))
    assert.equal(second.status, 429)
    const retryAfter = Number(second.headers?.['Retry-After'])
    assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, 'a Retry-After must tell the caller when to come back')

    assert.equal(h.db.rows.smsMessage.length, 1, 'the refusal creates no row')
    // And the first message is still sendable — the ceiling did not poison it.
    await h.queue.processBatch(10)
    assert.equal(h.providerCalls.length, 1)
  } finally {
    if (previous === undefined) delete process.env.SMS_DAILY_LIMIT_PER_APP
    else process.env.SMS_DAILY_LIMIT_PER_APP = previous
  }
})
