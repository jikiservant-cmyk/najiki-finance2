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

/** True when a payment type code represents a platform fee rather than a tenant collection. */
export function isPlatformFeeType(code: string | null | undefined): boolean {
  if (!code) return false
  return PLATFORM_FEE_TYPES.includes(String(code).trim().toUpperCase())
}

/**
 * Resolve the outbound webhook URL for a partner application.
 *
 * Self-heals the legacy default `/api/internal/payment-completed` path for the
 * `sacco` (Kunity) application to `/api/webhooks/najiki`, which is Kunity's actual
 * signed webhook endpoint.
 */
export function resolvePartnerWebhookUrl(application: {
  code?: string | null
  baseUrl: string
  webhookPath: string
}): string {
  const base = String(application.baseUrl || '').trim().replace(/\/+$/, '')
  let path = String(application.webhookPath || '').trim()
  if (
    String(application.code || '').trim().toLowerCase() === 'sacco' &&
    (!path || path === '/api/internal/payment-completed' || path === '/api/internal/payment-completed/')
  ) {
    path = '/api/webhooks/najiki'
  }
  if (path && !path.startsWith('/')) path = `/${path}`
  return `${base}${path}`
}

/**
 * Applications whose tenants MUST transact on configured provider credentials.
 */
export const TENANT_CREDENTIALS_REQUIRED_APP_CODES = ['sacco']

export function appRequiresTenantCredentials(applicationCode: string | null | undefined): boolean {
  return TENANT_CREDENTIALS_REQUIRED_APP_CODES.includes(String(applicationCode ?? '').toLowerCase())
}

/**
 * How far back the reconciliation workers will look for a non-terminal
 * (`pending` / `processing`) payment intent.
 *
 * Every poller used to hard-code a short window (14 days in the sweep, 7 days
 * in the cron routes). Anything that fell outside it was never polled again and
 * stayed `processing` silently forever — which is exactly what happened to the
 * intents stranded since September. The window is now one configurable value so
 * operators can drain a backlog instead of discovering it months later.
 *
 * Env: `RECONCILE_MAX_AGE_DAYS` (default 30, clamped to 1…180).
 */
export const RECONCILE_MAX_AGE_DAYS_DEFAULT = 30

export function reconcileMaxAgeDays(): number {
  const raw = Number(process.env.RECONCILE_MAX_AGE_DAYS)
  if (!Number.isFinite(raw) || raw <= 0) return RECONCILE_MAX_AGE_DAYS_DEFAULT
  return Math.min(180, Math.max(1, Math.floor(raw)))
}

/** Earliest `createdAt` a reconciliation worker should consider. */
export function reconcileCreatedAfter(now: number = Date.now()): Date {
  return new Date(now - reconcileMaxAgeDays() * 24 * 60 * 60 * 1000)
}
