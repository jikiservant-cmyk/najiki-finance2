/**
 * Money integrity — the invariants that decide whether this thing may hold real
 * shillings.
 *
 * These are not feature tests. Each one is a way a gateway loses money that the
 * type system does not catch and a happy-path test does not notice:
 *
 *   • an initiate response arriving after the provider's callback overwriting a
 *     settled status (and letting the payment be completed twice),
 *   • a wallet balance that drifts from its own ledger, so the number a tenant
 *     is paid out from is larger than the money that was received,
 *   • a currency conversion that credits 100x (UGX has no minor unit),
 *   • a failed payment crediting anything at all.
 *
 * `completePayment` and `processPayment` are the only two places money moves,
 * so they are driven here for real — against an in-memory Prisma stand-in whose
 * `$transaction` runs the callback the same way Prisma does.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeDb, type Row } from './helpers/fake-db.ts'
import { loadTsModule, srcPath } from './helpers/ts-load.ts'

const APPLICATION = {
  id: 'app_church',
  code: 'church',
  name: 'Church App',
  baseUrl: 'https://church.najiki.app',
  webhookPath: '/api/webhooks/najiki',
  internalSecretRef: '',
  isActive: true,
}

const TENANT = { id: 'tenant_grace', code: 'grace-church', name: 'Grace Community Church' }

function intentRow(overrides: Row = {}): Row {
  return {
    id: 'pi_church_1',
    applicationId: 'app_church',
    tenantId: 'tenant_grace',
    paymentTypeId: null,
    externalEntityId: 'member_42',
    reference: 'CHURCH-0001',
    idempotencyKey: 'idem-church-0001',
    amount: 5000,
    currency: 'UGX',
    phoneNumber: '256700000000',
    providerId: 'prov_livepay',
    providerPaymentId: null,
    status: 'pending',
    metadata: '{}',
    failureReason: null,
    application: APPLICATION,
    tenant: TENANT,
    paymentType: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function walletRow(overrides: Row = {}): Row {
  return {
    id: 'wallet_1',
    tenantId: 'tenant_grace',
    appCode: 'church',
    currency: 'UGX',
    balanceMinor: 5000n,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function ledgerRow(overrides: Row = {}): Row {
  return {
    id: 'entry_1',
    walletId: 'wallet_1',
    paymentIntentId: 'pi_church_1',
    direction: 'credit',
    amountMinor: 5000n,
    currency: 'UGX',
    entryType: 'payment_in',
    idempotencyKey: 'pi_church_1:payment_in',
    balanceAfterMinor: 5000n,
    createdAt: new Date(),
    ...overrides,
  }
}

type ProviderResponse = {
  status: string
  providerPaymentId?: string
  failureReason?: string
}

/**
 * Load the real payments module with Prisma, the provider socket and the
 * outbound webhook replaced. Nothing in the money path itself is stubbed.
 */
function loadPayments(
  seed: Record<string, Row[]>,
  options: { providerResponse?: ProviderResponse; providerThrows?: Error } = {}
) {
  const db = createFakeDb({
    application: [APPLICATION],
    tenant: [TENANT],
    paymentIntent: [],
    walletAccount: [],
    ledgerEntry: [],
    internalNotification: [],
    paymentTransaction: [],
    ...seed,
  })

  const calls = { initiatePayments: 0, webhookSends: 0 }

  const payments = loadTsModule<any>('src/lib/payments.ts', {
    [srcPath('lib/db.ts')]: { db },
    [srcPath('lib/tenant-credentials.ts')]: {
      resolveTenantOrPlatformCredentials: async () => ({ credentials: {} }),
    },
    [srcPath('lib/providers/index.ts')]: {
      getPaymentProvider: () => ({
        initiatePayment: async () => {
          calls.initiatePayments += 1
          if (options.providerThrows) throw options.providerThrows
          return options.providerResponse ?? { status: 'pending', providerPaymentId: 'LP_1' }
        },
      }),
    },
    [srcPath('lib/application-auth.ts')]: {
      webhookSecretFromRow: () => 'njk_whsec_test',
      fallbackSigningSecretsFromRow: () => [],
    },
    [srcPath('lib/safe-fetch.ts')]: {
      safeFetch: async () => {
        calls.webhookSends += 1
        return new Response('{"received":true}', { status: 200 })
      },
      validateSafeUrl: async (url: string) => new URL(url),
      isPlaceholderUrl: () => false,
    },
  })

  return { payments, db, calls }
}

