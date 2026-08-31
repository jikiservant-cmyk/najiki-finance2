import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  })

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey || !supabaseUrl.startsWith('http')) {
    // If Supabase is not configured yet, allow the request to proceed
    return response
  }

  try {
    const supabase = createServerClient(
      supabaseUrl,
      supabaseKey,
      {
        cookies: {
          get(name: string) {
            return request.cookies.get(name)?.value
          },
          set(name: string, value: string, options: CookieOptions) {
            const cookieOptions = {
              ...options,
              sameSite: 'none' as const,
              secure: true,
            }
            request.cookies.set({
              name,
              value,
              ...cookieOptions,
            })
            response = NextResponse.next({
              request: {
                headers: request.headers,
              },
            })
            response.cookies.set({
              name,
              value,
              ...cookieOptions,
            })
          },
          remove(name: string, options: CookieOptions) {
            const cookieOptions = {
              ...options,
              sameSite: 'none' as const,
              secure: true,
            }
            request.cookies.set({
              name,
              value: '',
              ...cookieOptions,
            })
            response = NextResponse.next({
              request: {
                headers: request.headers,
              },
            })
            response.cookies.set({
              name,
              value: '',
              ...cookieOptions,
            })
          },
        },
      }
    )

    const {
      data: { user },
    } = await supabase.auth.getUser()

    const publicRoutes = ['/login', '/offline']
    if (publicRoutes.includes(request.nextUrl.pathname)) {
      if (user && request.nextUrl.pathname === '/login') {
        return NextResponse.redirect(new URL('/', request.url))
      }
      return response
    }

    if (!user) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    return response
  } catch (err) {
    console.error('Middleware auth check error:', err)
    return response
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|manifest.webmanifest|sw.js|icons|logo.svg|robots.txt|api/webhooks|api/cron|api/qstash|api/payments|api/messaging/send).*)',
  ],
}

