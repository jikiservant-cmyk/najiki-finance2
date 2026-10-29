/**
 * The partner SMS path: sending, per-message status, and what happens when
 * Africa's Talking rejects a message.
 *
 * Every assertion here maps to a defect observed in production on 2026-10-28:
 *
 *   • `403 Application code mismatch` for a partner that sent `CHURCH` while the
 *     stored code is `church` — the SMS never reached the queue at all, which is
 *     why the messaging dashboard showed no failed messages to investigate;
 *   • rows stuck at `pending` with `failure_reason` set to a constant string, so
 *     `InvalidSenderId`, `InsufficientBalance` and a provider outage were
 *     indistinguishable;
 *   • no way to ask about one message, making a broadcast untrackable for
 *     anything that did not produce a terminal webhook.
 *
 * The route modules are loaded through the repository's own shim so the real
 * handler runs; only the database, the queue and the network are replaced.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule, srcPath } from './helpers/ts-load.ts'
import {
  SmsInputSchema,
  applicationCodeMatches,
  smsNotifyUnknownEnabled,
} from '../src/lib/sms-policy.ts'
import { maskRecipient } from '../src/lib/recipient-mask.ts'

const PHONE = '+256700000001'

// ── Application code matching ───────────────────────────────────────────────

test('application code matching tolerates the casing and whitespace a partner actually sends', () => {
  // The stored code is lower-case (`church`, `sacco`). References are displayed
  // upper-case because generateReference() upper-cases the app prefix, so
  // `CHURCH` is the value a partner naturally copies out of one.
  for (const provided of ['church', 'CHURCH', 'Church', ' church ', 'CHURCH\n', '\tchurch']) {
    assert.equal(applicationCodeMatches('church', provided), true, `${JSON.stringify(provided)} must match "church"`)
  }

  // Also normalised on the stored side, in case a row was created by hand.
  assert.equal(applicationCodeMatches(' Church ', 'church'), true)
  assert.equal(applicationCodeMatches('CHURCH', 'church'), true)

  // A genuinely different application is still rejected.
  assert.equal(applicationCodeMatches('church', 'sacco'), false)
  assert.equal(applicationCodeMatches('church', 'church-app'), false)
  assert.equal(applicationCodeMatches('', 'church'), false)

  // Omitted keeps its historical meaning: the API key alone identifies the app.
  assert.equal(applicationCodeMatches('church', undefined), true)
  assert.equal(applicationCodeMatches('church', null), true)
  assert.equal(applicationCodeMatches('church', ''), true)
})

test('the send schema trims applicationCode before it can reach the comparison', () => {
  const parsed = SmsInputSchema.safeParse({ to: PHONE, message: 'hi', applicationCode: '  church \n' })
  assert.equal(parsed.success, true)
  assert.equal((parsed as any).data.applicationCode, 'church')
  // Whitespace-only is rejected rather than silently treated as "omitted".
  assert.equal(SmsInputSchema.safeParse({ to: PHONE, message: 'hi', applicationCode: '   ' }).success, false)
})

// ── POST /api/messaging/send ────────────────────────────────────────────────

function sendRouteHarness(options: { storedCode?: string } = {}) {
  const created: any[] = []
  const enqueued: string[] = []

  class SmsDailyLimitError extends Error {}
  class SmsIdempotencyConflictError extends Error {}

  const SmsInputSchemaReal = SmsInputSchema

  const route = loadTsModule<any>('src/app/api/messaging/send/route.ts', {
    'next/server': {
      NextResponse: {
        json: (body: any, init?: any) => ({
          status: init?.status ?? 200,
          body,
          json: async () => body,
        }),
      },
      after: () => {},
    },
    '@/lib/sms-store': {
      smsStore: {
        createOrGet: async (params: any) => {
          created.push(params)
          return {
            sms: { id: 'sms_1', reference: 'MSG-TEST-1', status: 'queued', createdAt: new Date().toISOString() },
            created: true,
          }
        },
      },
      SMS_COST_PLACEHOLDER: 50,
      SmsDailyLimitError,
      SmsIdempotencyConflictError,
    },
    '@/lib/sms-queue': { smsQueue: { enqueue: async (id: string) => { enqueued.push(id) }, processBatch: async () => [] } },
    '@/lib/rate-limit': {
      checkRateLimit: async () => ({ ok: true }),
      clientIdentifier: () => '203.0.113.9',
    },
    '@/lib/application-auth': {
      findApplicationByApiKey: async (key: string) =>
        key === 'partner-key'
          ? {
              application: {
                id: 'app-church',
                code: options.storedCode ?? 'church',
                name: 'Church App',
                baseUrl: 'https://church.example',
                webhookPath: '/api/webhooks/najiki',
                webhookSecretEncrypted: null,
                apiKey: null,
              },
              usedLegacyPlaintextKey: false,
            }
          : null,
    },
    '@/lib/sms-policy': {
      SmsInputSchema: SmsInputSchemaReal,
      MAX_SMS_BODY_BYTES: 8 * 1024,
      resolveSmsDailyLimit: () => 10_000,
      applicationCodeMatches,
      smsNotifyUnknownEnabled,
    },
  })

  return { route, created, enqueued }
}

function postSend(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('http://gateway.test/api/messaging/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer partner-key', ...headers },
    body: JSON.stringify({ to: PHONE, message: 'Sunday service at 9am', ...body }),
  })
}

test('send: an upper-case application code now queues instead of returning 403', async () => {
  const h = sendRouteHarness()
  for (const code of ['CHURCH', 'Church', ' church ']) {
    const response = await h.route.POST(postSend({ applicationCode: code }))
    assert.equal(response.status, 202, `${JSON.stringify(code)} must be accepted`)
    const body = await response.json()
    assert.equal(body.success, true)
  }
  // Accepted, and billed to the stored code — not to what the caller typed.
  assert.equal(h.created.length, 3)
  assert.equal(h.created[0].applicationCode, 'church')
  assert.deepEqual(h.enqueued, ['sms_1', 'sms_1', 'sms_1'])
})

test('send: omitting applicationCode still works, and a wrong app is still refused', async () => {
  const h = sendRouteHarness()

  const omitted = await h.route.POST(postSend({}))
  assert.equal(omitted.status, 202)

  const wrong = await h.route.POST(postSend({ applicationCode: 'sacco' }))
  assert.equal(wrong.status, 403)
  const body = await wrong.json()
  // The message must name the expected code: "mismatch" alone is undebuggable.
  assert.match(body.error, /church/)
  assert.equal(body.expected, 'church')

  // Only the accepted attempt was queued.
  assert.equal(h.created.length, 1)
})

test('send: an unknown API key is still a 401 and never reaches the code check', async () => {
  const h = sendRouteHarness()
  const response = await h.route.POST(postSend({}, { authorization: 'Bearer wrong-key' }))
  assert.equal(response.status, 401)
  assert.equal(h.created.length, 0)
})

// ── GET /api/messaging/sms/:reference ───────────────────────────────────────

function statusRouteHarness(rows: any[], report: any = null) {
  const route = loadTsModule<any>('src/app/api/messaging/sms/[reference]/route.ts', {
    'next/server': {
      NextResponse: {
        json: (body: any, init?: any) => ({
          status: init?.status ?? 200,
          body,
          json: async () => body,
        }),
      },
    },
    '@/lib/db': {
      db: {
        smsMessage: {
          findFirst: async ({ where }: any) =>
            rows.find((row) => row.reference === where.reference && row.applicationId === where.applicationId) ?? null,
        },
        smsDeliveryReport: { findUnique: async () => report },
      },
    },
    '@/lib/application-auth': {
      findApplicationByApiKey: async (key: string) =>
        key === 'partner-key' ? { application: { id: 'app-church', code: 'church' }, usedLegacyPlaintextKey: false } : null,
    },
    '@/lib/recipient-mask': { maskRecipient },
    '@/lib/rate-limit': { checkRateLimit: async () => ({ ok: true }) },
  })
  return route
}

const SMS_ROW = {
  id: 'sms_1',
  reference: 'MSG-1',
  applicationId: 'app-church',
  applicationCode: 'church',
  recipient: PHONE,
  status: 'pending',
  providerCode: 'africastalking',
  providerMessageId: 'AT-123',
  attemptCount: 2,
  failureReason: null,
  cost: 50,
  createdAt: new Date('2026-10-28T20:26:00Z'),
  updatedAt: new Date('2026-10-28T20:27:00Z'),
  notificationDeliveredAt: null,
}

function getStatus(route: any, reference: string, key = 'partner-key') {
  return route.GET(
    new Request(`http://gateway.test/api/messaging/sms/${reference}`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    }),
    { params: Promise.resolve({ reference }) }
  )
}

test('status read: answers for the application that owns the message', async () => {
  const route = statusRouteHarness([SMS_ROW])
  const response = await getStatus(route, 'MSG-1')
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.reference, 'MSG-1')
  assert.equal(body.status, 'pending')
  // The three facts that were previously invisible outside the database.
  assert.equal(body.providerMessageId, 'AT-123')
  assert.equal(body.attemptCount, 2)
  assert.equal(body.deliveryReport, null)
  // Never the full number.
  assert.notEqual(body.recipient, PHONE)
  assert.match(body.recipient, /\*/)
})

