import { db } from './db'

export interface TenantCandidate {
  id: string
  code: string
  name: string
  defaultProviderId: string | null
  isActive?: boolean
}

export type TenantMatchStrategy =
  | 'exact-code'
  | 'tenant-id'
  | 'case-insensitive-code'
  | 'slug'
  | 'single-active'
  | 'single-tenant-org-uuid'

export interface TenantResolutionResult<T extends TenantCandidate = TenantCandidate> {
  tenant: T
  matchedBy: TenantMatchStrategy
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function canonicalSlug(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Pure matching logic for resolving a partner's `tenantCode` against active
 * `Tenant` rows registered under an application.
 *
 * Handles:
 *  - Exact `code` match (`k-unity-sacco`)
 *  - Exact `id` match
 *  - Case-insensitive `code` match (`K-Unity-SACCO`)
 *  - Canonical slug match (`k_unity_sacco` <-> `k-unity-sacco` or SACCO name) when unique
 *  - Omitted `tenantCode` or unmapped Kunity organization UUID when only ONE active
 *    SACCO tenant exists under the application (never crossing tenants in multi-tenant apps!)
 */
export function matchTenantCandidate<T extends TenantCandidate>(
  tenants: T[],
  requestedTenantCode?: string | null
): TenantResolutionResult<T> | null {
  const code = String(requestedTenantCode ?? '').trim()

  if (!code) {
    if (tenants.length === 1) {
      return { tenant: tenants[0], matchedBy: 'single-active' }
    }
    return null
  }

  const exact = tenants.find((t) => t.code === code)
  if (exact) return { tenant: exact, matchedBy: 'exact-code' }

  const byId = tenants.find((t) => t.id === code)
  if (byId) return { tenant: byId, matchedBy: 'tenant-id' }

  const lower = code.toLowerCase()
  const caseInsensitive = tenants.find((t) => t.code.toLowerCase() === lower)
  if (caseInsensitive) return { tenant: caseInsensitive, matchedBy: 'case-insensitive-code' }

  const targetSlug = canonicalSlug(code)
  if (targetSlug.length >= 2) {
    const slugMatches = tenants.filter(
      (t) => canonicalSlug(t.code) === targetSlug || canonicalSlug(t.name) === targetSlug
    )
    if (slugMatches.length === 1) {
      return { tenant: slugMatches[0], matchedBy: 'slug' }
    }
  }

  // When Kunity's `public.tenants` table has no row keyed by `kunity.organizations.id`,
  // Kunity sends `tenantCode = organization_id` (UUID). In a single-SACCO deployment,
  // bridge that UUID to the single active SACCO tenant rather than failing 404.
  if (UUID_REGEX.test(code) && tenants.length === 1) {
    return { tenant: tenants[0], matchedBy: 'single-tenant-org-uuid' }
  }

  return null
}

/**
 * Authorize a `GET /api/payments/[reference]?tenantCode=...` poll against the
 * stored `PaymentIntent.tenant` using the same rules used at creation time.
 */
export function isAuthorizedTenantPoll(params: {
  intentTenant: { id: string; code: string; name?: string | null } | null | undefined
  requestedTenantCode: string | null | undefined
  intentMetadata?: Record<string, unknown> | null
  activeTenantCount?: number
}): boolean {
  const { intentTenant, requestedTenantCode, intentMetadata, activeTenantCount } = params
  if (!intentTenant) return true

  const code = String(requestedTenantCode ?? '').trim()
  if (!code) {
    return activeTenantCount === 1
  }

  if (intentTenant.code === code || intentTenant.id === code) return true
  if (intentTenant.code.toLowerCase() === code.toLowerCase()) return true

  // Exact match against the original tenantCode sent by Kunity when this intent was created
  const recordedRequestCode =
    typeof intentMetadata?.requestedTenantCode === 'string'
      ? intentMetadata.requestedTenantCode.trim()
      : ''
  if (recordedRequestCode && recordedRequestCode === code) return true

  const slug = canonicalSlug(code)
  if (
    slug.length >= 2 &&
    (canonicalSlug(intentTenant.code) === slug ||
      (intentTenant.name ? canonicalSlug(intentTenant.name) === slug : false))
  ) {
    return true
  }

  if (UUID_REGEX.test(code) && activeTenantCount === 1) return true

  return false
}

export async function resolveTenantForApplication(
  applicationId: string,
  requestedTenantCode?: string | null
) {
  const tenants = await db.tenant.findMany({
    where: { applicationId, isActive: true },
  })
  const resolved = matchTenantCandidate(tenants, requestedTenantCode)
  return {
    resolved,
    activeTenantCount: tenants.length,
    tenants,
  }
}
