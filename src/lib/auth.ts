import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'

export async function requireAuth() {
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    throw new Error('Unauthorized')
  }

  return user
}

export async function requireSuperAdmin() {
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    throw new Error('Unauthorized')
  }

  let adminProfile = await db.adminProfile.findUnique({
    where: { id: user.id }
  })

  // Auto-elevate the known admin emails to super_admin
  const superAdminEmails = (process.env.SUPER_ADMIN_EMAILS || 'smartskoolz@gmail.com,jikiservant@gmail.com')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  if (user.email && superAdminEmails.includes(user.email)) {
    if (!adminProfile) {
      adminProfile = await db.adminProfile.create({
        data: { id: user.id, role: 'super_admin' }
      })
    } else if (adminProfile.role !== 'super_admin') {
      adminProfile = await db.adminProfile.update({
        where: { id: user.id },
        data: { role: 'super_admin' }
      })
    }
  }

  if (!adminProfile || adminProfile.role !== 'super_admin') {
    console.error('[AUTH ERROR] User ID:', user.id, 'Email:', user.email, 'Profile:', adminProfile)
    throw new Error('Forbidden: Super Admin required')
  }

  return user
}
