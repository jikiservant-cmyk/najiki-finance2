import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Routes that are reachable without a dashboard session.
 * Everything else requires an authenticated Supabase user.
 */
const PUBLIC_ROUTES = ['/login', '/offline']

/**
 * Build a NextResponse that carries the (possibly refreshed) request headers.
 */
function nextWithHeaders(request: NextRequest) {
  return NextResponse.next({
    request: { headers: request.headers },
  })
}

/**
 * FAIL-CLOSED helper.
 *
 * Previously the catch block returned the *unauthenticated* pass-through
 * response, which meant any error thrown during the auth check (Supabase
 * outage, TLS error, malformed cookie, network timeout) turned into a full
 * authentication bypass for both pages and API routes.
 *
 * We now deny by default and only ever allow a request through once we have
 * positively confirmed there is no session AND the route is public.
 */
function denyRequest(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 503 })
  }
  // Redirect page requests to the login screen rather than leaking a 500 page.
  const loginUrl = new URL('/login', request.url)
  return NextResponse.redirect(loginUrl)
}

export async function middleware(request: NextRequest) {
  let response = nextWithHeaders(request)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey || !supabaseUrl.startsWith('http')) {
    // Auth is not configured. Never expose the dashboard in this state.
    if (process.env.NODE_ENV === 'production') {
      console.error('[Middleware] Supabase auth is not configured (fail-closed)')
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 })
    }
    // Development without Supabase configured: allow through so the UI can be
    // worked on locally, but make it loud.
    console.warn('[Middleware] Supabase env vars missing — auth is DISABLED (development only)')
    return response
  }

  // Cookies must only carry the Secure flag when actually served over HTTPS,
  // otherwise sessions silently fail to persist on plain-HTTP deployments.
  const isProduction = process.env.NODE_ENV === 'production'

  try {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          const cookieOptions = {
            ...options,
            sameSite: 'lax' as const,
            secure: isProduction,
          }
          request.cookies.set({ name, value, ...cookieOptions })
          response = nextWithHeaders(request)
          response.cookies.set({ name, value, ...cookieOptions })
        },
        remove(name: string, options: CookieOptions) {
          const cookieOptions = {
            ...options,
            sameSite: 'lax' as const,
            secure: isProduction,
          }
          request.cookies.set({ name, value: '', ...cookieOptions })
          response = nextWithHeaders(request)
          response.cookies.set({ name, value: '', ...cookieOptions })
        },
      },
    })

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (PUBLIC_ROUTES.includes(request.nextUrl.pathname)) {
      if (user && request.nextUrl.pathname === '/login') {
        return NextResponse.redirect(new URL('/', request.url))
      }
      return response
    }

    if (!user) {
      if (request.nextUrl.pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      return NextResponse.redirect(new URL('/login', request.url))
    }

    return response
  } catch (err) {
    // FAIL CLOSED — see denyRequest() doc comment. Do not return `response`.
    console.error('[Middleware] Auth check failed — denying request (fail-closed):', err)
    return denyRequest(request)
  }
}

export const config = {
  /**
   * Machine-to-machine endpoints listed here authenticate themselves via
   * signature verification (webhooks) or a shared secret (cron / QStash) and
   * must stay reachable without a browser session.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|manifest.webmanifest|sw.js|icons|logo.svg|robots.txt|api/webhooks|api/cron|api/qstash|api/payments|api/messaging/send).*)',
  ],
}
