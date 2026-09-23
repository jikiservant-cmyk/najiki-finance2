'use client'

/**
 * Live dashboard updates over authenticated HTTP polling.
 *
 * Replaces the previous Supabase Realtime subscription (`useRealtimeDashboard`).
 * That subscription read `payment_intents`, `webhook_logs` and
 * `internal_notifications` directly from the browser with the public anon key,
 * which is only safe if RLS is enabled — and the only policies in the repo were
 * `auth.role() = 'service_role'`, which the browser never matches. It was
 * therefore either a public data feed (RLS off) or permanently silent (RLS on).
 *
 * Polling `/api/dashboard` keeps every read behind the session-gated admin API:
 * no anon-key data access, no Realtime publication to configure.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Poll interval when the tab is visible, and when it is hidden. */
const VISIBLE_INTERVAL_MS = 20_000
const HIDDEN_INTERVAL_MS = 120_000

export type LiveEvent = {
  type: 'payment' | 'webhook' | 'notification' | 'refresh'
  payload: Record<string, unknown>
  timestamp: Date
}

export type PaymentSnapshot = {
  id: string
  reference?: string
  status?: string
  amount?: number
  currency?: string
}

/**
 * @param refresh     called whenever fresh data should be pulled
 * @param snapshotKey a stable value derived from the fetched payment intents
 *                    (e.g. `id:status` joined). When it changes we emit an
 *                    event so the activity feed reflects new payments.
 */
export function useLiveDashboard(refresh: () => void | Promise<void>, snapshotKey?: string) {
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const previousKey = useRef<string | undefined>(undefined)
  const previousTime = useRef<number>(0)
  const failures = useRef(0)

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const runRefresh = useCallback(async () => {
    try {
      await refreshRef.current()
      failures.current = 0
      setConnected(true)
      setLastRefresh(new Date())
    } catch {
      failures.current += 1
      // Tolerate one hiccup before declaring the console degraded.
      if (failures.current > 1) setConnected(false)
    }
  }, [])

  // Emit an event whenever the snapshot of recent payments actually changes.
  useEffect(() => {
    if (snapshotKey === undefined) return
    if (previousKey.current === undefined) {
      previousKey.current = snapshotKey
      return
    }
    if (previousKey.current === snapshotKey) return

    previousKey.current = snapshotKey
    const entries = snapshotKey.split('|').filter(Boolean)

    // Rate-limit the feed so a bulk sync cannot flood the UI.
    const now = Date.now()
    if (now - previousTime.current < 1000) return
    previousTime.current = now

    setEvents((prev) =>
      [
        {
          type: 'payment' as const,
          payload: { summary: `${entries.length} recent payment(s)`, snapshot: entries.slice(0, 5) },
          timestamp: new Date(),
        },
        ...prev,
      ].slice(0, 50)
    )
  }, [snapshotKey])

  // Poll while the tab is visible; back off when it is hidden.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      const interval =
        typeof document !== 'undefined' && document.visibilityState === 'hidden'
          ? HIDDEN_INTERVAL_MS
          : VISIBLE_INTERVAL_MS
      timer = setTimeout(async () => {
        if (cancelled) return
        await runRefresh()
        if (!cancelled) schedule()
      }, interval)
    }

    // `.finally()` does not handle a rejection — it forwards it, so a throwing
    // runRefresh produced an unhandled promise rejection. runRefresh swallows
    // its own fetch errors today, but relying on that is what makes this class
    // of bug reappear when the function is edited.
    runRefresh()
      .catch((error) => {
        console.error('[useLiveDashboard] initial refresh failed:', error)
      })
      .finally(() => {
        if (!cancelled) schedule()
      })

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !cancelled) {
        runRefresh()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }, [runRefresh])

  return { events, connected, lastRefresh }
}
