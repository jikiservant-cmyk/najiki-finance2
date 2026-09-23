/**
 * Pure configuration helpers for Supabase Auth and Database (Prisma) connectivity.
 * Zero-dependency module safe for client, server, and edge runtimes.
 */

/**
 * Check whether Supabase environment variables are provided and not placeholders.
 */
export function isSupabaseConfigured(
  url: string | undefined | null = process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: string | undefined | null = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
): boolean {
  if (!url || !key) return false
  const trimmedUrl = String(url).trim()
  const trimmedKey = String(key).trim()

  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) return false
  if (trimmedUrl.includes('placeholder') || trimmedUrl.includes('your-project')) return false
  if (trimmedKey.includes('placeholder') || trimmedKey.includes('your-anon-key')) return false

  return true
}

/**
 * Inspect a PostgreSQL connection string for Supabase pooler compatibility.
 * When connecting via port 6543 (transaction mode pooler), Prisma requires
 * `?pgbouncer=true` to disable prepared statements.
 */
export function inspectDatabaseUrl(url: string | undefined | null): {
  configured: boolean
  isSupabasePooler: boolean
  hasPgbouncer: boolean
  warning: string | null
} {
  if (!url || !url.trim()) {
    return {
      configured: false,
      isSupabasePooler: false,
      hasPgbouncer: false,
      warning: 'DATABASE_URL is not set.',
    }
  }

  const trimmed = url.trim()
  const isSupabase = trimmed.includes('supabase.com') || trimmed.includes('supabase.co')
  const isPort6543 = trimmed.includes(':6543')
  const isPooler = isPort6543 || (isSupabase && trimmed.includes('.pooler.'))
  const hasPgbouncer = /[?&]pgbouncer=true(&|$)/i.test(trimmed)

  let warning: string | null = null
  if (isPort6543 && !hasPgbouncer) {
    warning =
      'Supabase transaction pooler (port 6543) detected without ?pgbouncer=true. ' +
      'Prisma prepared statements will fail on PgBouncer. Append ?pgbouncer=true to DATABASE_URL.'
  }

  return {
    configured: true,
    isSupabasePooler: isPooler,
    hasPgbouncer,
    warning,
  }
}

/**
 * Translate opaque network / fetch exceptions into clear, actionable messages.
 */
export function getFriendlyAuthErrorMessage(
  err: unknown,
  configuredUrl: string | undefined | null = process.env.NEXT_PUBLIC_SUPABASE_URL
): string {
  const message = err instanceof Error ? err.message : String(err || 'Unknown error')
  const lower = message.toLowerCase()

  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('fetch failed')) {
    const target = configuredUrl ? `at "${configuredUrl}"` : ''
    return (
      `Failed to connect to Supabase Auth ${target}. ` +
      `Please check that: (1) your Supabase project is active and not paused, ` +
      `(2) NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are valid, and ` +
      `(3) your network connection allows reaching Supabase.`
    ).trim()
  }

  if (lower.includes('invalid login credentials') || lower.includes('invalid_credentials')) {
    return 'Invalid email or password. Please verify your credentials.'
  }

  if (lower.includes('email not confirmed')) {
    return 'Email not confirmed. Please check your inbox or disable email confirmation in your Supabase Auth settings.'
  }

  return message
}
