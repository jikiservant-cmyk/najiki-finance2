import crypto from 'crypto'
import { db } from './db'
import { decrypt } from './encryption'
import { parseTenantProviderCredentials } from './payment-security'
import type { ProviderCredentials } from './providers/types'

export function cleanCredentialValue(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/^["']+|["']+$/g, '').trim()
}

export function cleanApiKeyValue(raw: unknown): string {
  return cleanCredentialValue(cleanCredentialValue(raw).replace(/^bearer\s+/i, ''))
}

export function cleanBaseUrlValue(raw: unknown): string {
  const cleaned = cleanCredentialValue(raw).replace(/\/+$/, '')
  return cleaned || 'https://livepay.me'
}

/**
 * Derive a deterministic >=16-char HMAC secret for tenants saved in `/setup`
 * where `Webhook Secret (Optional)` was left blank. Inbound webhooks that use a
 * different provider-assigned secret fail closed until the real secret is pasted,
 * while status polling + cron reconcile every payment securely via `apiKey`.
 */
export function deriveTenantWebhookSecret(
  apiKey: string,
  tenantId: string,
  accountNo: string
): string {
  const digest = crypto
    .createHmac('sha256', apiKey)
    .update(`najiki-tenant:${tenantId}:${accountNo}`)
    .digest('hex')
  return `lpwhsec_${digest}`
}

export function isLegacyAutoProvisionedRef(credentialsRef: unknown): boolean {
  return typeof credentialsRef === 'string' && credentialsRef.startsWith('LIVEPAY_AUTO_')
}

function decodeStoredConfig(stored: unknown): Record<string, unknown> | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
  const record = stored as Record<string, unknown>
  if (typeof record._encrypted === 'string') {
    const decoded = JSON.parse(decrypt(record._encrypted))
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null
  }
  return record
}

/**
 * Return a complete active tenant credential set for `(tenantId, providerId)`.
 *
 * - Never throws on corrupt or un-decryptable rows.
 * - Ignores legacy `LIVEPAY_AUTO_*` rows that older versions auto-copied from env.
 * - Supports SACCO credentials saved in `/setup` with `Webhook Secret (Optional)` left empty.
 * - Falls back to another active non-auto config on the same `tenantId` if `providers` has
 *   multiple rows or `providerId` changed after setup.
 */
export async function loadTenantProviderCredentials(
  tenantId: string,
  providerId: string
): Promise<ProviderCredentials | null> {
  try {
    const candidateRows: Array<{ id?: string; configJson: unknown; credentialsRef?: string | null }> = []

    const exactRow = await db.tenantProviderConfig.findFirst({
      where: { tenantId, providerId, isActive: true },
      select: { id: true, configJson: true, credentialsRef: true },
    })
    if (exactRow) candidateRows.push(exactRow)

    if (typeof (db.tenantProviderConfig as any).findMany === 'function') {
      const otherRows = await db.tenantProviderConfig.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, configJson: true, credentialsRef: true },
        orderBy: { updatedAt: 'desc' },
      })
      for (const r of otherRows) {
        if (!candidateRows.some((c) => c.id && c.id === r.id)) {
          candidateRows.push(r)
        }
      }
    }

    for (const row of candidateRows) {
      if (isLegacyAutoProvisionedRef(row.credentialsRef)) {
        if (row.id && typeof (db.tenantProviderConfig as any).delete === 'function') {
          db.tenantProviderConfig.delete({ where: { id: row.id } }).catch(() => {})
        }
        continue
      }

      let raw: Record<string, unknown> | null = null
      try {
        raw = decodeStoredConfig(row.configJson)
      } catch (decryptErr) {
        console.warn(
          `[tenant-credentials] Could not decrypt credentials for tenant=${tenantId} provider=${providerId}:`,
          decryptErr instanceof Error ? decryptErr.message : decryptErr
        )
        continue
      }
      if (!raw) continue

      const apiKey = cleanApiKeyValue(raw.apiKey ?? raw.api_key)
      const accountNo = cleanCredentialValue(raw.accountNo ?? raw.account_number ?? raw.accountNumber)
      const explicitSecret = cleanCredentialValue(raw.webhookSecret ?? raw.webhook_secret)
      const baseUrl = cleanBaseUrlValue(raw.baseUrl ?? raw.base_url)

      if (!apiKey || !accountNo) continue

      const webhookSecret =
        explicitSecret.length >= 16
          ? explicitSecret
          : deriveTenantWebhookSecret(apiKey, tenantId, accountNo)

      const parsed = parseTenantProviderCredentials({
        apiKey,
        accountNo,
        webhookSecret,
        baseUrl,
      })
      if (parsed) return parsed
    }

    return null
  } catch (err) {
    console.warn(
      `[tenant-credentials] Could not load tenant credentials for tenant=${tenantId} provider=${providerId}:`,
      err instanceof Error ? err.message : err
    )
    return null
  }
}

export type ResolvedTenantCredentials = {
  source: 'tenant' | 'platform' | 'platform-env'
  /** Explicit credentials for getPaymentProvider(code, credentials), or undefined to use platform env directly. */
  credentials: ProviderCredentials | undefined
}

/**
 * Resolve usable provider credentials for a tenant payment/poll/webhook:
 *   1. Prefer explicit per-tenant SACCO credentials from `tenant_provider_configs`.
 *   2. Fall back in memory ONLY to platform LivePay env vars when a SACCO has not
 *      yet configured custom keys (never writing platform keys into `tenant_provider_configs`).
 *   3. Return `null` when neither tenant config nor platform LivePay keys exist.
 */
export async function resolveTenantOrPlatformCredentials(
  tenantId: string,
  providerId: string,
  tenantCode?: string | null
): Promise<ResolvedTenantCredentials | null> {
  const existing = await loadTenantProviderCredentials(tenantId, providerId)
  if (existing) {
    return { source: 'tenant', credentials: existing }
  }

  const platformApiKey = cleanApiKeyValue(process.env.LIVEPAY_API_KEY)
  const platformAccountNo = cleanCredentialValue(
    process.env.LIVEPAY_ACCOUNT_NO || process.env.LIVEPAY_ACCOUNT_NUMBER
  )
  const platformWebhookSecret = cleanCredentialValue(
    process.env.LIVEPAY_WEBHOOK_SECRET || process.env.LIVEPAY_SECRET_KEY
  )
  const platformBaseUrl = cleanBaseUrlValue(process.env.LIVEPAY_BASE_URL)

  if (!platformApiKey || !platformAccountNo) {
    return null
  }

  if (platformWebhookSecret.length >= 16) {
    console.warn(
      `[tenant-credentials] Tenant "${tenantCode || tenantId}" has no custom credentials in Setup — using platform LivePay fallback in memory.`
    )
    return {
      source: 'platform',
      credentials: {
        apiKey: platformApiKey,
        accountNo: platformAccountNo,
        webhookSecret: platformWebhookSecret,
        baseUrl: platformBaseUrl,
      },
    }
  }

  console.warn(
    `[tenant-credentials] Tenant "${tenantCode || tenantId}" has no custom credentials in Setup — using platform env LivePay credentials.`
  )
  return { source: 'platform-env', credentials: undefined }
}
