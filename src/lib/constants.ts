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
 * Applications whose tenants MUST transact on their own provider credentials.
 *
 * SACCOs are regulated cooperatives: each one's collections must land in its
 * own provider account, never commingled with other tenants' money or the
 * platform's. A payment for one of these tenants is REFUSED when no active
 * per-tenant credentials are configured — the platform's global credentials
 * are never a fallback for them. Platform-fee payments (SMS purchases,
 * activation fees, subscriptions — see PLATFORM_FEE_TYPES) are exempt: they
 * are platform revenue by definition and settle on the platform's own LivePay
 * account (the "platform wallet").
 */
export const TENANT_CREDENTIALS_REQUIRED_APP_CODES = ['sacco']

export function appRequiresTenantCredentials(applicationCode: string | null | undefined): boolean {
  return TENANT_CREDENTIALS_REQUIRED_APP_CODES.includes(String(applicationCode ?? '').toLowerCase())
}
