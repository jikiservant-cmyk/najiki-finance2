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
import { Loader2, AlertCircle, Info } from 'lucide-react'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isConfigured, setIsConfigured] = useState(true)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    setIsConfigured(isBrowserSupabaseConfigured())
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
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
          <CardDescription>
            Sign in to access the payment and messaging gateway
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isConfigured && (
            <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-200">
              <Info className="h-4 w-4 text-amber-400" />
              <AlertTitle className="text-amber-300 font-semibold text-xs tracking-wider uppercase">
                Supabase Auth Not Configured
              </AlertTitle>
              <AlertDescription className="text-xs text-amber-200/90 mt-1">
                <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> are missing or set to placeholder values.
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle className="text-xs font-semibold uppercase tracking-wider">
                Authentication Error
              </AlertTitle>
              <AlertDescription className="text-xs mt-1 leading-relaxed whitespace-pre-wrap">
                {error}
              </AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
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
