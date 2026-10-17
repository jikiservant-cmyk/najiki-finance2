import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import ts from 'typescript'
import { SmsInputSchema, smsSegmentCount, resolveSmsDailyLimit } from '../src/lib/sms-policy.ts'

function load(file: string, stubs: Record<string, unknown>): any {
  const filename = path.resolve(file)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const loaded = new Module(filename)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  const realRequire = loaded.require.bind(loaded)
  loaded.require = (name: string) => name in stubs ? stubs[name] : realRequire(name)
  loaded._compile(code, filename)
  return loaded.exports
}

const input = { to: '+256700000001', message: 'Hi' }

test('partner and admin policy bounds GSM and Unicode by billed segments, not just characters', () => {
  assert.equal(smsSegmentCount('a'.repeat(918)), 6)
  assert.equal(smsSegmentCount('^'.repeat(459)), 6)
  assert.equal(smsSegmentCount('😊'.repeat(201)), 6)
  for (const message of ['a'.repeat(919), '^'.repeat(460), '😊'.repeat(202)]) {
    assert.equal(SmsInputSchema.safeParse({ ...input, message }).success, false)
  }
  assert.equal(SmsInputSchema.safeParse({ ...input, message: 'hi', to: 'not-a-phone' }).success, false)
  assert.equal(resolveSmsDailyLimit(undefined), 10000)
  for (const invalid of ['0', '-1', 'NaN', 'Infinity', '1.5']) {
    assert.throws(() => resolveSmsDailyLimit(invalid))
  }
})

test('atomic daily quota serializes concurrent requests and repeats the same key safely', async () => {
  const rows: any[] = []
  let mutex = Promise.resolve()
  const tx: any = {
    $queryRawUnsafe: async () => {},
    smsMessage: {
      findFirst: async ({ where }: any) => rows.find(row => row.applicationId === where.applicationId && row.idempotencyKey === where.idempotencyKey),
      count: async () => rows.length,
      create: async ({ data }: any) => { rows.push(data); return data },
    },
  }
  const db = { $transaction: (fn: any) => {
    const result = mutex.then(() => fn(tx))
    mutex = result.then(() => {}, () => {})
    return result
  } }
  const { smsStore, SmsDailyLimitError, SmsIdempotencyConflictError } = load('src/lib/sms-store.ts', { './db': { db } })
  const params = { recipient: input.to, message: input.message, applicationCode: 'a',
    applicationId: 'app-1', providerCode: 'at', cost: 50, dailyLimit: 1, idempotencyKey: 'unique-key' }
  const [first, second] = await Promise.all([smsStore.createOrGet(params), smsStore.createOrGet(params)])
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(rows.length, 1)
  await assert.rejects(smsStore.createOrGet({ ...params, idempotencyKey: 'different-key' }), SmsDailyLimitError)
  await assert.rejects(smsStore.createOrGet({ ...params, message: 'changed' }), SmsIdempotencyConflictError)
})

function queueHarness() {
  const row: any = { id: 'sms-1', recipient: input.to, message: 'secret OTP', status: 'queued',
    attemptCount: 0, applicationId: null }
  let providerCalls = 0
  let failRedis = false
  let provider: () => Promise<any> = async () => { providerCalls++; return { success: true, providerId: 'p-1', status: 'submitted' } }
  const smsStore = {
    getDueQueued: async () => row.status === 'queued' ? [row.id] : [],
    claimForSending: async () => {
      if (row.status !== 'queued') return null
      row.status = 'pending'; row.attemptCount++; return { ...row }
    },
    recordProviderAcceptance: async (_: string, id: string) => { row.providerMessageId = id; return true },
    failExplicitly: async () => { row.status = 'failed'; return true },
    updateProviderCost: async () => true,
  }
  const redis = { lpush: async () => { if (failRedis) throw Error('LPUSH failed') },
    rpop: async () => { if (failRedis) throw Error('RPOP failed'); return null } }
  const { smsQueue } = load('src/lib/sms-queue.ts', {
    './redis': { redis }, './sms-store': { smsStore }, './sms': { sendSmsViaProvider: () => provider() },
    './db': { db: {} }, './safe-fetch': { isPlaceholderUrl: () => false },
    './application-auth': {}, './notification-signature': {}, './provider-cost': { parseProviderCost: () => null },
  })
  return { row, smsQueue, get calls() { return providerCalls },
    setRedisFailure: () => { failRedis = true }, setProvider: (fn: () => Promise<any>) => { provider = fn } }
}

