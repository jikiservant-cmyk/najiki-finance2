import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import type { User } from '@supabase/supabase-js'

/**
 * Create a request-scoped Supabase server client from the auth cookies.
 *
 * Throws a clear configuration error instead of an opaque "supabaseUrl is
 * required" crash when the app is deployed without auth env vars.
 */
async function getSupabaseServerClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    console.error('[AUTH] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not configured')
    throw new Error('Unauthorized')
  }

  const cookieStore = await cookies()

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value
      },
    },
  })
}

/**
 * Require any authenticated Supabase user.
 * Throws `Error('Unauthorized')` when there is no valid session.
 */
export async function requireAuth(): Promise<User> {
  const supabase = await getSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new Error('Unauthorized')
  }

  return user
}

/**
 * Require an authenticated user whose `AdminProfile.role` is `super_admin`.
 *
 * Throws `Error('Unauthorized')` (no session) or
 * `Error('Forbidden: Super Admin required')` (session without the role).
 */
export async function requireSuperAdmin(): Promise<User> {
  const supabase = await getSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new Error('Unauthorized')
  }

  let adminProfile = await db.adminProfile.findUnique({
    where: { id: user.id },
  })

  // Bootstrap super admins from SUPER_ADMIN_EMAILS.
  //
  // SECURITY: this used to fall back to a hard-coded list of personal Gmail
  // addresses when the env var was unset. That made those accounts permanent
  // super admins in any deployment that forgot to set SUPER_ADMIN_EMAILS.
  // There is now NO default — an unset/empty variable grants nobody access.
  const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  if (user.email && superAdminEmails.includes(user.email.toLowerCase())) {
    if (!adminProfile) {
      adminProfile = await db.adminProfile.create({
        data: { id: user.id, role: 'super_admin' },
      })
    } else if (adminProfile.role !== 'super_admin') {
      adminProfile = await db.adminProfile.update({
        where: { id: user.id },
        data: { role: 'super_admin' },
      })
    }
  }

  if (!adminProfile || adminProfile.role !== 'super_admin') {
    console.error('[AUTH ERROR] User ID:', user.id, 'Email:', user.email, 'Profile:', adminProfile)
    throw new Error('Forbidden: Super Admin required')
  }

  return user
}
