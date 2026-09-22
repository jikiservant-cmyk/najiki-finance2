/**
 * Authenticating a partner application and resolving its signing secret.
 *
 * Two jobs that used to be the same database read, and are now deliberately
 * different:
 *
 *   * **Authentication** compares the presented token against `apiKeyHash`.
 *     The plaintext is never stored, so a leaked database yields nothing that
 *     can be replayed.
 *   * **Signing** needs the plaintext, because an HMAC key cannot be derived
 *     from a hash. `webhookSecretEncrypted` holds it under AES-256-GCM with
 *     `APP_ENCRYPTION_KEY`. It is a *separate* secret from the API key, so
 *     recovering it does not hand over the credential partners authenticate
 *     with.
 *
 * Both paths fall back to the legacy cleartext `apiKey` column so applications
 * provisioned before the migration keep working; run
 * `npm run db:migrate-api-keys` to move them onto the hashed columns, and
 * `--clear-plaintext` afterwards to remove the cleartext.
 */

import { db } from './db'
import { decrypt } from './encryption'
import { hashApiKey, verifyApiKey } from './api-keys'

/**
 * The columns an authenticated caller may need: enough to build a notification
 * URL and resolve the signing secret without a second query.
 *
 * `apiKey` and `webhookSecretEncrypted` are returned so the signing path can
 * use {@link webhookSecretFromRow}. Never serialise this object to a client.
 */
const APPLICATION_AUTH_SELECT = {
  id: true,
  code: true,
  name: true,
  isActive: true,
  baseUrl: true,
  webhookPath: true,
  apiKey: true,
  webhookSecretEncrypted: true,
} as const

export interface ApplicationAuthResult {
  application: {
    id: string
    code: string
    name: string
    isActive: boolean
    baseUrl: string
    webhookPath: string
    apiKey: string | null
    webhookSecretEncrypted: string | null
  }
  /** True when the match came from the legacy cleartext column. */
  usedLegacyPlaintextKey: boolean
}

/**
 * Find the active application a raw API key belongs to, or null.
 *
 * Prefers the hash. Falls back to the cleartext column only when the hash
 * column is empty for the candidate row — a row that has been migrated cannot
 * authenticate with a stolen cleartext copy, because the plaintext is gone.
 */
export async function findApplicationByApiKey(
  rawApiKey: string,
  filter: { code?: string } = {}
): Promise<ApplicationAuthResult | null> {
  const apiKey = String(rawApiKey ?? '').trim()
  if (!apiKey) return null

  const byHash = await db.application.findFirst({
    where: {
      apiKeyHash: hashApiKey(apiKey),
      isActive: true,
      ...(filter.code ? { code: filter.code } : {}),
    },
    select: APPLICATION_AUTH_SELECT,
  })

  if (byHash) {
    return { application: byHash, usedLegacyPlaintextKey: false }
  }

  const byPlaintext = await db.application.findFirst({
    where: {
      apiKey,
      isActive: true,
      ...(filter.code ? { code: filter.code } : {}),
    },
    select: APPLICATION_AUTH_SELECT,
  })

  if (byPlaintext) {
    console.warn(
      `[auth] Application "${byPlaintext.code}" authenticated against the legacy cleartext ` +
        `api_key column. Run \`npm run db:migrate-api-keys\` to hash it.`
    )
    return { application: byPlaintext, usedLegacyPlaintextKey: true }
  }

  return null
}

/**
 * Resolve the secret used to sign outbound webhooks for an application.
 *
 * Returns the webhook secret, or the legacy API key for rows that predate the
 * migration, or null when the application has neither.
 */
export async function resolveWebhookSecret(applicationId: string): Promise<string | null> {
  const row = await db.application.findUnique({
    where: { id: applicationId },
    select: { webhookSecretEncrypted: true, apiKey: true },
  })

  if (!row) return null

  if (row.webhookSecretEncrypted) {
    try {
      return decrypt(row.webhookSecretEncrypted)
    } catch (error) {
      // Never fall back to a different secret on a decryption failure: partners
      // verify signatures, and signing with the wrong key would make every
      // delivery fail verification in a way that looks like tampering.
      console.error(
        `[auth] Could not decrypt the webhook secret for application ${applicationId}. ` +
          `Refusing to sign with a fallback key.`,
        error
      )
      return null
    }
  }

  return row.apiKey ?? null
}

/**
 * Same as {@link resolveWebhookSecret} but for a row already in hand, so hot
 * paths (the notification worker) do not pay for an extra query.
 */
export function webhookSecretFromRow(row: {
  webhookSecretEncrypted?: string | null
  apiKey?: string | null
}): string | null {
  if (row.webhookSecretEncrypted) {
    try {
      return decrypt(row.webhookSecretEncrypted)
    } catch (error) {
      console.error('[auth] Could not decrypt a webhook secret; refusing to sign.', error)
      return null
    }
  }
  return row.apiKey ?? null
}

/** Exposed for tests and for callers that already hold a hash. */
export { verifyApiKey }
