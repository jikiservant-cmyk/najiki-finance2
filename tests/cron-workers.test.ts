/**
 * The background workers, driven through their real route handlers.
 *
 * These are the endpoints QStash calls every minute (see
 * `scripts/setup-cron-schedules.ts`). If one of them is broken the system looks
 * fine — payments settle, the dashboard loads — while retries quietly stop and
 * partners stop being told about money that arrived.
 *
 * Covered here:
 *
 *   • every worker refuses an unauthenticated request (nothing runs on a
 *     stray GET), and accepts a `CRON_SECRET` bearer token;
 *   • /api/cron/notifications retries a due webhook, backs off a transient
 *     failure, gives up on a permanent one, and stays inside its time budget;
 *   • /api/cron/sync-payments resolves a stuck payment and notifies the church
 *     with the same payload shape the live webhook path uses;
 *   • /api/cron/alerts reports a stalled retry worker — the failure mode where
 *     the schedule has silently stopped and nothing else would notice.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeDb, type Row } from './helpers/fake-db.ts'
import { loadTsModule, srcPath } from './helpers/ts-load.ts'

const CRON_SECRET = 'cron-secret-that-is-long-enough'

const CHURCH_APPLICATION = {
  id: 'app_church',
  code: 'church',
  name: 'Church App',
  baseUrl: 'https://church.najiki.test',
  webhookPath: '/api/webhooks/najiki',
  apiKey: 'church_api_key',
  webhookSecretEncrypted: null,
  internalSecretRef: 'CHURCH_INTERNAL_SECRET',
  isActive: true,
}

function cronRequest(path: string, opts: { secret?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = {}
  const secret = opts.secret === undefined ? CRON_SECRET : opts.secret
  if (secret) headers.authorization = `Bearer ${secret}`
  return new Request(`https://gateway.najiki.test${path}`, { method: opts.method ?? 'GET', headers })
}

function withCronSecret<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CRON_SECRET
  process.env.CRON_SECRET = CRON_SECRET
  // QStash signature keys are absent on purpose: this exercises the documented
  // `Authorization: Bearer <CRON_SECRET>` path that Vercel Cron and manual
  // triggers use.
  delete process.env.QSTASH_CURRENT_SIGNING_KEY
  delete process.env.QSTASH_NEXT_SIGNING_KEY
  return fn().finally(() => {
    if (previous === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previous
  })
}

// ── /api/cron/notifications ────────────────────────────────────────────────

type NotificationsHarness = {
  GET: (request: Request) => Promise<Response>
  POST: (request: Request) => Promise<Response>
  delivered: any[]
  failures: any[]
  dueRows: Row[]
  deliveredRows: any[]
}

function loadNotificationsWorker(options: {
  due?: Row[]
  outcome?: { success: boolean; statusCode?: number; error?: string; responseBody?: string }
  deliveryDelayMs?: number
} = {}): NotificationsHarness {
  const delivered: any[] = []
  const failures: any[] = []
  const deliveredRows: any[] = []
  const dueRows = options.due ?? [
    {
      id: 'notif_1',
      paymentIntentId: 'pi_1',
      applicationId: 'app_church',
      url: 'https://church.najiki.test/api/webhooks/najiki',
      payload: JSON.stringify({ reference: 'CHURCH-1', status: 'success' }),
      status: 'failed_retrying',
      attemptCount: 1,
      maxAttempts: 5,
      nextRetryAt: new Date(Date.now() - 60_000),
    },
  ]

  const route = loadTsModule<{ GET: NotificationsHarness['GET']; POST: NotificationsHarness['POST'] }>(
    'src/app/api/cron/notifications/route.ts',
    {
      '@/lib/data': {
        getPendingNotifications: async () => dueRows,
      },
      '@/lib/payments': {
        async deliverQueuedNotification(row: any) {
          delivered.push(row)
          if (options.deliveryDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, options.deliveryDelayMs))
          }
          return (
            options.outcome ?? { success: true, statusCode: 200, responseBody: '{"received":true}' }
          )
        },
        async recordNotificationDelivered(paymentIntentId: string, statusCode: number, body?: string) {
          deliveredRows.push({ paymentIntentId, statusCode, body })
        },
        async recordNotificationFailure(paymentIntentId: string, reason: string, opts: any) {
          failures.push({ paymentIntentId, reason, opts })
        },
      },
    }
  )

  return { GET: route.GET, POST: route.POST, delivered, failures, dueRows, deliveredRows }
}

test('cron(notifications): an unauthenticated call is refused and delivers nothing', async () => {
  const worker = loadNotificationsWorker()

  const response = await worker.GET(cronRequest('/api/cron/notifications', { secret: null }))

  assert.equal(response.status, 401)
  assert.equal(worker.delivered.length, 0)
})

test('cron(notifications): a wrong secret is refused', async () => {
  const worker = loadNotificationsWorker()
  const response = await worker.GET(cronRequest('/api/cron/notifications', { secret: 'not-the-secret' }))
  assert.equal(response.status, 401)
  assert.equal(worker.delivered.length, 0)
})

test('cron(notifications): a due webhook is retried and marked delivered', async () => {
  await withCronSecret(async () => {
    const worker = loadNotificationsWorker()
    const response = await worker.GET(cronRequest('/api/cron/notifications'))

    assert.equal(response.status, 200)
    const body: any = await response.json()
    assert.equal(body.success, true)
    assert.equal(body.dueCount, 1)
    assert.equal(body.deliveredCount, 1)
    assert.equal(worker.delivered.length, 1)
    assert.equal(worker.deliveredRows.length, 1)
    assert.equal(worker.deliveredRows[0].statusCode, 200)
  })
})

test('cron(notifications): a transient failure is rescheduled, not dropped', async () => {
  await withCronSecret(async () => {
    const worker = loadNotificationsWorker({
      outcome: { success: false, statusCode: 503, error: 'HTTP 503: partner unavailable' },
    })

    const response = await worker.GET(cronRequest('/api/cron/notifications'))
    const body: any = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.deliveredCount, 0)
    assert.equal(body.results[0].status, 'retrying')
    assert.equal(worker.failures.length, 1)
    assert.equal(worker.failures[0].opts.permanent, false)
  })
})

test('cron(notifications): a permanent failure is not retried', async () => {
  await withCronSecret(async () => {
    const worker = loadNotificationsWorker({
      outcome: { success: false, statusCode: 400, error: 'HTTP 400: bad request (permanent)' },
    })

    const response = await worker.GET(cronRequest('/api/cron/notifications'))
    const body: any = await response.json()

    assert.equal(body.results[0].status, 'exhausted')
    assert.equal(worker.failures[0].opts.permanent, true)
  })
})

test('cron(notifications): POST is accepted too, so QStash and Vercel can both drive it', async () => {
  await withCronSecret(async () => {
    const worker = loadNotificationsWorker()
    const response = await worker.POST(cronRequest('/api/cron/notifications', { method: 'POST' }))
    assert.equal(response.status, 200)
    assert.equal(worker.delivered.length, 1)
  })
})

test('cron(notifications): a batch stops at its time budget instead of being killed mid-run', async () => {
  await withCronSecret(async () => {
    const previous = process.env.NOTIFICATION_WORKER_BUDGET_MS
    process.env.NOTIFICATION_WORKER_BUDGET_MS = '20'
    try {
      const many = Array.from({ length: 5 }, (_, index) => ({
        id: `notif_${index}`,
        paymentIntentId: `pi_${index}`,
        applicationId: 'app_church',
        url: 'https://church.najiki.test/api/webhooks/najiki',
        payload: '{}',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 5,
        nextRetryAt: new Date(),
      }))
      // Each delivery takes longer than the whole budget, so the loop must stop
      // after the first rather than running the batch past the platform timeout.
      const worker = loadNotificationsWorker({ due: many, deliveryDelayMs: 30 })

      const body: any = await worker.GET(cronRequest('/api/cron/notifications')).then((r) => r.json())

      assert.ok(body.skippedCount > 0, 'the remainder must be left for the next tick')
      assert.ok(worker.delivered.length < many.length)
    } finally {
      if (previous === undefined) delete process.env.NOTIFICATION_WORKER_BUDGET_MS
      else process.env.NOTIFICATION_WORKER_BUDGET_MS = previous
    }
  })
})

// ── /api/cron/sync-payments ────────────────────────────────────────────────

type SyncHarness = {
  GET: (request: Request) => Promise<Response>
  POST: (request: Request) => Promise<Response>
  completions: any[]
  enqueued: any[]
  db: any
}

function loadSyncWorker(options: { status?: string; intent?: Row } = {}): SyncHarness {
  const completions: any[] = []
  const enqueued: any[] = []

  const intent: Row = options.intent ?? {
    id: 'pi_church_1',
    reference: 'CHURCH-0001',
    amount: 20000,
    currency: 'UGX',
    status: 'pending',
    providerPaymentId: null,
    failureReason: null,
    applicationId: 'app_church',
    tenantId: 'tenant_grace',
    providerId: 'prov_livepay',
    externalEntityId: 'member_42',
    createdAt: new Date(Date.now() - 5 * 60 * 1000),
    lastPolledAt: null,
    metadata: JSON.stringify({ paymentTypeCode: 'tithe' }),
    application: CHURCH_APPLICATION,
    tenant: { id: 'tenant_grace', code: 'grace-church' },
    paymentType: { id: 'pt_tithe', code: 'tithe' },
    provider: { code: 'livepay' },
  }

  const db = createFakeDb({
    paymentIntent: [intent],
    application: [CHURCH_APPLICATION],
    tenant: [{ id: 'tenant_grace', code: 'grace-church' }],
  })

  const route = loadTsModule<{ GET: SyncHarness['GET']; POST: SyncHarness['POST'] }>(
    'src/app/api/cron/sync-payments/route.ts',
    {
      [srcPath('lib/db.ts')]: { db },
      '@/lib/providers': {
        getPaymentProvider: () => ({
          code: 'livepay',
          name: 'LivePay',
          async checkPaymentStatus() {
            // `success: true` is required — a poller must not act on a
            // provider response that merely contains a status field.
            return {
              success: true,
              status: options.status ?? 'success',
              providerPaymentId: 'LP_TX_9001',
              amount: 20000,
              currency: 'UGX',
            }
          },
        }),
      },
      '@/lib/payments': {
        async completePayment(data: any) {
          completions.push(data)
          return { wasAlreadyProcessed: false }
        },
        async enqueueWebhookNotification(data: any) {
          enqueued.push(data)
        },
      },
      '@/lib/tenant-credentials': {
        async resolveTenantOrPlatformCredentials() {
          return {
            credentials: { apiKey: 'k', accountNo: 'a', webhookSecret: 'tenant-webhook-secret-1234' },
          }
        },
      },
      '@/lib/application-auth': {
        webhookSecretFromRow: () => 'church-outbound-secret',
        fallbackSigningSecretsFromRow: () => ['church_api_key'],
      },
    }
  )

  return { GET: route.GET, POST: route.POST, completions, enqueued, db }
}

test('cron(sync-payments): an unauthenticated call polls nothing', async () => {
  const worker = loadSyncWorker()
  const response = await worker.GET(cronRequest('/api/cron/sync-payments', { secret: null }))

  assert.equal(response.status, 401)
  assert.equal(worker.completions.length, 0)
})

test('cron(sync-payments): a payment the provider has settled is completed and the church is notified', async () => {
  await withCronSecret(async () => {
    const worker = loadSyncWorker()
    const response = await worker.GET(cronRequest('/api/cron/sync-payments'))
    const body: any = await response.json()

    assert.equal(response.status, 200)
    assert.equal(worker.completions.length, 1)
    assert.equal(worker.completions[0].status, 'success')
    assert.equal(worker.completions[0].note, 'SYNC_PAYMENTS_CRON | Status: success')

    assert.equal(worker.enqueued.length, 1)
    const notification = worker.enqueued[0]
    assert.equal(notification.reference, 'CHURCH-0001')
    // Parity with the live webhook path — this is what the poller used to miss.
    assert.equal(notification.paymentTypeCode, 'tithe')
    assert.equal(notification.tenantCode, 'grace-church')
    assert.equal(notification.webhookUrl, 'https://church.najiki.test/api/webhooks/najiki')
    assert.deepEqual(notification.fallbackWebhookSecrets, ['church_api_key'])

    assert.equal(body.results[0].status, 'resolved')
    // The poll stamp rotates the next batch; without it one payment can monopolise.
    assert.ok(worker.db.rows.paymentIntent[0].lastPolledAt instanceof Date)
  })
})

test('cron(sync-payments): a payment that is still pending is polled again later and not settled', async () => {
  await withCronSecret(async () => {
    const worker = loadSyncWorker({ status: 'pending' })
    const body: any = await worker.GET(cronRequest('/api/cron/sync-payments')).then((r) => r.json())

    assert.equal(worker.completions.length, 0)
    assert.equal(worker.enqueued.length, 0)
    assert.equal(body.results[0].status, 'still_pending')
    assert.ok(worker.db.rows.paymentIntent[0].lastPolledAt instanceof Date)
  })
})

test('cron(sync-payments): a payment whose amount does not match the poll response is not settled', async () => {
  await withCronSecret(async () => {
    const worker = loadSyncWorker({ status: 'success' })
    // The provider claims a different amount than the stored intent.
    worker.db.rows.paymentIntent[0].amount = 50000

    const body: any = await worker.GET(cronRequest('/api/cron/sync-payments')).then((r) => r.json())

    assert.equal(worker.completions.length, 0, 'an amount mismatch must not settle')
    assert.equal(body.results[0].status, 'still_pending')
  })
})

// ── /api/cron/alerts ───────────────────────────────────────────────────────

type AlertsHarness = {
  GET: (request: Request) => Promise<Response>
  alertsSent: any[]
  db: any
}

function loadAlertsWorker(options: {
  overdueNotifications?: number
  oldestNextRetryAt?: Date | null
} = {}): AlertsHarness {
  const alertsSent: any[] = []

  const db = createFakeDb({
    paymentIntent: [],
    internalNotification: [],
    smsMessage: [],
    walletAccount: [],
  })

  // Counters are what this route reads; return the configured numbers.
  db.internalNotification.count = async (args: any = {}) => {
    const where = args.where ?? {}
    if (where.status?.in?.includes?.('pending') || where.status?.in?.includes?.('failed_retrying')) {
      return options.overdueNotifications ?? 0
    }
    return 0
  }
  db.internalNotification.findFirst = async () => {
    const nextRetryAt = options.oldestNextRetryAt ?? null
    return nextRetryAt ? { nextRetryAt } : null
  }

  const route = loadTsModule<{ GET: AlertsHarness['GET'] }>('src/app/api/cron/alerts/route.ts', {
    [srcPath('lib/db.ts')]: { db },
    '@/lib/redis': { redis: { ping: async () => 'PONG' } },
    '@/lib/safe-fetch': {
      safeFetch: async (url: string, init: any) => {
        alertsSent.push({ url, body: JSON.parse(init.body) })
        return new Response('ok', { status: 200 })
      },
    },
    '@/lib/ledger': {
      reconcileAllWallets: async () => ({ wallets: [], drifting: [] }),
      describeDrift: () => '',
    },
  })

  return { GET: route.GET, alertsSent, db }
}

test('cron(alerts): an unauthenticated call reports nothing', async () => {
  const worker = loadAlertsWorker()
  const response = await worker.GET(cronRequest('/api/cron/alerts', { secret: null }))
  assert.equal(response.status, 401)
})

test('cron(alerts): a stalled retry worker is reported with the command to fix it', async () => {
  await withCronSecret(async () => {
    const previous = process.env.ALERT_WEBHOOK_URL
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.najiki.test/hook'
    try {
      const worker = loadAlertsWorker({
        overdueNotifications: 3,
        oldestNextRetryAt: new Date(Date.now() - 90 * 60 * 1000),
      })

      const body: any = await worker.GET(cronRequest('/api/cron/alerts')).then((r) => r.json())

      const stall = (body.alerts ?? []).find((alert: any) => alert.id === 'notification-worker-stalled')
      assert.ok(stall, 'a stalled retry worker must be reported')
      assert.equal(stall.severity, 'warning')
      assert.match(stall.detail, /setup-cron-schedules\.ts --verify/)
      assert.equal(body.metrics.notificationRetryOverdue, 3)
      assert.ok(body.metrics.notificationRetryLagMinutes >= 89)

      // Findings reach the operator, not just the response body.
      assert.equal(worker.alertsSent.length, 1)
    } finally {
      if (previous === undefined) delete process.env.ALERT_WEBHOOK_URL
      else process.env.ALERT_WEBHOOK_URL = previous
    }
  })
})

test('cron(alerts): a healthy retry queue raises no stall alert', async () => {
  await withCronSecret(async () => {
    const worker = loadAlertsWorker({
      overdueNotifications: 0,
      oldestNextRetryAt: new Date(Date.now() - 30 * 1000),
    })

    const body: any = await worker.GET(cronRequest('/api/cron/alerts')).then((r) => r.json())

    assert.equal(
      (body.alerts ?? []).some((alert: any) => alert.id === 'notification-worker-stalled'),
      false
    )
  })
})

// ── /api/qstash/sms-cron and /api/cron/retention ───────────────────────────

test('cron(sms): the queue drain is authenticated and reports what it did', async () => {
  await withCronSecret(async () => {
    const route = loadTsModule<{ GET: (request: Request) => Promise<Response> }>(
      'src/app/api/qstash/sms-cron/route.ts',
      {
        '@/lib/sms-queue': {
          smsQueue: { processBatch: async () => [{ id: 'sms_1', status: 'sent' }] },
          retrySmsNotifications: async () => 2,
          reconcileSmsDeliveryReports: async () => 1,
        },
        '@/lib/sms-store': {
          smsStore: {
            markStalePendingUnknown: async () => 0,
            pruneDeliveryReports: async () => 4,
          },
        },
      }
    )

    const unauthorized = await route.GET(cronRequest('/api/qstash/sms-cron', { secret: null }))
    assert.equal(unauthorized.status, 401)

    const body: any = await route.GET(cronRequest('/api/qstash/sms-cron')).then((r) => r.json())
    assert.equal(body.success, true)
    assert.equal(body.processedCount, 1)
    assert.equal(body.reportsResolved, 1)
    assert.equal(body.reportsPruned, 4)
    assert.equal(body.notificationsDelivered, 2)
  })
})

test('cron(retention): the retention sweep is authenticated', async () => {
  await withCronSecret(async () => {
    const route = loadTsModule<{ GET: (request: Request) => Promise<Response> }>(
      'src/app/api/cron/retention/route.ts',
      {
        '@/lib/retention-store': {
          applyPhoneRetention: async () => ({ maskedPayments: 2, maskedSms: 3, purged: 0 }),
        },
      }
    )

    const unauthorized = await route.GET(cronRequest('/api/cron/retention', { secret: null }))
    assert.equal(unauthorized.status, 401)

    const response = await route.GET(cronRequest('/api/cron/retention'))
    assert.equal(response.status, 200)
  })
})
