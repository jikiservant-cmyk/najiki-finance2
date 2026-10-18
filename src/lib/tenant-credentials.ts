import { db } from './db'
import { decrypt } from './encryption'
import { parseTenantProviderCredentials } from './payment-security'

/** Return only a complete active tenant credential set; never platform defaults. */
export async function loadTenantProviderCredentials(tenantId: string, providerId: string) {
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
}
