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
import fs from 'node:fs'
import path from 'node:path'
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

// ── Africa's Talking failure shapes ─────────────────────────────────────────
//
// The SDK (node_modules/africastalking/lib/sms.js) rejects in three shapes and
// Africa's Talking reports failures in two places. Before this, only a
// per-recipient status was understood, so every account-level failure — wrong
// key, empty balance, unregistered sender — was thrown as "Provider outcome
// unknown", held `pending`, and aged into `unknown` with no reason recorded.

function atProvider(response: any) {
  const sms = loadTsModule<any>('src/lib/sms.ts', {
    africastalking: () => ({ SMS: { send: async () => response } }),
    '@/lib/phone': { normalizeToE164: (p: string) => p },
  })
  return sms.sendSmsViaProvider
}

function atProviderThrowing(thrown: unknown) {
  const sms = loadTsModule<any>('src/lib/sms.ts', {
    africastalking: () => ({ SMS: { send: async () => { throw thrown } } }),
    '@/lib/phone': { normalizeToE164: (p: string) => p },
  })
  return sms.sendSmsViaProvider
}

const PROVIDER_ENV = { key: process.env.AFRICASTALKING_API_KEY, user: process.env.AFRICASTALKING_USERNAME }
function withProviderEnv() {
  process.env.AFRICASTALKING_API_KEY = 'test-key'
  process.env.AFRICASTALKING_USERNAME = 'najiki'
}
function restoreProviderEnv() {
  if (PROVIDER_ENV.key === undefined) delete process.env.AFRICASTALKING_API_KEY
  else process.env.AFRICASTALKING_API_KEY = PROVIDER_ENV.key
  if (PROVIDER_ENV.user === undefined) delete process.env.AFRICASTALKING_USERNAME
  else process.env.AFRICASTALKING_USERNAME = PROVIDER_ENV.user
}

test('classifyProviderFailure: only unambiguous "not accepted" reasons are classified', () => {
  const sms = loadTsModule<any>('src/lib/sms.ts', { africastalking: () => ({}), '@/lib/phone': {} })
  const { classifyProviderFailure } = sms

  for (const [message, label] of [
    ['Invalid API Key', 'InvalidApiKey'],
    ['invalid api key', 'InvalidApiKey'],
    ['Insufficient balance', 'InsufficientBalance'],
    ['User not found', 'InvalidUsername'],
    ['InvalidSenderId', 'InvalidSenderId'],
    ['Sender ID is not registered', 'InvalidSenderId'],
    ['Invalid phone number', 'InvalidPhoneNumber'],
    ['Account is suspended', 'AccountInactive'],
  ] as const) {
    assert.match(String(classifyProviderFailure(message)), new RegExp(`^${label}: `), message)
  }

  // The provider's own words are preserved beside the label.
  assert.match(String(classifyProviderFailure('Insufficient balance')), /Insufficient balance/)
  // Bounded, so a long body cannot be written into failure_reason unbounded.
  assert.ok(String(classifyProviderFailure(`Invalid API Key ${'x'.repeat(400)}`)).length <= 200)

  // Anything ambiguous must stay ambiguous: turning an uncertain outcome into a
  // failure risks a second billed send.
  for (const unknown of [
    '',
    '   ',
    undefined,
    null,
    42,
    'Sent to 1/1',
    'Queued',
    'Request failed with status code 500',
    'socket hang up',
  ]) {
    assert.equal(classifyProviderFailure(unknown), null, JSON.stringify(unknown))
  }
})

test('AT account-level rejection (no Recipients) becomes a failure with the real reason', async () => {
  withProviderEnv()
  try {
    for (const [message, expected] of [
      ['Invalid API Key', 'InvalidApiKey'],
      ['Insufficient balance', 'InsufficientBalance'],
      ['User not found', 'InvalidUsername'],
    ] as const) {
      const send = atProvider({ SMSMessageData: { Message: message } })
      const result = await send(PHONE, 'hello')
      assert.equal(result.success, false, message)
      assert.match(String(result.providerStatus), new RegExp(`^${expected}: `), message)
      assert.equal(result.error, 'Provider rejected SMS')
    }
  } finally {
    restoreProviderEnv()
  }
})

