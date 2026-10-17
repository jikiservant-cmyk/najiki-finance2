/**
 * Provider availability, deliberately free of any import.
 *
 * `index.ts` cannot be loaded by `npm test`: it pulls in `./types` and
 * `./livepay` with extensionless specifiers, which Node's strip-only type
 * erasure does not resolve. That made the availability rules below — the ones
 * that decide whether a tenant can take money at all — impossible to test.
 *
 * Keeping this module dependency-free means `tests/tenant-provider.test.ts`
 * exercises the real code rather than a copy of it. `index.ts` re-exports
 * everything here, so existing import sites are unchanged.
 */

/**
 * Providers with a working implementation.
 *
 * This list is load-bearing, not documentation. `stub` providers throw on
 * `initiatePayment`, and the seeded database has MTN/Airtel/Pesapal rows marked
 * `isActive: true` — so "pick the first active provider" could select a provider
 * that cannot accept a payment, and did. Every provider-selection path filters
 * on this list.
 *
 * Adding a provider to this array without implementing it re-introduces the bug.
 */
export const IMPLEMENTED_PROVIDER_CODES = ['livepay'] as const

/** True when a working adapter exists for this code. */
export function isProviderImplemented(code: string | null | undefined): boolean {
  const normalized = String(code ?? '').trim().toLowerCase()
  return (IMPLEMENTED_PROVIDER_CODES as readonly string[]).includes(normalized)
}

/**
 * Providers that may be used to take a payment.
 *
 * Used to filter provider queries and to populate the Setup UI, so an operator
 * cannot configure a tenant onto a provider that will throw on first use.
 */
export function getAvailableProviders(): string[] {
  return [...IMPLEMENTED_PROVIDER_CODES as readonly string[]]
}

/** Display name for a code, for error messages. */
export function providerDisplayName(code: string): string {
  const names: Record<string, string> = {
    livepay: 'LivePay',
    mtn: 'MTN Mobile Money',
    airtel: 'Airtel Money',
    pesapal: 'Pesapal',
  }
  return names[String(code).toLowerCase()] ?? String(code)
}

/** The shape this module needs from a tenant, so it stays import-free. */
export interface TenantProviderShape {
  code: string
  isActive: boolean
  defaultProvider?: { code: string | null; name?: string | null; isActive: boolean } | null
}

/**
 * Why a tenant's default provider cannot take a payment, or `null` if it can.
 *
 * The seed ships tenants whose `defaultProviderId` points at MTN and Pesapal,
 * neither of which has an adapter. Those rows are silently inert: no payment
 * path can succeed for the tenant, and nothing in the UI said so. A `null`
 * `defaultProviderId` is allowed — the provider may be chosen per payment — so
 * that case is not reported here.
 */
export type DefaultProviderIssue = 'unimplemented' | 'inactive' | 'unimplemented-and-inactive'

export function defaultProviderIssue(tenant: TenantProviderShape): DefaultProviderIssue | null {
  const provider = tenant.defaultProvider
  // No default at all is fine: provider is chosen at payment time.
  if (!provider) return null

  const implemented = isProviderImplemented(provider.code)
  if (!implemented && !provider.isActive) return 'unimplemented-and-inactive'
  if (!implemented) return 'unimplemented'
  if (!provider.isActive) return 'inactive'
  return null
}

export interface TenantProviderProblem {
  code: string
  providerCode: string | null
  issue: DefaultProviderIssue
}

/**
 * Tenants that cannot take a payment through their default provider.
 *
 * Reported by `GET /api/setup` so an operator sees this on the page where they
 * would fix it, rather than discovering it as a stream of failed charges.
 */
export function tenantsWithDefaultProviderIssue<T extends TenantProviderShape>(
  tenants: readonly T[]
): TenantProviderProblem[] {
  const problems: TenantProviderProblem[] = []
  for (const tenant of tenants) {
    const issue = defaultProviderIssue(tenant)
    if (issue) {
      problems.push({ code: tenant.code, providerCode: tenant.defaultProvider?.code ?? null, issue })
    }
  }
  return problems
}