test('status read: a reference belonging to another application is a 404, never a 403', async () => {
  const foreign = { ...SMS_ROW, reference: 'MSG-OTHER', applicationId: 'app-sacco' }
  const route = statusRouteHarness([SMS_ROW, foreign])

  const ours = await getStatus(route, 'MSG-1')
  assert.equal(ours.status, 200)

  const theirs = await getStatus(route, 'MSG-OTHER')
  assert.equal(theirs.status, 404, 'must not confirm that another application owns this reference')
  assert.equal((await theirs.json()).error, 'Message not found')

  const missing = await getStatus(route, 'MSG-NOPE')
  assert.equal(missing.status, 404)
})

test('status read: requires a valid partner key', async () => {
  const route = statusRouteHarness([SMS_ROW])
  assert.equal((await getStatus(route, 'MSG-1', '')).status, 401)
  assert.equal((await getStatus(route, 'MSG-1', 'wrong-key')).status, 401)
})

test('status read: surfaces the carrier delivery report and the partner acknowledgement', async () => {
  const route = statusRouteHarness(
    [{ ...SMS_ROW, status: 'delivered', notificationDeliveredAt: new Date('2026-10-28T20:31:00Z') }],
    { providerMessageId: 'AT-123', status: 'delivered', receivedAt: new Date('2026-10-28T20:30:00Z'), appliedAt: new Date('2026-10-28T20:30:01Z') }
  )
  const body = await (await getStatus(route, 'MSG-1')).json()
  assert.equal(body.status, 'delivered')
  assert.equal(body.deliveryReport.status, 'delivered')
  assert.ok(body.notificationDeliveredAt, 'the partner must be able to see whether it was told')
})

