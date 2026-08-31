import { createBrowserClient } from '@supabase/ssr'
import { SupabaseClient } from '@supabase/supabase-js'

let supabase: SupabaseClient | undefined

export function createClient() {
  if (supabase) return supabase

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'

  supabase = createBrowserClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        // Customize how cookies are set to handle iframe environment
        get(name: string) {
          if (typeof document === 'undefined') return undefined
          const value = `; ${document.cookie}`
          const parts = value.split(`; ${name}=`)
          if (parts.length === 2) return parts.pop()?.split(';').shift()
          return undefined
        },
        set(name: string, value: string, options: any) {
          if (typeof document === 'undefined') return
          let cookieStr = `${name}=${value}; path=/; SameSite=None; Secure`
          if (options?.maxAge) {
            cookieStr += `; max-age=${options.maxAge}`
          }
          if (options?.domain) {
            cookieStr += `; domain=${options.domain}`
          }
          document.cookie = cookieStr
        },
        remove(name: string, options: any) {
          if (typeof document === 'undefined') return
          document.cookie = `${name}=; path=/; max-age=0; SameSite=None; Secure`
        }
      }
    }
  )

  return supabase
}