test('AT non-2xx surfaces through the SDK’s axios error, not as "outcome unknown"', async () => {
  withProviderEnv()
  try {
    const send = atProviderThrowing(
      Object.assign(new Error('Request failed with status code 401'), {
        response: { status: 401, data: { SMSMessageData: { Message: 'Invalid API Key' } } },
      })
    )
    const result = await send(PHONE, 'hello')
    assert.equal(result.success, false)
    assert.match(String(result.providerStatus), /^InvalidApiKey: Invalid API Key$/)
  } finally {
    restoreProviderEnv()
  }
})

test('AT raw-body rejection (2xx but not 201) is classified too', async () => {
  withProviderEnv()
  try {
    const send = atProviderThrowing({ SMSMessageData: { Message: 'Insufficient balance' } })
    const result = await send(PHONE, 'hello')
    assert.equal(result.success, false)
    assert.match(String(result.providerStatus), /^InsufficientBalance: /)
  } finally {
    restoreProviderEnv()
  }
})

test('an SDK-rejected phone number fails instead of hanging pending forever', async () => {
  withProviderEnv()
  try {
    // The SDK validates locally with Joi and never transmits, so failing is safe:
    // there is no accepted send to mask.
    const send = atProviderThrowing(new Error('must be a valid phone number; '))
    const result = await send(PHONE, 'hello')
    assert.equal(result.success, false)
    assert.match(String(result.providerStatus), /^InvalidPhoneNumber: /)
  } finally {
    restoreProviderEnv()
  }
})

test('genuinely ambiguous outcomes still throw and are never marked failed', async () => {
  withProviderEnv()
  try {
    // Empty body: the response may have been lost after acceptance.
    await assert.rejects(atProvider({ SMSMessageData: {} })(PHONE, 'hello'), /outcome unknown/)
    // Transport failure with no response at all.
    await assert.rejects(
      atProviderThrowing(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))(PHONE, 'hello'),
      /outcome unknown/
    )
    // A 500 with an unrecognised body.
    await assert.rejects(
      atProviderThrowing(
        Object.assign(new Error('Request failed with status code 500'), {
          response: { status: 500, data: { SMSMessageData: { Message: 'Internal error' } } },
        })
      )(PHONE, 'hello'),
      /outcome unknown/
    )
  } finally {
    restoreProviderEnv()
  }
})

test('the account-level reason reaches failure_reason through the queue', async () => {
  const reasons: any[] = []
  const row: any = { id: 'sms-1', recipient: PHONE, message: 'hi', status: 'queued', attemptCount: 0, applicationId: null }
  const { smsQueue } = loadTsModule<any>('src/lib/sms-queue.ts', {
    './redis': { redis: { lpush: async () => {}, rpop: async () => null } },
    './sms-store': {
      smsStore: {
        getDueQueued: async () => [row.id],
        claimForSending: async () => { row.status = 'pending'; return { ...row } },
        recordProviderAcceptance: async () => true,
        failExplicitly: async (_id: string, reason?: string) => { reasons.push(reason); return true },
        updateProviderCost: async () => true,
      },
    },
    './sms': {
      sendSmsViaProvider: async () => ({
        success: false,
        error: 'Provider rejected SMS',
        providerStatus: 'InvalidApiKey: Invalid API Key',
      }),
    },
    './db': { db: {} },
    './safe-fetch': { isPlaceholderUrl: () => false },
    './application-auth': {},
    './notification-signature': {},
    './provider-cost': { parseProviderCost: () => null },
  })

  assert.deepEqual(await smsQueue.processBatch(1), [{ smsId: 'sms-1', success: false, status: 'failed' }])
  assert.deepEqual(reasons, ['Provider rejected SMS: InvalidApiKey: Invalid API Key'])
})

// ── Orphaned `pending` rows ─────────────────────────────────────────────────
//
// processBatch claims a row (queued → pending) and only later writes
// providerMessageId. If the process dies in between, the row has no provider id:
// the queued sweep selects only `queued`, the claim only accepts `queued`, and
// delivery reports match on a provider id that was never written. It then shows
// as `pending` for the full 48 hours even though the carrier may have delivered
// it. reclaimOrphanedPending closes those rows honestly.

function reclaimHarness() {
  const updates: any[] = []
  const { smsStore } = loadTsModule<any>('src/lib/sms-store.ts', {
    './db': {
      db: {
        smsMessage: {
          updateMany: async (args: any) => { updates.push(args); return { count: 1 } },
          findMany: async () => [],
        },
      },
    },
  })
  return { smsStore, updates }
}

