/**
 * Wallet ledger reconciliation (database-backed).
 *
 * `WalletAccount.balanceMinor` is a running total that the payment transaction
 * maintains, while `LedgerEntry` rows are the immutable record of what actually
 * moved. Both are written inside the same transaction, so they should never
 * disagree — but "should never" is not a control, and a settlement process that
 * pays tenants out of a total nobody has independently verified is how a
 * gateway quietly becomes insolvent.
 *
 * This module recomputes each balance from the entries and reports every wallet
 * where the two disagree.
 *
 * This is exactly the check that catches the 100x minor-unit bug fixed in
 * `src/lib/money.ts`: the stored balance was inflated relative to the intents
 * that produced it, and nothing compared the two. Run
 * `npm run ledger:reconcile` against any database that took payments before
 * that fix.
 *
 * The arithmetic lives in `ledger-core.ts` so it can be tested without a
 * database; everything here does I/O.
 */

import { db } from './db'
import { minorUnitsToDecimalString } from './money'
import {
  reconcileWalletFrom,
  UnknownLedgerDirectionError,
  type LedgerReconciliationSummary,
  type WalletReconciliation,
} from './ledger-core'

export * from './ledger-core'

/**
 * Human-readable summary line for a drifted wallet. Lives here rather than in
 * `ledger-core.ts` because it needs `money.ts`, and that module must keep its
 * zero-import rule to stay testable (see its header).
 */
export function describeDrift(wallet: WalletReconciliation): string {
  const fmt = (value: bigint) => minorUnitsToDecimalString(value, wallet.currency)
  return (
    `${wallet.appCode}/${wallet.currency} wallet ${wallet.walletId}: ` +
    `stored ${fmt(wallet.balanceMinor)} but ledger says ${fmt(wallet.ledgerBalanceMinor)} ` +
    `(drift ${fmt(wallet.driftMinor)} over ${wallet.entryCount} entries)`
  )
}

/** Reconcile one wallet against its own entries. */
export async function reconcileWallet(walletId: string): Promise<WalletReconciliation | null> {
  const wallet = await db.walletAccount.findUnique({ where: { id: walletId } })
  if (!wallet) return null

  const entries = await db.ledgerEntry.findMany({
    where: { walletId },
    select: { direction: true, amountMinor: true },
  })

  return reconcileWalletFrom(
    {
      id: wallet.id,
      tenantId: wallet.tenantId,
      appCode: wallet.appCode,
      currency: wallet.currency,
      balanceMinor: wallet.balanceMinor,
    },
    entries
  )
}

/**
 * Reconcile every wallet.
 *
 * Balances are summed with a grouped aggregate rather than by loading every
 * entry: a busy gateway accumulates millions of ledger rows and this runs on a
 * schedule.
 */
export async function reconcileAllWallets(limit = 1000): Promise<LedgerReconciliationSummary> {
  const wallets = await db.walletAccount.findMany({
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  if (wallets.length === 0) {
    return { walletsChecked: 0, balancedCount: 0, driftedCount: 0, drifted: [] }
  }

  const grouped = await db.ledgerEntry.groupBy({
    by: ['walletId', 'direction'],
    where: { walletId: { in: wallets.map((wallet) => wallet.id) } },
    _sum: { amountMinor: true },
    _count: { _all: true },
  })

  const perWallet = new Map<string, { total: bigint; count: number }>()

  for (const row of grouped) {
    const bucket = perWallet.get(row.walletId) ?? { total: 0n, count: 0 }
    const sum = row._sum.amountMinor ?? 0n

    switch (String(row.direction ?? '').toLowerCase()) {
      case 'credit':
        bucket.total += sum
        break
      case 'debit':
        bucket.total -= sum
        break
      default:
        throw new UnknownLedgerDirectionError(String(row.direction))
    }

    bucket.count += row._count._all
    perWallet.set(row.walletId, bucket)
  }

  const drifted: WalletReconciliation[] = []
  let balancedCount = 0

  for (const wallet of wallets) {
    const bucket = perWallet.get(wallet.id) ?? { total: 0n, count: 0 }

    if (wallet.balanceMinor === bucket.total) {
      balancedCount += 1
      continue
    }

    drifted.push({
      walletId: wallet.id,
      tenantId: wallet.tenantId,
      appCode: wallet.appCode,
      currency: wallet.currency,
      balanceMinor: wallet.balanceMinor,
      ledgerBalanceMinor: bucket.total,
      driftMinor: wallet.balanceMinor - bucket.total,
      entryCount: bucket.count,
      balanced: false,
    })
  }

  return {
    walletsChecked: wallets.length,
    balancedCount,
    driftedCount: drifted.length,
    drifted,
  }
}