// The status endpoint authenticates with an API key, so the session gate must
// not intercept it — the same class of bug that produced a permanent 401 on the
// Africa's Talking delivery-report callback.
test('status read: is exempt from the dashboard session gate, without widening the exemption', () => {
  const middleware = loadTsModule<{ config: { matcher: string[] } }>('src/middleware.ts', {
    '@supabase/ssr': { createServerClient: () => ({}), type: {} },
  })
  const matcher = new RegExp(`^${middleware.config.matcher[0]}$`)

  assert.equal(matcher.test('/api/messaging/sms/MSG-1'), false, 'partner status must be reachable without a session')
  // Prefix safety: a future route such as this must not inherit the exemption.
  assert.equal(matcher.test('/api/messaging/sms-admin'), true)
  assert.equal(matcher.test('/api/messaging/sms'), true)
})

// ── Provider rejection reasons ──────────────────────────────────────────────

function storeHarness() {
  const updates: any[] = []
  const queries: any[] = []
  const { smsStore } = loadTsModule<any>('src/lib/sms-store.ts', {
    './db': {
      db: {
        smsMessage: {
          updateMany: async (args: any) => { updates.push(args); return { count: 1 } },
          findMany: async (args: any) => { queries.push(args); return [] },
        },
      },
    },
  })
  return { smsStore, updates, queries }
}