function completionArgs(overrides: Row = {}) {
  return {
    paymentIntentId: 'pi_church_1',
    status: 'success',
    providerPaymentId: 'LP_TX_1',
    amount: 5000,
    currency: 'UGX',
    rawProviderResponse: '{"status":"success"}',
    ...overrides,
  }
}

function processArgs(overrides: Row = {}) {
  return {
    paymentIntentId: 'pi_church_1',
    amount: 5000,
    currency: 'UGX',
    phoneNumber: '256700000000',
    reference: 'CHURCH-0001',
    providerCode: 'livepay',
    description: 'Tithe',
    metadata: {},
    webhookUrl: 'https://church.najiki.app/api/webhooks/najiki',
    ...overrides,
  }
}

// ── The credit itself ───────────────────────────────────────────────────────

test('money: a 5,000 UGX collection credits 5,000 minor units — not 500,000', async () => {
  // UGX has no minor unit. The platform used to multiply by 100 here, so every
  // wallet balance on the home currency was 100x the money actually received.
  const { payments, db } = loadPayments({ paymentIntent: [intentRow()] })

  await payments.completePayment(completionArgs())

  assert.equal(db.rows.walletAccount.length, 1)
  assert.equal(db.rows.walletAccount[0].balanceMinor, 5000n)

  assert.equal(db.rows.ledgerEntry.length, 1)
  const entry = db.rows.ledgerEntry[0]
  assert.equal(entry.amountMinor, 5000n)
  assert.equal(entry.direction, 'credit')
  assert.equal(entry.entryType, 'payment_in')
  assert.equal(entry.balanceAfterMinor, 5000n)
  assert.equal(entry.idempotencyKey, 'pi_church_1:payment_in')
})

test('money: a failed payment credits nothing and writes no ledger entry', async () => {
  const { payments, db } = loadPayments({ paymentIntent: [intentRow()] })

  await payments.completePayment(completionArgs({ status: 'failed', providerPaymentId: null, failureReason: 'Insufficient funds' }))

  assert.equal(db.rows.walletAccount.length, 0)
  assert.equal(db.rows.ledgerEntry.length, 0)
  assert.equal(db.rows.paymentIntent[0].status, 'failed')
  // The partner is still told, so the member's app can show the failure.
  assert.equal(db.rows.internalNotification.length, 1)
})

test('money: completing the same payment twice credits once', async () => {
  const { payments, db } = loadPayments({ paymentIntent: [intentRow()] })

  await payments.completePayment(completionArgs())
  const afterFirst = db.rows.walletAccount[0].balanceMinor

  // A delayed retry of the same webhook.
  await payments.completePayment(completionArgs())

  assert.equal(db.rows.walletAccount[0].balanceMinor, afterFirst)
  assert.equal(db.rows.ledgerEntry.length, 1)
})

test('money: a wallet can never be incremented without its ledger entry', async () => {
  // The dangerous shape: the intent says success, the ledger already has the
  // entry, but the balance is incremented anyway. Then `balance` no longer
  // equals the sum of entries, and the tenant is paid out money that was never
  // received. This happens if the status guard above is bypassed — a late
  // duplicate callback after a status regression, for example.
  const { payments, db } = loadPayments({
    paymentIntent: [intentRow()],
    walletAccount: [walletRow()],
    ledgerEntry: [ledgerRow()],
  })

  await payments.completePayment(completionArgs())

  assert.equal(
    db.rows.walletAccount[0].balanceMinor,
    5000n,
    'an existing ledger entry means the money was already credited; the balance must not move'
  )
  assert.equal(db.rows.ledgerEntry.length, 1)
})

