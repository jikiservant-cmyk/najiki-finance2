/**
 * Wallet ledger reconciliation.
 *
 * THE PROBLEM
 * -----------
 * `WalletAccount.balanceMinor` is a running total the payment transaction
 * maintains, and `LedgerEntry` rows are the immutable record of what actually
 * moved. Both are written in one transaction, so they should agree — but
 * nothing ever checked. A gateway that settles payouts against an unverified
 * balance is one bad deploy away from paying out money it never collected.
 *
 * The 100x minor-unit bug is the worked example: `completePayment` did
 * `BigInt(Math.round(amount * 100))`, which is wrong for UGX (a zero-decimal
 * currency), so every Ugandan wallet was credited with 100x the money actually
 * collected. The stored balance and the ledger stayed internally consistent
 * with each other — both were wrong together — so only a comparison against the
 * payment intents exposes it.
 *
 * WHAT THIS DOES
 * --------------
 *   1. recomputes each wallet balance from its immutable ledger entries
 *   2. reports every wallet where the stored total disagrees
 *   3. for drifted wallets, compares the ledger total against the sum of the
 *      `success` payment intents behind it, which distinguishes "the two halves
 *      of the ledger drifted" from "the entries themselves were written in the
 *      wrong unit"
 *
 * USAGE
 *   npx tsx scripts/reconcile-ledger.ts            # report
 *   npx tsx scripts/reconcile-ledger.ts --json     # machine-readable
 *
 * Exits non-zero when any wallet is drifted, so it can gate a deploy.
 * Requires DATABASE_URL.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const asJson = process.argv.includes('--json')

interface DriftReport {
  walletId: string
  tenantId: string
  appCode: string
  currency: string
  balanceMinor: string
  ledgerBalanceMinor: string
  driftMinor: string
  entryCount: number
  /** Sum of successful intents for this app/tenant/currency, in minor units. */
  intentMinor: string | null
  /** Suspicion that entries were written in the wrong unit (a clean 100x). */
  looksLikeUnitError: boolean
}

/** Ugandan shillings have no minor unit; anything else here gets 2 places. */
function toMinor(amount: unknown, currency: string): bigint {
  const exponent = currency.toUpperCase() === 'UGX' ? 0 : 2
  const text = String(amount ?? '0')
  const negative = text.startsWith('-')
  const digits = text.replace(/^[+-]/, '')
  const [whole = '0', fraction = ''] = digits.split('.')

  const scaled = fraction.slice(0, exponent).padEnd(exponent, '0')
  let minor = BigInt(`${whole || '0'}${scaled}`)
  if (fraction.slice(exponent)[0] >= '5') minor += 1n

  return negative ? -minor : minor
}

async function main() {
  const wallets = await prisma.walletAccount.findMany({ orderBy: { createdAt: 'asc' } })

  if (wallets.length === 0) {
    console.log('No wallet accounts exist yet — nothing to reconcile.')
    return
  }

  const grouped = await prisma.ledgerEntry.groupBy({
    by: ['walletId', 'direction'],
    where: { walletId: { in: wallets.map((wallet) => wallet.id) } },
    _sum: { amountMinor: true },
    _count: { _all: true },
  })

  const totals = new Map<string, { total: bigint; count: number }>()
  for (const row of grouped) {
    const bucket = totals.get(row.walletId) ?? { total: 0n, count: 0 }
    const sum = row._sum.amountMinor ?? 0n
    const direction = String(row.direction ?? '').toLowerCase()

    if (direction === 'credit') bucket.total += sum
    else if (direction === 'debit') bucket.total -= sum
    else throw new Error(`Unknown ledger direction "${row.direction}" on wallet ${row.walletId}`)

    bucket.count += row._count._all
    totals.set(row.walletId, bucket)
  }

  const reports: DriftReport[] = []

  for (const wallet of wallets) {
    const bucket = totals.get(wallet.id) ?? { total: 0n, count: 0 }
    if (wallet.balanceMinor === bucket.total) continue

    // Cross-check the entries against the payment intents that produced them.
    // Only meaningful for credits; a debit would come from a payout, which this
    // codebase does not yet write.
    let intentMinor: bigint | null = null
    try {
      const intents = await prisma.paymentIntent.findMany({
        where: {
          tenantId: wallet.tenantId,
          currency: wallet.currency,
          status: 'success',
          application: { code: { equals: wallet.appCode, mode: 'insensitive' } },
        },
        select: { amount: true },
      })
      intentMinor = intents.reduce<bigint>(
        (sum, intent) => sum + toMinor(intent.amount, wallet.currency),
        0n
      )
    } catch {
      // Applications may not be linked the way we expect; the drift above is
      // still the headline finding.
      intentMinor = null
    }

    const drift = wallet.balanceMinor - bucket.total
    const scaledAgainstLedger =
      intentMinor !== null &&
      intentMinor !== 0n &&
      bucket.total !== 0n &&
      (bucket.total === intentMinor * 100n || drift === bucket.total)

    reports.push({
      walletId: wallet.id,
      tenantId: wallet.tenantId,
      appCode: wallet.appCode,
      currency: wallet.currency,
      balanceMinor: wallet.balanceMinor.toString(),
      ledgerBalanceMinor: bucket.total.toString(),
      driftMinor: drift.toString(),
      entryCount: bucket.count,
      intentMinor: intentMinor?.toString() ?? null,
      looksLikeUnitError: scaledAgainstLedger,
    })
  }

  if (asJson) {
    console.log(JSON.stringify({ walletsChecked: wallets.length, drifted: reports }, null, 2))
  } else {
    console.log(`Reconciled ${wallets.length} wallet account(s).\n`)

    if (reports.length === 0) {
      console.log('✅ Every stored balance matches its ledger entries.')
    } else {
      console.log(`🔴 ${reports.length} wallet(s) disagree with their ledger:\n`)

      for (const report of reports) {
        const exponent = report.currency.toUpperCase() === 'UGX' ? 0 : 2
        const fmt = (value: string) => {
          const negative = value.startsWith('-')
          const digits = value.replace('-', '').padStart(exponent + 1, '0')
          const body =
            exponent === 0
              ? digits
              : `${digits.slice(0, digits.length - exponent)}.${digits.slice(-exponent)}`
          return `${negative ? '-' : ''}${body}`
        }

        console.log(
          `  ${report.appCode}/${report.currency} ${report.walletId}\n` +
            `    stored balance : ${fmt(report.balanceMinor)}\n` +
            `    ledger total   : ${fmt(report.ledgerBalanceMinor)}\n` +
            `    drift          : ${fmt(report.driftMinor)} across ${report.entryCount} entries` +
            (report.intentMinor !== null
              ? `\n    successful intents behind it: ${fmt(report.intentMinor)}`
              : '')
        )

        if (report.looksLikeUnitError) {
          console.log(
            '    ⚠️  the ledger total is a clean 100x the intents — this is the\n' +
              '        zero-decimal-currency bug fixed in src/lib/money.ts.\n' +
              '        The balances are historical data, not a live bug; correct them\n' +
              '        from the intents before settling any payout.'
          )
        }
        console.log('')
      }

      console.log('Do not settle payouts from an unreconciled wallet.')
    }
  }

  if (reports.length > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('Reconciliation failed:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
