/**
 * Targeted payment repair — one reference, one operator, no guessing.
 *
 * WHY THIS EXISTS
 * ---------------
 * LivePay bills the payer GROSS and reports its own fee separately:
 *
 *   requested ....... UGX 17,000  (PaymentIntent.amount)
 *   payer billed .... UGX 17,510  (webhook `amount`, `charge: 510`)
 *   merchant got .... UGX 17,000  (LivePay dashboard balance)
 *
 * The gateway used to compare the intent to the gross, so every one of these
 * was refused (`AMOUNT_MISMATCH`), recorded as `disputed`, never credited to
 * the ledger and never announced to the partner app. `src/lib/provider-amount.ts`
 * fixes that, but payments already refused cannot be repaired by replaying the
 * webhook: the delivery was marked `processed: true`, so LivePay's retry is
 * deduped and dropped. The intent stays `processing` forever.
 *
 * WHAT THIS DOES
 * --------------
 *   1. prints the intent, then asks the provider (authenticated, tenant
 *      credentials — never the platform's) for the live status;
 *   2. shows gross / charge / net against the intent amount;
 *   3. if the provider now confirms a terminal state, settles it and delivers
 *      the partner notification (the normal, automatic path);
 *   4. otherwise refuses to move money and tells you what to check. Only an
 *      explicit `--force --net-amount=<intent amount> --reason="..."` will
 *      settle it, which is the "I have seen the money in the merchant account"
 *      human decision. The ledger is always credited the INTENT amount, never
 *      the gross: the provider's fee is not the partner's income.
 *
 * Nothing is written without `--apply`, and `--force` additionally demands
 * `--reason`, so a shell-history accident cannot credit money.
 *
 * USAGE
 *   npm run payments:repair -- --reference=CHURCH-ACC-82A982D1-E1121A6875
 *   npm run payments:repair -- --reference=CHURCH-ACC-82A982D1-E1121A6875 --apply
 *   npm run payments:repair -- --reference=... --force --net-amount=17000 \
 *       --reason="confirmed 17,510 gross / 17,000 net in LivePay portal" --apply
 */
import { db } from '../src/lib/db'
import { getPaymentProvider } from '../src/lib/providers'
import { resolveTenantOrPlatformCredentials } from '../src/lib/tenant-credentials'
import { completePayment, enqueueWebhookNotification } from '../src/lib/payments'
import {
  flushPendingNotificationsForPayment,
  reconcileSinglePaymentById,
} from '../src/lib/reconcile-payments'
import { isConfirmedTerminalStatus } from '../src/lib/payment-security'
import { checkProviderAmount } from '../src/lib/provider-amount'
import { isPlatformFeeType, resolvePartnerWebhookUrl } from '../src/lib/constants'
import { fallbackSigningSecretsFromRow, webhookSecretFromRow } from '../src/lib/application-auth'
import { safeJsonObject } from '../src/lib/json'

function arg(name: string): string | null {
  const prefix = `--${name}=`
  const hit = process.argv.find((value) => value.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) {
    const next = process.argv[index + 1]
    if (next && !next.startsWith('--')) return next
  }
  return null
}

