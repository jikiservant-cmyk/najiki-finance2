/**
 * What the browser is allowed to know about a stored provider configuration.
 *
 * `TenantProviderConfig.configJson` holds a tenant's provider credentials —
 * their LivePay API key and webhook secret. The setup API used to return that
 * column verbatim to the dashboard, which is the same mistake the Application
 * `omit` was added to fix: a secret that reaches the browser has left the
 * server, and no amount of hashing at rest helps after that.
 *
 * Current writes store `{ _encrypted: "..." }`, so what was being shipped was a
 * ciphertext rather than a key. But four read paths (`payments.ts`,
 * `webhooks/[provider]`, `cron/sync-payments`, `qstash/cron`) carry an
 * `if (customCredentials?._encrypted)` branch specifically so that **legacy
 * plaintext rows** keep working — meaning deployments upgraded from the older
 * format still have rows whose `configJson` is `{ apiKey, webhookSecret, ... }`
 * in the clear. Those rows were being handed to the browser.
 *
 * So this module answers the only question the dashboard actually needs — "is
 * this configured, and with which non-secret values?" — and returns nothing that
 * could be a credential.
 *
 * Zero imports so the type-stripped test runner can reach it.
 */

/** Fields that hold a credential and must never be echoed to a caller. */
export const SECRET_CONFIG_FIELDS = ['apiKey', 'api_key', 'webhookSecret', 'webhook_secret', 'secret'] as const

/** Fields that are safe to display and round-trip through the edit form. */
const DISPLAYABLE_FIELDS = ['accountNo', 'account_number', 'accountNumber', 'baseUrl', 'base_url'] as const

export interface ProviderConfigSummary {
  /** A provider API key is configured. The value itself is never included. */
  hasApiKey: boolean
  /** A per-tenant webhook signing secret is configured. */
  hasWebhookSecret: boolean
  /** Non-secret: the merchant account identifier, for display and editing. */
  accountNo: string
  /** Non-secret: the provider endpoint this tenant transacts against. */
  baseUrl: string
  /** True when the stored blob is the encrypted form rather than legacy plaintext. */
  encrypted: boolean
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Reduce a stored `configJson` to a caller-safe summary.
 *
 * Anything not explicitly listed above is dropped, so a field added to the
 * credential blob later cannot leak by default — the failure mode of a
 * deny-by-default summary is a missing label, which is visible and harmless.
 */
export function summarizeProviderConfig(configJson: unknown): ProviderConfigSummary {
  const source =
    configJson && typeof configJson === 'object' ? (configJson as Record<string, unknown>) : {}

  // The encrypted form has its own shape and no readable fields at all.
  const encrypted = typeof source._encrypted === 'string' && source._encrypted.length > 0

  const hasApiKey = SECRET_CONFIG_FIELDS.some(
    (field) => str(source[field]).trim().length > 0
  ) || encrypted
  const hasWebhookSecret = ['webhookSecret', 'webhook_secret'].some(
    (field) => str(source[field]).trim().length > 0
  )

  return {
    hasApiKey,
    hasWebhookSecret,
    accountNo:
      DISPLAYABLE_FIELDS.filter((f) => f.startsWith('account'))
        .map((f) => str(source[f]))
        .find((value) => value.length > 0) ?? '',
    baseUrl:
      DISPLAYABLE_FIELDS.filter((f) => f.startsWith('base'))
        .map((f) => str(source[f]))
        .find((value) => value.length > 0) ?? '',
    encrypted,
  }
}

/**
 * True when a submitted edit would blank a stored credential.
 *
 * The edit form cannot prefill a secret it is never given, so an operator
 * editing (say) a base URL would otherwise save an empty string over a working
 * API key. Callers use this to keep the stored value instead of overwriting it.
 */
export function shouldPreserveStoredSecret(submitted: string | null | undefined): boolean {
  return str(submitted).trim().length === 0
}
