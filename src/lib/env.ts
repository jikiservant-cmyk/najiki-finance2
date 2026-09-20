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
  'SUPER_ADMIN_EMAILS',
  'AFRICASTALKING_CALLBACK_SECRET',
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
}
