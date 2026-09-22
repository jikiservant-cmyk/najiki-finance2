/**
 * Pure ledger reconciliation logic — no database, no I/O, no imports.
 *
 * Split out of `ledger.ts` so the arithmetic can be unit-tested without pulling
 * in `PrismaClient` (see the test suite's "no database, no network" contract).
 * `ledger.ts` re-exports everything here, so import from either.
 *
 * The zero-import rule is deliberate: `npm test` runs the sources through
 * Node's native type stripping, which resolves ESM specifiers literally and
 * cannot follow this codebase's extensionless imports. Keeping this module
 * dependency-free is what lets the tests reach it at all.
 */

export interface LedgerEntryLike {
  direction: string
  amountMinor: bigint | number
}

export interface WalletReconciliation {
  walletId: string
  tenantId: string
  appCode: string
  currency: string
  /** The running total stored on the wallet row. */
  balanceMinor: bigint
  /** The same total, recomputed from the immutable entries. */
  ledgerBalanceMinor: bigint
  /** `balanceMinor - ledgerBalanceMinor`. Non-zero means drift. */
  driftMinor: bigint
  entryCount: number
  balanced: boolean
}

export interface LedgerReconciliationSummary {
  walletsChecked: number
  balancedCount: number
  driftedCount: number
  drifted: WalletReconciliation[]
}

export class UnknownLedgerDirectionError extends Error {
  constructor(direction: string) {
    super(`[ledger] unknown entry direction: ${JSON.stringify(direction)}`)
    this.name = 'UnknownLedgerDirectionError'
  }
}

/**
 * Recompute a balance from immutable entries.
 *
 * Throws on an unrecognised direction rather than ignoring the row: silently
 * skipping an entry of unknown sign would make the recomputed total wrong in a
 * way that looks like real drift.
 */
export function ledgerBalanceFrom(entries: LedgerEntryLike[]): bigint {
  let total = 0n

  for (const entry of entries) {
    const amount =
      typeof entry.amountMinor === 'bigint' ? entry.amountMinor : BigInt(entry.amountMinor)

    switch (String(entry.direction ?? '').toLowerCase()) {
      case 'credit':
        total += amount
        break
      case 'debit':
        total -= amount
        break
      default:
        throw new UnknownLedgerDirectionError(String(entry.direction))
    }
  }

  return total
}

/** Pure form: compare a stored total against entries already in hand. */
export function reconcileWalletFrom(
  wallet: { id: string; tenantId: string; appCode: string; currency: string; balanceMinor: bigint },
  entries: LedgerEntryLike[]
): WalletReconciliation {
  const ledgerBalanceMinor = ledgerBalanceFrom(entries)

  return {
    walletId: wallet.id,
    tenantId: wallet.tenantId,
    appCode: wallet.appCode,
    currency: wallet.currency,
    balanceMinor: wallet.balanceMinor,
    ledgerBalanceMinor,
    driftMinor: wallet.balanceMinor - ledgerBalanceMinor,
    entryCount: entries.length,
    balanced: wallet.balanceMinor === ledgerBalanceMinor,
  }
}