test('a provider rejection records the provider’s own reason instead of a constant', async () => {
  const { smsStore, updates } = storeHarness()
  await smsStore.failExplicitly('sms_1', 'Provider rejected SMS: InvalidSenderId')
  assert.equal(updates[0].data.failureReason, 'Provider rejected SMS: InvalidSenderId')

  // Older callers pass no reason; the previous constant is still written.
  await smsStore.failExplicitly('sms_2')
  assert.equal(updates[1].data.failureReason, 'Provider rejected SMS')

  // Bounded and trimmed.
  await smsStore.failExplicitly('sms_3', `  ${'x'.repeat(500)}  `)
  assert.equal(updates[2].data.failureReason.length, 200)
})

test('the provider status word survives from Africa’s Talking to failure_reason', async () => {
  const { sms: smsModule } = { sms: loadTsModule<any>('src/lib/sms.ts', {
    africastalking: () => ({
      SMS: { send: async () => ({ SMSMessageData: { Recipients: [{ status: 'InvalidSenderId', messageId: 'AT-9' }] } }) },
    }),
    '@/lib/phone': { normalizeToE164: (phone: string) => phone },
  }) }

  const previousKey = process.env.AFRICASTALKING_API_KEY
  const previousUser = process.env.AFRICASTALKING_USERNAME
  process.env.AFRICASTALKING_API_KEY = 'test-key'
  delete process.env.AFRICASTALKING_USERNAME
  try {
    const result = await smsModule.sendSmsViaProvider(PHONE, 'hello')
    assert.equal(result.success, false)
    assert.equal(result.providerStatus, 'InvalidSenderId')
  } finally {
    if (previousKey === undefined) delete process.env.AFRICASTALKING_API_KEY
    else process.env.AFRICASTALKING_API_KEY = previousKey
    if (previousUser === undefined) delete process.env.AFRICASTALKING_USERNAME
    else process.env.AFRICASTALKING_USERNAME = previousUser
  }
})

test('the queue passes that reason to failExplicitly and keeps its return shape', async () => {
  const row: any = { id: 'sms-1', recipient: PHONE, message: 'hi', status: 'queued', attemptCount: 0, applicationId: null }
  const reasons: any[] = []
  const { smsQueue } = loadTsModule<any>('src/lib/sms-queue.ts', {
    './redis': { redis: { lpush: async () => {}, rpop: async () => null } },
    './sms-store': {
      smsStore: {
        getDueQueued: async () => [row.id],
        claimForSending: async () => { row.status = 'pending'; row.attemptCount += 1; return { ...row } },
        recordProviderAcceptance: async () => true,
        failExplicitly: async (_id: string, reason?: string) => { reasons.push(reason); row.status = 'failed'; return true },
        updateProviderCost: async () => true,
      },
    },
    './sms': {
      sendSmsViaProvider: async () => ({ success: false, providerId: 'AT-9', error: 'Provider rejected SMS', providerStatus: 'InsufficientBalance' }),
    },
    './db': { db: {} },
    './safe-fetch': { isPlaceholderUrl: () => false },
    './application-auth': {},
    './notification-signature': {},
    './provider-cost': { parseProviderCost: () => null },
  })

  const results = await smsQueue.processBatch(1)
  assert.deepEqual(results, [{ smsId: 'sms-1', success: false, status: 'failed' }])
  assert.deepEqual(reasons, ['Provider rejected SMS: InsufficientBalance'])
})

// ── `unknown` notifications are opt-in ──────────────────────────────────────

