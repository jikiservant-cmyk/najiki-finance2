import { createBrowserClient } from '@supabase/ssr'
import { SupabaseClient } from '@supabase/supabase-js'
import { isSupabaseConfigured } from './supabase-config'

let supabase: SupabaseClient | undefined

export { isSupabaseConfigured as isBrowserSupabaseConfigured }

export function createClient() {
  if (supabase) return supabase

  const configured = isSupabaseConfigured(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )

  const supabaseUrl = configured
    ? process.env.NEXT_PUBLIC_SUPABASE_URL!
    : 'https://placeholder.supabase.co'
  const supabaseKey = configured
    ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    : 'placeholder'

  supabase = createBrowserClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        get(name: string) {
          if (typeof document === 'undefined') return undefined
          const value = `; ${document.cookie}`
          const parts = value.split(`; ${name}=`)
          if (parts.length === 2) return parts.pop()?.split(';').shift()
          return undefined
        },
        set(name: string, value: string, options: any) {
          if (typeof document === 'undefined') return
          // Browsers reject `SameSite=None; Secure` on non-HTTPS origins (e.g. http://localhost:3000).
          // Use `SameSite=None; Secure` in HTTPS (including cross-origin iframes), and `SameSite=Lax` on plain HTTP.
          const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
          const sameSite = isHttps ? 'None' : 'Lax'
          const cookiePath = options?.path || '/'

          let cookieStr = `${name}=${value}; path=${cookiePath}; SameSite=${sameSite}`
          if (isHttps) {
            cookieStr += '; Secure'
          }
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
          const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
          const sameSite = isHttps ? 'None' : 'Lax'
          const cookiePath = options?.path || '/'

          let cookieStr = `${name}=; path=${cookiePath}; max-age=0; SameSite=${sameSite}`
          if (isHttps) {
            cookieStr += '; Secure'
          }
          if (options?.domain) {
            cookieStr += `; domain=${options.domain}`
          }
          document.cookie = cookieStr
        }
      }
    }
  )

  return supabase
}