test('lost Redis hint is recovered from DB; duplicate cron jobs cannot resend', async () => {
  const h = queueHarness()
  h.setRedisFailure()
  await h.smsQueue.enqueue('sms-1')
  assert.deepEqual(await h.smsQueue.processBatch(), [{ smsId: 'sms-1', success: true, status: 'pending' }])
  assert.equal(h.row.status, 'pending') // submitted is not delivered
  await h.smsQueue.processBatch()
  assert.equal(h.calls, 1)
  assert.equal(h.row.providerMessageId, 'p-1')
})

test('ambiguous timeout after provider acceptance never auto-retries', async () => {
  const h = queueHarness()
  h.setProvider(async () => { throw Error('SDK error including secret OTP and phone') })
  assert.deepEqual(await h.smsQueue.processBatch(), [{ smsId: 'sms-1', success: false, status: 'pending' }])
  await h.smsQueue.processBatch()
  assert.equal(h.row.status, 'pending')
  assert.equal(h.row.attemptCount, 1)
})

test('DLR requires matching provider ID and monotonic terminal transition', async () => {
  const row: any = { id: 'app-a-sms', providerMessageId: 'provider-1', status: 'pending' }
  const db = { smsMessage: {
    findMany: async ({ where }: any) => where.providerMessageId === 'provider-1' ? [row] : [],
    updateMany: async ({ where, data }: any) => {
      if (where.id !== row.id || where.providerMessageId !== row.providerMessageId ||
        !where.status.in.includes(row.status)) return { count: 0 }
      Object.assign(row, data); return { count: 1 }
    },
  } }
  const { smsStore } = load('src/lib/sms-store.ts', { './db': { db } })
  assert.equal(await smsStore.findByProviderMessageId('other-id'), null)
  assert.equal(await smsStore.applyDeliveryReport(row.id, 'other-id', 'failed'), false)
  assert.equal(row.status, 'pending')
  assert.equal(await smsStore.applyDeliveryReport(row.id, 'provider-1', 'delivered'), true)
  assert.equal(await smsStore.applyDeliveryReport(row.id, 'provider-1', 'failed'), false)
  assert.equal(row.status, 'delivered')
})

test('authenticated DLR with unknown ID and matching phone cannot touch another app', async () => {
  let updates = 0
  let lookedUp = 0
  const { POST } = load('src/app/api/webhooks/africastalking/route.ts', {
    'next/server': { NextResponse: class extends Response {} },
    '@/lib/sms-store': { smsStore: {
      findByProviderMessageId: async () => { lookedUp++; return null },
      applyDeliveryReport: async () => { updates++; return true },
    } },
    '@/lib/sms-queue': { deliverSmsNotification: async () => true },
    '@/lib/callback-auth': { authorizeCallback: () => ({ ok: true, via: 'secret' }) },
    '@/lib/client-ip': { resolveClientIp: () => '127.0.0.1' },
    '@/lib/rate-limit': { checkRateLimit: async () => ({ ok: true }) },
    '@/lib/request-body': { readTextWithLimit: (request: Request) => request.text(), PayloadTooLargeError: class extends Error {} },
  })
  const response = await POST(new Request('https://app.example/api/webhooks/africastalking?key=test', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'unknown', status: 'Failed', phoneNumber: input.to }),
  }))
  assert.equal(response.status, 200)
  assert.equal(lookedUp, 1)
  assert.equal(updates, 0)
})

