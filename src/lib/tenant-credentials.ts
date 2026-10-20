import { db } from './db'
import { decrypt, encrypt } from './encryption'
import { parseTenantProviderCredentials } from './payment-security'
import type { ProviderCredentials } from './providers/types'

function cleanEnvValue(raw: string | undefined): string {
  if (!raw) return ''
  return raw.trim().replace(/^["']+|["']+$/g, '').trim()
}

/**
 * Return only a complete active tenant credential set; never throws on corrupt
 * or un-decryptable rows (e.g. rotated or unconfigured APP_ENCRYPTION_KEY).
 */
export async function loadTenantProviderCredentials(
  tenantId: string,
  providerId: string
): Promise<ProviderCredentials | null> {
  try {
    const row = await db.tenantProviderConfig.findFirst({
      where: { tenantId, providerId, isActive: true },
      select: { configJson: true },
    })
    if (!row) return null

    const stored = row.configJson
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
    const encrypted = (stored as Record<string, unknown>)._encrypted
    const raw = typeof encrypted === 'string' ? JSON.parse(decrypt(encrypted)) : stored
    return parseTenantProviderCredentials(raw)
  } catch (err) {
    console.warn(
      `[tenant-credentials] Could not load/decrypt tenant credentials for tenant=${tenantId} provider=${providerId}:`,
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
 *   1. Prefer explicit per-tenant credentials from `tenant_provider_configs`.
 *   2. Fall back to platform LivePay env vars (auto-provisioning encrypted row
 *      best-effort when complete, without failing the payment if APP_ENCRYPTION_KEY
 *      is missing or LIVEPAY_WEBHOOK_SECRET is shorter than 16 chars).
 *   3. Return `null` only when neither tenant config nor platform LivePay keys exist.
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

  const platformApiKey = cleanEnvValue(process.env.LIVEPAY_API_KEY)
  const platformAccountNo = cleanEnvValue(process.env.LIVEPAY_ACCOUNT_NO || process.env.LIVEPAY_ACCOUNT_NUMBER)
  const platformWebhookSecret = cleanEnvValue(
    process.env.LIVEPAY_WEBHOOK_SECRET || process.env.LIVEPAY_SECRET_KEY
  )
  const platformBaseUrl = cleanEnvValue(process.env.LIVEPAY_BASE_URL) || 'https://livepay.me'

  if (!platformApiKey || !platformAccountNo) {
    return null
  }

  if (platformWebhookSecret.length >= 16) {
    const rawCreds: ProviderCredentials = {
      apiKey: platformApiKey,
      accountNo: platformAccountNo,
      webhookSecret: platformWebhookSecret,
      baseUrl: platformBaseUrl,
    }
    try {
      const encrypted = encrypt(JSON.stringify(rawCreds))
      await db.tenantProviderConfig.upsert({
        where: { tenantId_providerId: { tenantId, providerId } },
        create: {
          tenantId,
          providerId,
          credentialsRef: `LIVEPAY_AUTO_${tenantCode || tenantId}`,
          configJson: { _encrypted: encrypted } as any,
          isActive: true,
        },
        update: {
          configJson: { _encrypted: encrypted } as any,
          isActive: true,
        },
      })
      console.warn(
        `[tenant-credentials] Auto-provisioned LivePay credentials for tenant "${tenantCode || tenantId}" from platform env.`
      )
    } catch (autoErr) {
      // Never block real deposits if APP_ENCRYPTION_KEY is missing/rotated or DB write fails:
      // return the complete credential set in memory so initiation/polling/webhook verification proceed.
      console.warn(
        `[tenant-credentials] Using in-memory platform LivePay credentials for tenant "${tenantCode || tenantId}" (persist skipped):`,
        autoErr instanceof Error ? autoErr.message : autoErr
      )
    }
    return { source: 'platform', credentials: rawCreds }
  }

  // Platform API key + account number are present (same configuration that makes
  // /api/debug/livepay-ping fire PIN prompts), even though webhookSecret is unset/<16 chars.
  // Passing `undefined` lets LivePayProvider read platform env directly without throwing.
  console.warn(
    `[tenant-credentials] Using platform env LivePay credentials for tenant "${tenantCode || tenantId}" (LIVEPAY_WEBHOOK_SECRET not 16+ chars — status polling will reconcile payments if webhook signature cannot be verified).`
  )
  return { source: 'platform-env', credentials: undefined }
}