const hasFlag = (name: string) => process.argv.includes(`--${name}`)

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(22)} ${value === null || value === undefined ? '—' : String(value)}`)
}

async function main() {
  const reference = arg('reference')
  const apply = hasFlag('apply')
  const force = hasFlag('force')
  const netAmountArg = arg('net-amount') ?? arg('netAmount')
  const reason = arg('reason')

  if (!reference) {
    console.error('Usage: npm run payments:repair -- --reference=<payment reference> [--apply] [--force --net-amount=<n> --reason="..."]')
    process.exit(2)
  }

  const payment = await db.paymentIntent.findUnique({
    where: { reference },
    include: { provider: true, application: true, tenant: true, paymentType: true },
  })

  if (!payment) {
    console.error(`No PaymentIntent with reference ${reference}`)
    process.exit(1)
  }

  console.log('\n── Payment ───────────────────────────────────────────────')
  line('reference', payment.reference)
  line('intent id', payment.id)
  line('application', payment.application?.code ?? payment.applicationId)
  line('tenant', payment.tenant?.code ?? payment.tenantId ?? null)
  line('provider', payment.provider?.code ?? payment.providerId)
  line('provider ref', payment.providerPaymentId)
  line('intent amount', `${payment.amount} ${payment.currency} (authoritative)`)
  line('status', payment.status)
  line('created', payment.createdAt?.toISOString?.() ?? payment.createdAt)

  const intentMeta = safeJsonObject(payment.metadata as unknown)
  const paymentTypeCode =
    payment.paymentType?.code ?? (intentMeta?.paymentTypeCode as string | undefined) ?? null
  const isPlatformPayment = isPlatformFeeType(paymentTypeCode)

  if (payment.status === 'success' || payment.status === 'failed') {
    console.log(`\nAlready terminal (${payment.status}) — flushing any undelivered partner notification.`)
    const delivered = await flushPendingNotificationsForPayment(payment.id, {
      fallbackWebhookSecret: payment.application?.apiKey ?? null,
      fallbackWebhookSecrets: fallbackSigningSecretsFromRow(payment.application),
    })
    console.log(`  notifications delivered: ${delivered}`)
    return
  }

  if (!payment.provider?.code) {
    console.error('\nIntent has no provider — cannot ask the provider for the truth.')
    process.exit(1)
  }

  // ── Credentials: a tenant's money is only ever read with that tenant's keys ──
  let credentials: any = undefined
  if (payment.tenantId && !isPlatformPayment) {
    const resolved = await resolveTenantOrPlatformCredentials(
      payment.tenantId,
      payment.providerId,
      payment.tenant?.code
    )
    if (!resolved) {
      console.error(
        `\nNo provider credentials for tenant ${payment.tenant?.code ?? payment.tenantId}. ` +
          'Refusing to poll with platform credentials.'
      )
      process.exit(1)
    }
    credentials = resolved.credentials
  }

  const provider = getPaymentProvider(payment.provider.code, credentials)
  if (!provider.checkPaymentStatus) {
    console.error(`\nProvider ${payment.provider.code} has no status endpoint.`)
    process.exit(1)
  }

  const status = await provider.checkPaymentStatus(
    payment.reference,
    payment.currency,
    payment.providerPaymentId || undefined
  )

  const amountCheck = checkProviderAmount({
    expected: payment.amount as unknown as number,
    reported: status.amount as number | string | null | undefined,
    charge: status.charge as number | string | null | undefined,
  })

  console.log('\n── Provider says ─────────────────────────────────────────')
  line('success', status.success)
  line('status', status.status)
  line('gross amount', status.amount)
  line('provider charge', status.charge ?? '(not reported)')
  line('net (gross-charge)', amountCheck.net)
  line('intent expects', amountCheck.expected)
  line('amount gate', amountCheck.ok ? 'PASS' : amountCheck.detail)
  line('failure reason', status.failureReason ?? null)

  const confirmed = isConfirmedTerminalStatus(status, {
    amount: Number(payment.amount),
    currency: payment.currency,
    providerPaymentId: payment.providerPaymentId,
    reference: payment.reference,
  })

  if (confirmed) {
    console.log('\nProvider confirms a terminal state. This is the normal automatic path.')
    if (!apply) {
      console.log(`DRY RUN — rerun with --apply to settle ${payment.reference}.`)
      return
    }
    const result = await reconcileSinglePaymentById(payment.id, {
      note: `MANUAL_REPAIR_SCRIPT | ${reason ?? 'operator reconcile'}`,
    })
    console.log(`\nSettled: status=${result?.status} transitioned=${result?.transitioned}`)
    console.log('The ledger was credited the INTENT amount and the partner notification was attempted.')
    return
  }

  // ── Forced settlement: requires a human to have seen the money ─────────────
  console.log('\nThe provider did NOT confirm this payment against the intent amount.')

  if (!force) {
    console.log(
      '\nNothing was written. Next steps:\n' +
        '  1. open the LivePay dashboard and confirm the settlement for this reference;\n' +
        '  2. if the merchant received the INTENT amount, settle explicitly with:\n' +
        `     npm run payments:repair -- --reference=${payment.reference} --force ` +
        `--net-amount=${Number(payment.amount)} --reason="<what you verified>" --apply\n` +
        '  3. if it did not settle, leave it alone — the intent stays processing.'
    )
    return
  }

  if (netAmountArg === null) {
    console.error('\n--force requires --net-amount=<amount the merchant actually received>.')
    process.exit(2)
  }
  const netAmount = Number(netAmountArg)
  if (!Number.isFinite(netAmount) || Math.abs(netAmount - Number(payment.amount)) > 0.001) {
    console.error(
      `\nRefusing: --net-amount=${netAmountArg} does not equal the intent amount ` +
        `${payment.amount} ${payment.currency}. The partner is credited what it asked for, ` +
        'never a provider gross figure.'
    )
    process.exit(3)
  }
  if (!reason || reason.trim().length < 8) {
    console.error('\n--force requires --reason="<what you verified and where>".')
    process.exit(2)
  }
  if (!apply) {
    console.log('\nDRY RUN — add --apply to settle.')
    return
  }

  const settledStatus = status.status === 'failed' ? 'failed' : 'success'
  const completion = await completePayment({
    paymentIntentId: payment.id,
    status: settledStatus,
    providerPaymentId: status.providerPaymentId || payment.providerPaymentId || '',
    failureReason: settledStatus === 'failed' ? status.failureReason : undefined,
    // INTENT amount: the provider's fee is not the partner's income.
    amount: Number(payment.amount),
    currency: payment.currency,
    rawProviderResponse: JSON.stringify(status),
    note: `MANUAL_REPAIR | ${reason} | provider gross=${status.amount ?? 'n/a'} charge=${status.charge ?? 'n/a'}`,
  })

  if (settledStatus === 'success') {
    await enqueueWebhookNotification({
      paymentIntentId: payment.id,
      reference: payment.reference,
      status: 'success',
      amount: Number(payment.amount),
      currency: payment.currency,
      providerPaymentId: status.providerPaymentId || payment.providerPaymentId || '',
      applicationId: payment.applicationId,
      webhookUrl: resolvePartnerWebhookUrl(payment.application),
      webhookSecret: webhookSecretFromRow(payment.application),
      fallbackWebhookSecret: payment.application?.apiKey ?? null,
      fallbackWebhookSecrets: fallbackSigningSecretsFromRow(payment.application),
      externalEntityId: payment.externalEntityId,
      tenantId: payment.tenantId,
      tenantCode: payment.tenant?.code ?? null,
      paymentTypeCode,
      metadata: intentMeta,
    })
  }

  console.log(
    `\nRepaired: status=${completion.intent.status} alreadyProcessed=${completion.wasAlreadyProcessed}`
  )
  console.log('Partner notification attempted (see log above for the delivery result).')
}

main()
  .catch((error) => {
    console.error('Repair failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect().catch(() => {})
  })