test('retention purges terminal SMS content independently of phone-number masking', async () => {
  let changed: any
  const db = {
    paymentIntent: { findMany: async () => [] },
    smsMessage: {
      findMany: async ({ where }: any) => where.message ? [{ id: 'old-terminal' }] : [],
      updateMany: async (args: any) => { changed = args; return { count: 1 } },
    },
  }
  const { applyPhoneRetention, REDACTED_SMS_BODY } = load('src/lib/retention-store.ts', {
    './db': { db }, './redact': { maskPhoneNumber: () => 'masked' },
    './retention': {
      resolvePhoneRetentionDays: () => 0, resolveRetentionMode: () => 'mask',
      isRetentionDisabled: (days: number) => days === 0,
      retentionCutoff: (days: number, now: Date) => new Date(now.getTime() - days * 86400000),
    },
  })
  const result = await applyPhoneRetention({ days: 0, now: new Date('2026-10-17T00:00:00Z') })
  assert.equal(result.smsBodiesPurged, 1)
  assert.equal(result.smsMessagesRedacted, 0)
  assert.equal(changed.data.message, REDACTED_SMS_BODY)
  assert.deepEqual(changed.where.status.in, ['delivered', 'failed', 'unknown'])
})

test('provider returns pending acceptance, rejects malformed response as ambiguous and does not log body', async () => {
  let result: any = { SMSMessageData: { Recipients: [{ status: 'Submitted', messageId: 'provider-42' }] } }
  const provider = load('src/lib/sms.ts', {
    africastalking: () => ({ SMS: { send: async () => result } }),
    '@/lib/phone': { normalizeToE164: (phone: string) => phone },
  })
  const oldKey = process.env.AFRICASTALKING_API_KEY
  const originalLog = console.log
  const logs: string[] = []
  console.log = (...args: any[]) => { logs.push(args.join(' ')) }
  try {
    process.env.AFRICASTALKING_API_KEY = 'fake-key'
    const accepted = await provider.sendSmsViaProvider(input.to, 'SECRET-OTP-123')
    assert.equal(accepted.success, true)
    assert.equal(accepted.status, 'Submitted')
    assert.equal(accepted.providerId, 'provider-42')
    result = { SMSMessageData: {} } // may be accepted even if the response was lost
    await assert.rejects(provider.sendSmsViaProvider(input.to, 'SECRET-OTP-123'), /outcome unknown/)
    assert.equal(logs.some(line => line.includes('SECRET-OTP-123') || line.includes(input.to)), false)
  } finally {
    console.log = originalLog
    if (oldKey === undefined) delete process.env.AFRICASTALKING_API_KEY
    else process.env.AFRICASTALKING_API_KEY = oldKey
  }
})

test('terminal partner notifications require 2xx; unsuccessful attempts remain retryable', async () => {
  const attempts: string[] = []
  const sms = { id: 'sms-1', status: 'delivered', recipient: input.to, reference: 'MSG-1',
    applicationId: 'app-1', providerMessageId: 'provider-42' }
  let ok = false
  const { deliverSmsNotification } = load('src/lib/sms-queue.ts', {
    './redis': { redis: {} },
    './sms-store': { smsStore: {
      markNotificationAttempted: async () => { attempts.push('attempted') },
      markNotificationDelivered: async () => { attempts.push('delivered') },
    } },
    './sms': {}, './db': { db: { application: { findUnique: async () => ({
      baseUrl: 'https://app.example', webhookPath: '/events', code: 'app', apiKey: 'secret',
    }) } } },
    './safe-fetch': { isPlaceholderUrl: () => false,
      safeFetch: async () => ({ ok }) },
    './application-auth': { webhookSecretFromRow: () => 'secret' },
    './notification-signature': { buildNotificationHeaders: () => ({}) },
    './provider-cost': {},
  })
  assert.equal(await deliverSmsNotification(sms), false)
  assert.deepEqual(attempts, ['attempted'])
  ok = true
  assert.equal(await deliverSmsNotification(sms), true)
  assert.deepEqual(attempts, ['attempted', 'delivered'])
})
