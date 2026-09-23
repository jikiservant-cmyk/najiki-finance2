'use client'

import { useState, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient, isBrowserSupabaseConfigured } from '@/lib/supabase-client'
import { getFriendlyAuthErrorMessage } from '@/lib/supabase-config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, AlertCircle, Info, Database, CheckCircle2, ArrowRight, RefreshCw } from 'lucide-react'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isConfigured, setIsConfigured] = useState(true)
  const [isCheckingHealth, setIsCheckingHealth] = useState(false)
  const [healthStatus, setHealthStatus] = useState<{
    database?: { ok: boolean; detail?: string }
    cache?: { ok: boolean; detail?: string }
  } | null>(null)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    setIsConfigured(isBrowserSupabaseConfigured())
  }, [])

  const checkConnection = async () => {
    setIsCheckingHealth(true)
    try {
      const res = await fetch('/api/health')
      const data = await res.json()
      setHealthStatus(data.checks || {})
    } catch {
      setHealthStatus({
        database: { ok: false, detail: 'Failed to reach health endpoint' },
      })
    } finally {
      setIsCheckingHealth(false)
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    if (!isBrowserSupabaseConfigured()) {
      setError(
        'Supabase Auth is not configured. Please configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your .env file.'
      )
      setLoading(false)
      return
    }

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (signInError) {
        throw new Error(signInError.message)
      }

      router.refresh()
      router.push('/')
    } catch (err) {
      const friendlyMessage = getFriendlyAuthErrorMessage(
        err,
        process.env.NEXT_PUBLIC_SUPABASE_URL
      )
      setError(friendlyMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleDevBypass = () => {
    router.push('/')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-md shadow-lg border-border/60">
        <CardHeader className="text-center">
          <div className="flex items-center justify-center mb-4">
            <svg
              viewBox="0 0 40 40"
              className="h-10 w-10 text-primary"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect width="40" height="40" rx="8" fill="currentColor" fillOpacity="0.1" />
              <path
                d="M12 20C12 15.5817 15.5817 12 20 12C24.4183 12 28 15.5817 28 20C28 24.4183 24.4183 28 20 28C15.5817 28 12 24.4183 12 20Z"
                fill="currentColor"
                fillOpacity="0.2"
              />
              <path
                d="M18 20L20 22L24 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <CardTitle className="text-2xl font-bold">Na&apos;jiki Finance</CardTitle>
          <CardDescription>Sign in to access the payment and messaging gateway</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isConfigured && (
            <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-200">
              <Info className="h-4 w-4 text-amber-400" />
              <AlertTitle className="text-amber-300 font-semibold text-xs tracking-wider uppercase">
                Supabase Auth Not Configured
              </AlertTitle>
              <AlertDescription className="text-xs text-amber-200/90 mt-1 space-y-2">
                <p>
                  <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> are missing or set to placeholder values.
                </p>
                {process.env.NODE_ENV !== 'production' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDevBypass}
                    className="w-full mt-2 border-amber-400/40 text-amber-300 hover:bg-amber-400/20 text-xs font-mono"
                  >
                    Enter Dashboard (Dev Mode Bypass)
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle className="text-xs font-semibold uppercase tracking-wider">
                Connection / Login Error
              </AlertTitle>
              <AlertDescription className="text-xs mt-1 leading-relaxed whitespace-pre-wrap">
                {error}
              </AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="admin@example.com"
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                disabled={loading}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </Button>
          </form>

          {/* Connection status diagnostics */}
          <div className="pt-2 border-t border-border/40">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
              <span className="font-mono text-[11px] uppercase tracking-wider flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5" />
                Connection Diagnostics
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={checkConnection}
                disabled={isCheckingHealth}
                className="h-6 px-2 text-[10px] font-mono gap-1 text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={`w-3 h-3 ${isCheckingHealth ? 'animate-spin' : ''}`} />
                Check DB
              </Button>
            </div>

            {healthStatus && (
              <div className="rounded-md bg-muted/50 p-2.5 text-xs font-mono space-y-1.5 border border-border/50">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Prisma Database:</span>
                  {healthStatus.database?.ok ? (
                    <span className="text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Connected
                    </span>
                  ) : (
                    <span className="text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {healthStatus.database?.detail || 'Disconnected'}
                    </span>
                  )}
                </div>

                {!healthStatus.database?.ok && (
                  <p className="text-[10px] text-muted-foreground/90 font-sans pt-1 border-t border-border/40">
                    💡 If connecting Prisma to Supabase pooler on port 6543, ensure <code>?pgbouncer=true</code> is appended to <code>DATABASE_URL</code> in <code>.env</code>.
                  </p>
                )}
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter className="justify-center border-t border-border/30 pt-3">
          <p className="text-[11px] text-muted-foreground font-mono text-center">
            Na&apos;jiki Finance v0.2.0 • Unified Gateway
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}