test('money: a second collection on the same wallet adds to it and records the running balance', async () => {
  const { payments, db } = loadPayments({
    paymentIntent: [intentRow()],
    walletAccount: [walletRow({ balanceMinor: 12000n, version: 3 })],
    ledgerEntry: [],
  })

  await payments.completePayment(completionArgs({ amount: 5000 }))

  assert.equal(db.rows.walletAccount[0].balanceMinor, 17000n)
  assert.equal(db.rows.ledgerEntry[0].balanceAfterMinor, 17000n)
  assert.equal(db.rows.walletAccount[0].version, 4)
})

test('money: a payment already marked failed is never resurrected as a success', async () => {
  // Deliberate: a late callback that disagrees with a settled outcome must be
  // investigated, not silently credited. The cost of being wrong here is a
  // duplicated credit; the cost of not crediting is a call to the provider.
  const { payments, db } = loadPayments({
    paymentIntent: [intentRow({ status: 'failed' })],
  })

  const result = await payments.completePayment(completionArgs())

  assert.equal(result.wasAlreadyProcessed, true)
  assert.equal(db.rows.paymentIntent[0].status, 'failed')
  assert.equal(db.rows.ledgerEntry.length, 0)
})

// ── The initiate/callback race ──────────────────────────────────────────────

test('money: an initiate response cannot overwrite a payment the callback already settled', async () => {
  // Timeline this guards: the gateway calls the provider, the provider is slow
  // to answer but the member approves on their phone, the webhook arrives and
  // settles the payment — and then the initiate call returns "pending" and
  // writes that over the top. The intent now says pending for a payment that
  // has been credited. The next callback completes it again, and the wallet is
  // credited twice.
  const { payments, db } = loadPayments(
    { paymentIntent: [intentRow({ status: 'success' })] },
    { providerResponse: { status: 'pending', providerPaymentId: 'LP_1' } }
  )

  await payments.processPayment(processArgs())

  assert.equal(
    db.rows.paymentIntent[0].status,
    'success',
    'a settled payment must not be moved back to pending by the initiate response'
  )
})

test('money: an ambiguous initiate failure cannot overwrite a settled payment either', async () => {
  // Same race, in the error branch: the provider call times out, but the money
  // was collected and the callback already settled the intent. `processing`
  // here would make the intent look un-settled and allow a second credit.
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  })
  const { payments, db } = loadPayments(
    { paymentIntent: [intentRow({ status: 'success' })] },
    { providerThrows: timeout }
  )

  await payments.processPayment(processArgs())

  assert.equal(db.rows.paymentIntent[0].status, 'success')
})

test('money: an ambiguous initiate failure leaves a still-pending payment reconcilable, not failed', async () => {
  const timeout = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  const { payments, db } = loadPayments(
    { paymentIntent: [intentRow()] },
    { providerThrows: timeout }
  )

  await payments.processPayment(processArgs())

  // Marking it `failed` would tell the partner "no money moved" while the
  // provider may well have collected it.
  assert.equal(db.rows.paymentIntent[0].status, 'processing')
  assert.match(String(db.rows.paymentIntent[0].failureReason), /INITIATE_AMBIGUOUS/)
})

test('money: a normal initiate still moves a pending payment forward', async () => {
  const { payments, db } = loadPayments(
    { paymentIntent: [intentRow()] },
    { providerResponse: { status: 'processing', providerPaymentId: 'LP_9' } }
  )

  await payments.processPayment(processArgs())

  assert.equal(db.rows.paymentIntent[0].status, 'processing')
  assert.equal(db.rows.paymentIntent[0].providerPaymentId, 'LP_9')
})
