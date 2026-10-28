/**
 * Reconciliation window.
 *
 * Every poller used to hard-code how far back it looked: the dashboard sweep
 * used 14 days, both cron routes used 7. A payment that fell outside that window
 * while still `pending` / `processing` was never polled again and simply sat
 * there — that is how intents from September were still `processing` in
 * production months later, with nothing anywhere saying so.
 *
 * These tests lock in the two properties that fix actually needs:
 *   1. the window is one configurable value (default 30 days, clamped);
 *   2. intents older than the window are COUNTED and reported, not ignored.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeDb, type Row } from './helpers/fake-db.ts'
import { loadTsModule, srcPath } from './helpers/ts-load.ts'
import { RECONCILE_MAX_AGE_DAYS_DEFAULT, reconcileCreatedAfter, reconcileMaxAgeDays } from '../src/lib/constants.ts'

const DAY = 24 * 60 * 60 * 1000

function loadReconcile() {
  const db = createFakeDb()
  const polled: string[] = []

  const providersStub = {
    getPaymentProvider: () => ({
      async checkPaymentStatus() {
        return { success: true, status: 'processing' as const }
      },
    }),
  }

  const paymentsStub = {
    async completePayment() {
      throw new Error('a still-processing payment must never be settled by the sweep')
    },
    async deliverQueuedNotification() {
      return { success: true }
    },
    async enqueueWebhookNotification() {},
    async recordNotificationDelivered() {},
    async recordNotificationFailure() {},
  }

  const reconcile = loadTsModule<{
    reconcileProcessingPayments: (opts?: any) => Promise<any>
    reconcileSinglePaymentById: (id: string, opts?: any) => Promise<any>
  }>('src/lib/reconcile-payments.ts', {
    [srcPath('lib/db.ts')]: { db },
    '@/lib/db': { db },
    [srcPath('lib/providers/index.ts')]: providersStub,
    [srcPath('lib/payments.ts')]: paymentsStub,
    [srcPath('lib/tenant-credentials.ts')]: {
      async resolveTenantOrPlatformCredentials() {
        return { credentials: {} }
      },
    },
    [srcPath('lib/application-auth.ts')]: {
      webhookSecretFromRow: () => 'outbound-secret',
      fallbackSigningSecretsFromRow: () => [],
    },
  })

  return { db, reconcile, polled }
}

function intentRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'pi_1',
    reference: 'REF_1',
    amount: 17000,
    currency: 'UGX',
    status: 'processing',
    providerPaymentId: 'lp_1',
    failureReason: null,
    applicationId: 'app_1',
    tenantId: null,
    providerId: 'prov_livepay',
    externalEntityId: null,
    metadata: '{}',
    lastPolledAt: null,
    createdAt: new Date(),
    provider: { id: 'prov_livepay', code: 'livepay' },
    application: {
      id: 'app_1',
      code: 'church',
      baseUrl: 'https://church.test',
      webhookPath: '/api/webhooks/najiki',
      apiKey: 'church-key-0123456789',
      webhookSecretEncrypted: null,
      internalSecretRef: null,
    },
    tenant: null,
    paymentType: null,
    ...overrides,
  }
}

test('reconcile window: RECONCILE_MAX_AGE_DAYS is configurable and clamped', () => {
  const original = process.env.RECONCILE_MAX_AGE_DAYS
  try {
    delete process.env.RECONCILE_MAX_AGE_DAYS
    assert.equal(reconcileMaxAgeDays(), RECONCILE_MAX_AGE_DAYS_DEFAULT)
    assert.equal(RECONCILE_MAX_AGE_DAYS_DEFAULT, 30)

    process.env.RECONCILE_MAX_AGE_DAYS = '60'
    assert.equal(reconcileMaxAgeDays(), 60)
    const cutoff = reconcileCreatedAfter()
    const expected = Date.now() - 60 * DAY
    assert.ok(Math.abs(cutoff.getTime() - expected) < 5_000)

    // Nonsense, zero and negative fall back to the default rather than
    // accidentally sweeping (or never sweeping) everything.
    process.env.RECONCILE_MAX_AGE_DAYS = '0'
    assert.equal(reconcileMaxAgeDays(), RECONCILE_MAX_AGE_DAYS_DEFAULT)
    process.env.RECONCILE_MAX_AGE_DAYS = '-5'
    assert.equal(reconcileMaxAgeDays(), RECONCILE_MAX_AGE_DAYS_DEFAULT)
    process.env.RECONCILE_MAX_AGE_DAYS = 'soon'
    assert.equal(reconcileMaxAgeDays(), RECONCILE_MAX_AGE_DAYS_DEFAULT)

    // Upper bound: a typo must not create an unbounded sweep.
    process.env.RECONCILE_MAX_AGE_DAYS = '99999'
    assert.equal(reconcileMaxAgeDays(), 180)
  } finally {
    if (original === undefined) delete process.env.RECONCILE_MAX_AGE_DAYS
    else process.env.RECONCILE_MAX_AGE_DAYS = original
  }
})

test('reconcile window: intents older than the window are counted, not silently ignored', async () => {
  const original = process.env.RECONCILE_MAX_AGE_DAYS
  process.env.RECONCILE_MAX_AGE_DAYS = '30'
  try {
    const { db, reconcile } = loadReconcile()
    const now = Date.now()

    db.rows.paymentIntent = [
      // inside the window — must be polled
      intentRow({ id: 'pi_fresh', reference: 'REF_FRESH', createdAt: new Date(now - 2 * DAY) }),
      // exactly the September backlog: outside the window, must be reported
      intentRow({ id: 'pi_old_1', reference: 'REF_OLD_1', createdAt: new Date(now - 60 * DAY) }),
      intentRow({ id: 'pi_old_2', reference: 'REF_OLD_2', createdAt: new Date(now - 40 * DAY) }),
      // already terminal — must not be counted as stranded
      intentRow({ id: 'pi_done', reference: 'REF_DONE', status: 'success', createdAt: new Date(now - 90 * DAY) }),
    ]

    const result = await reconcile.reconcileProcessingPayments({
      limit: 10,
      minAgeMs: 0,
      minPollIntervalMs: 0,
      budgetMs: 5_000,
    })

    assert.equal(result.maxAgeDays, 30)
    assert.equal(result.polled, 1, 'only the in-window intent is polled')
    assert.equal(result.transitioned, 0)
    assert.equal(
      result.strandedBeyondWindow,
      2,
      'the two intents older than the window are surfaced; the settled one is not'
    )
    assert.deepEqual(
      result.details.map((detail: any) => detail.reference),
      ['REF_FRESH']
    )
  } finally {
    if (original === undefined) delete process.env.RECONCILE_MAX_AGE_DAYS
    else process.env.RECONCILE_MAX_AGE_DAYS = original
  }
})

test('reconcile window: widening the window lets the backlog be drained deliberately', async () => {
  const original = process.env.RECONCILE_MAX_AGE_DAYS
  process.env.RECONCILE_MAX_AGE_DAYS = '120'
  try {
    const { db, reconcile } = loadReconcile()
    const now = Date.now()
    db.rows.paymentIntent = [
      intentRow({ id: 'pi_old_1', reference: 'REF_OLD_1', createdAt: new Date(now - 60 * DAY) }),
      intentRow({ id: 'pi_old_2', reference: 'REF_OLD_2', createdAt: new Date(now - 40 * DAY) }),
    ]

    const result = await reconcile.reconcileProcessingPayments({
      limit: 10,
      minAgeMs: 0,
      minPollIntervalMs: 0,
      budgetMs: 5_000,
    })

    assert.equal(result.maxAgeDays, 120)
    assert.equal(result.polled, 2)
    assert.equal(result.strandedBeyondWindow, 0)
  } finally {
    if (original === undefined) delete process.env.RECONCILE_MAX_AGE_DAYS
    else process.env.RECONCILE_MAX_AGE_DAYS = original
  }
})
