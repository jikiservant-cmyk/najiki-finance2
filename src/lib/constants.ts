/**
 * Tenant / platform money-routing rules.
 *
 * THE INVARIANT
 * -------------
 * Money collected on behalf of a tenant (a SACCO, a church, a school) must land
 * in the TENANT's own provider account and be confirmed by the TENANT's own
 * webhook secret. Platform credentials are for platform revenue only.
 *
 * Two pen-test findings shaped this file:
 *
 *   F-1  The list of applications under enforcement was a hardcoded
 *        `['sacco']`. Creating an application called `sacco2` silently routed
 *        its tenants' money through the platform account, with no error. The
 *        list is now env-overridable so a new application can be brought under
 *        enforcement without a deploy — and `listUnenforcedApplications()`
 *        exists so the gap can be *seen* rather than discovered by an accountant.
 *
 *   F-2  `LivePayProvider` falls back to platform env vars PER FIELD
 *        (`config?.accountNo || process.env.LIVEPAY_ACCOUNT_NO`). A tenant
 *        config with `apiKey` set but `accountNo` blank therefore authenticated
 *        as the tenant and settled into the PLATFORM account number. Credential
 *        material is now all-or-nothing: a partial row is treated as no row.
 *
 * Zero imports, so the test runner can reach it (see tests/tenant-isolation.test.ts).
 */

/** Applications whose tenants must transact on their own provider credentials. */
export const DEFAULT_TENANT_CREDENTIAL_APP_CODES = ['sacco']

/**
 * Payment types that are platform revenue by definition.
 *
 * These settle on the platform's own provider account and are exempt from
 * per-tenant credential enforcement — an SMS purchase or a subscription fee is
 * the platform being paid, not a tenant collecting from its members.
 */
export const PLATFORM_FEE_TYPES = [
  'SMS',
  'BUY_SMS',
  'SMS_TOPUP',
  'ACTIVATION',
  'ACCOUNT_ACTIVATION',
  'SUBSCRIPTION',
  'MONTHLY_SUBSCRIPTION',
  'PLATFORM_FEE'
]

/**
 * The application codes currently under tenant-credential enforcement.
 *
 * Overridable with `TENANT_CREDENTIALS_REQUIRED_APP_CODES=sacco,church,school`
 * so a new SACCO application can be enforced without shipping a deploy. Comma
 * separated, case-insensitive, whitespace tolerant.
 *
 * Matching remains EXACT on `application.code` — `sacco2` is not covered by
 * `sacco`. That is deliberate (a prefix rule would silently capture unrelated
 * applications) and it is exactly why {@link listUnenforcedApplications} exists.
 */
export function tenantCredentialAppCodes(): string[] {
  const configured = process.env.TENANT_CREDENTIALS_REQUIRED_APP_CODES
  if (configured && configured.trim()) {
    const parsed = configured
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
    if (parsed.length > 0) return parsed
  }
  return DEFAULT_TENANT_CREDENTIAL_APP_CODES
}

/**
 * True when this application's tenants must use their own provider credentials.
 *
 * SACCOs are regulated cooperatives: each one's collections must land in its own
 * provider account, never commingled with other tenants' money or the platform's.
 */
export function appRequiresTenantCredentials(applicationCode: string | null | undefined): boolean {
  const code = String(applicationCode ?? '').trim().toLowerCase()
  return code.length > 0 && tenantCredentialAppCodes().includes(code)
}

/** True when this payment type is platform revenue rather than a tenant collection. */
export function isPlatformFeeType(paymentTypeCode: string | null | undefined): boolean {
  const code = String(paymentTypeCode ?? '').trim().toUpperCase()
  return code.length > 0 && PLATFORM_FEE_TYPES.includes(code)
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential completeness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A decrypted tenant credential blob. Field names vary because the blob is
 * written by the Setup form and has outlived two renames; the provider
 * constructor accepts every spelling, so so must this check.
 */
export interface TenantCredentialMaterial {
  apiKey?: string | null
  api_key?: string | null
  accountNo?: string | null
  account_number?: string | null
  accountNumber?: string | null
  webhookSecret?: string | null
  webhook_secret?: string | null
  [key: string]: unknown
}

function firstNonEmpty(values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/**
 * Which of the three required credential fields are missing or blank.
 *
 * All three are required because the provider substitutes platform env values
 * for whichever one is absent — so "mostly configured" is the dangerous state,
 * not the obviously-empty one. An empty `{}` fails loudly and gets caught; a
 * row with an API key and no account number used to authenticate as the tenant
 * and pay into the platform account.
 */
export function missingCredentialFields(raw: unknown): string[] {
  const creds = (raw && typeof raw === 'object' ? raw : {}) as TenantCredentialMaterial
  const missing: string[] = []
  if (!firstNonEmpty([creds.apiKey, creds.api_key])) missing.push('apiKey')
  if (!firstNonEmpty([creds.accountNo, creds.account_number, creds.accountNumber])) {
    missing.push('accountNo')
  }
  if (!firstNonEmpty([creds.webhookSecret, creds.webhook_secret])) missing.push('webhookSecret')
  return missing
}

/**
 * True only when every required credential field is present and non-blank.
 *
 * This is the all-or-nothing gate. A row that fails it must be treated as
 * ABSENT, not as a partial override — see {@link missingCredentialFields}.
 */
export function isCompleteTenantCredentials(raw: unknown): boolean {
  return missingCredentialFields(raw).length === 0
}

/**
 * A legacy row stores credentials in the clear; a current row stores
 * `{ _encrypted: "<iv>:<tag>:<ciphertext>" }`. True when the blob still holds
 * plaintext credentials that need migrating.
 */
export function isLegacyPlaintextCredentialBlob(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const blob = raw as Record<string, unknown>
  return typeof blob._encrypted !== 'string' && missingCredentialFields(blob).length < 3
}

// ─────────────────────────────────────────────────────────────────────────────
// Visibility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applications that HAVE tenants but are NOT under tenant-credential enforcement.
 *
 * Every one of these collects its tenants' money on the platform's provider
 * account. For a church or school app that may be intentional; for a second
 * SACCO application it is a regulatory problem. Either way it should be a
 * decision somebody made, not a side effect of what someone typed into the
 * `code` field in Setup.
 *
 * Pure and side-effect-free: the caller supplies the rows.
 */
export function listUnenforcedApplications(
  applications: Array<{ code: string; tenants?: unknown[]; _count?: { tenants?: number } | null }>
): string[] {
  return applications
    .filter((app) => {
      const tenantCount = Array.isArray(app.tenants) ? app.tenants.length : app._count?.tenants ?? 0
      return tenantCount > 0 && !appRequiresTenantCredentials(app.code)
    })
    .map((app) => app.code)
}