test('unknown rows are excluded from notifications by default and included when enabled', async () => {
  const previous = process.env.SMS_NOTIFY_UNKNOWN

  try {
    delete process.env.SMS_NOTIFY_UNKNOWN
    let harness = storeHarness()
    await harness.smsStore.getPendingTerminalNotifications(5)
    assert.deepEqual(harness.queries[0].where.status.in, ['delivered', 'failed'])

    process.env.SMS_NOTIFY_UNKNOWN = 'true'
    harness = storeHarness()
    await harness.smsStore.getPendingTerminalNotifications(5)
    assert.deepEqual(harness.queries[0].where.status.in, ['delivered', 'failed', 'unknown'])
  } finally {
    if (previous === undefined) delete process.env.SMS_NOTIFY_UNKNOWN
    else process.env.SMS_NOTIFY_UNKNOWN = previous
  }

  assert.equal(smsNotifyUnknownEnabled(undefined), false)
  assert.equal(smsNotifyUnknownEnabled('TRUE'), true)
  assert.equal(smsNotifyUnknownEnabled('yes'), false)
})

function deliveryHarness(status: string) {
  const hooks: string[] = []
  const deliverSmsNotification = loadTsModule<any>('src/lib/sms-queue.ts', {
    './redis': { redis: {} },
    './sms-store': {
      smsStore: {
        markNotificationAttempted: async () => { hooks.push('attempted') },
        markNotificationDelivered: async () => { hooks.push('delivered') },
      },
    },
    './sms': {},
    './db': {
      db: {
        application: {
          findUnique: async () => ({ baseUrl: 'https://app.example', webhookPath: '/events', code: 'church', apiKey: 'secret' }),
        },
      },
    },
    './safe-fetch': { isPlaceholderUrl: () => false, safeFetch: async () => ({ ok: true }) },
    './application-auth': { webhookSecretFromRow: () => 'secret' },
    './notification-signature': { buildNotificationHeaders: () => ({}) },
    './provider-cost': {},
  }).deliverSmsNotification

  return { deliverSmsNotification, hooks, sms: { id: 'sms-1', status, recipient: PHONE, reference: 'MSG-1', applicationId: 'app-1' } }
}

test('a delivery notification for an unknown row is suppressed unless the flag is on', async () => {
  const previous = process.env.SMS_NOTIFY_UNKNOWN
  try {
    delete process.env.SMS_NOTIFY_UNKNOWN
    let h = deliveryHarness('unknown')
    assert.equal(await h.deliverSmsNotification(h.sms), false, 'unknown must not notify by default')
    assert.deepEqual(h.hooks, [])

    process.env.SMS_NOTIFY_UNKNOWN = 'true'
    h = deliveryHarness('unknown')
    assert.equal(await h.deliverSmsNotification(h.sms), true)
    assert.deepEqual(h.hooks, ['delivered'])
  } finally {
    if (previous === undefined) delete process.env.SMS_NOTIFY_UNKNOWN
    else process.env.SMS_NOTIFY_UNKNOWN = previous
  }
})

test('delivered and failed still notify regardless of the flag', async () => {
  const previous = process.env.SMS_NOTIFY_UNKNOWN
  try {
    delete process.env.SMS_NOTIFY_UNKNOWN
    for (const status of ['delivered', 'failed']) {
      const h = deliveryHarness(status)
      assert.equal(await h.deliverSmsNotification(h.sms), true, `${status} must notify`)
      assert.deepEqual(h.hooks, ['delivered'])
    }
  } finally {
    if (previous === undefined) delete process.env.SMS_NOTIFY_UNKNOWN
    else process.env.SMS_NOTIFY_UNKNOWN = previous
  }
})

// ── Recipient masking ───────────────────────────────────────────────────────

test('masking keeps the shape of a number and hides the digits', () => {
  assert.equal(maskRecipient('+256700000001'), '+256*******01')
  assert.equal(maskRecipient('1234'), '1234')
  assert.equal(maskRecipient(''), '')
  assert.equal(maskRecipient(undefined as any), '')
})

// Guard: the modules under test must be the ones the app actually ships.
test('the status route file is where the middleware exemption points', () => {
  const route = loadTsModule<Record<string, unknown>>(
    `src/app/api/messaging/sms/[reference]/route.ts`,
    {}
  )
  assert.equal(typeof route.GET, 'function')
})