test('orphaned pending rows are closed as unknown, never as failed and never re-sent', async () => {
  const { smsStore, updates } = reclaimHarness()
  assert.equal(await smsStore.reclaimOrphanedPending(5), 1)

  const where = updates[0].where
  const data = updates[0].data

  // Only rows that were claimed (attemptCount > 0) and carry no provider id.
  assert.equal(where.status, 'pending')
  assert.equal(where.providerMessageId, null)
  assert.deepEqual(where.attemptCount, { gt: 0 })
  assert.ok(where.updatedAt.lt instanceof Date, 'an age cutoff is required')

  // `unknown`, not `failed`: a `failed` row invites a resend, and the carrier may
  // already have delivered this one — that would bill twice.
  assert.equal(data.status, 'unknown')
  assert.notEqual(data.status, 'failed')
  assert.match(data.failureReason, /Provider outcome unknown/)
  // No resend machinery is touched.
  assert.equal('nextAttemptAt' in data, false)
  assert.equal('attemptCount' in data, false)
})

test('the cutoff is the configured age, and out-of-range values are clamped', async () => {
  const now = Date.now()
  for (const [input, expectedMinutes] of [[5, 5], [0, 1], [-10, 1], [999999, 1440]] as const) {
    const { smsStore, updates } = reclaimHarness()
    await smsStore.reclaimOrphanedPending(input as number)
    const cutoff = updates[0].where.updatedAt.lt as Date
    const ageMinutes = (now - cutoff.getTime()) / 60000
    assert.ok(
      Math.abs(ageMinutes - expectedMinutes) < 0.1,
      `minutes=${input} should clamp to ${expectedMinutes}, got ${ageMinutes.toFixed(2)}`
    )
  }
})

test('rows that DID get a provider id are left pending so a delivery report can settle them', async () => {
  const { smsStore, updates } = reclaimHarness()
  await smsStore.reclaimOrphanedPending(5)
  // The null filter is the guarantee: these rows must not be swept.
  assert.equal(updates[0].where.providerMessageId, null)
})

test('updateMany is called with only where/data — take/limit are not valid Prisma args', async () => {
  const { smsStore, updates } = reclaimHarness()
  await smsStore.reclaimOrphanedPending(5)
  assert.deepEqual(Object.keys(updates[0]).sort(), ['data', 'where'])
})

test('the sms cron reclaims orphans and reports the count', async () => {
  const reclaimed: number[] = []
  const route = loadTsModule<any>('src/app/api/qstash/sms-cron/route.ts', {
    'next/server': {
      NextResponse: { json: (body: any, init?: any) => ({ status: init?.status ?? 200, body, json: async () => body }) },
    },
    '@/lib/qstash-verify': { verifyCronRequest: async () => true },
    '@/lib/sms-queue': {
      smsQueue: { processBatch: async () => [] },
      retrySmsNotifications: async () => 0,
      reconcileSmsDeliveryReports: async () => 0,
    },
    '@/lib/sms-store': {
      smsStore: {
        reclaimOrphanedPending: async (minutes: number) => { reclaimed.push(minutes); return 3 },
        markStalePendingUnknown: async () => 0,
        pruneDeliveryReports: async () => 0,
      },
    },
  })

  const response = await route.POST(new Request('https://g.test/api/qstash/sms-cron', { method: 'POST' }))
  const body = await response.json()
  assert.deepEqual(reclaimed, [5], 'defaults to 5 minutes')
  assert.equal(body.orphanedReclaimed, 3)
})

test('both messaging routes declare a serverless budget long enough for one provider call', () => {
  for (const file of [
    'src/app/api/messaging/send/route.ts',
    'src/app/api/messaging/quick-send/route.ts',
  ]) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8')
    const match = /export const maxDuration = (\d+)/.exec(source)
    assert.ok(match, `${file} must export maxDuration`)
    // waitForSmsProvider allows 12s per call; Vercel's default (10s on Hobby)
    // would kill the function between claim and provider-id persistence.
    assert.ok(Number(match![1]) >= 30, `${file} maxDuration ${match![1]}s leaves no budget for the drain`)
  }
})
