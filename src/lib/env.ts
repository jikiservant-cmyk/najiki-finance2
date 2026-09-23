/**
 * Runtime Environment Assertion
 * Runs once during runtime server execution, validating that all security-critical
 * and payment-guarding environment variables are properly configured.
 */

const REQUIRED_IN_PROD = [
  'DATABASE_URL',
  'APP_ENCRYPTION_KEY',
  'LIVEPAY_API_KEY',
  'LIVEPAY_ACCOUNT_NO',
  'LIVEPAY_WEBHOOK_SECRET',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  // Without this nobody can access the admin dashboard, and (previously) the
  // code silently fell back to hard-coded personal email addresses.
  'SUPER_ADMIN_EMAILS',
  // The delivery-report endpoint fails closed in production without this, so a
  // deployment that omits it silently stops receiving SMS delivery reports.
  'AFRICASTALKING_CALLBACK_SECRET',
  // Public base URL — used to build the webhook URL handed to LivePay and part
  // of the signature string, so a wrong value breaks webhook verification.
  'NEXTAUTH_URL',
]

let _hasAsserted = false

export function assertRuntimeEnv(): void {
  if (_hasAsserted) return
  _hasAsserted = true

  if (process.env.NODE_ENV !== 'production' || process.env.NEXT_PHASE === 'phase-production-build') {
    return
  }

  const missing = REQUIRED_IN_PROD.filter(
    (k) => !process.env[k] || process.env[k]?.trim() === ''
  )

  if (missing.length > 0) {
    console.error('[FATAL] Missing required production environment variables:', missing)
    throw new Error(`FATAL: Missing required production environment variables: ${missing.join(', ')}`)
  }

  const webhookSecret = process.env.LIVEPAY_WEBHOOK_SECRET || ''
  if (webhookSecret.length < 16) {
    console.error('[FATAL] LIVEPAY_WEBHOOK_SECRET is too short or insecure in production')
    throw new Error('FATAL: LIVEPAY_WEBHOOK_SECRET must be at least 16 characters in production')
  }

  // Encryption key must be a 64-char hex string (32 bytes) — matches the
  // validation in src/lib/encryption.ts so we fail at boot, not at first write.
  const encryptionKey = process.env.APP_ENCRYPTION_KEY || ''
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    console.error('[FATAL] APP_ENCRYPTION_KEY must be a 64-character hex string in production')
    throw new Error('FATAL: APP_ENCRYPTION_KEY must be a 64-character hex string in production')
  }

  // Cron/QStash endpoints are also protected by CRON_SECRET; without it the
  // QStash signature is the only gate, so require the secret explicitly.
  if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 16) {
    console.error('[FATAL] CRON_SECRET must be set and at least 16 characters in production')
    throw new Error('FATAL: CRON_SECRET must be set and at least 16 characters in production')
  }

  console.log('[ENV] Production environment validation passed')
}
