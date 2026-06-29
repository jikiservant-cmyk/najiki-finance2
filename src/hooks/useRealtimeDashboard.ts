// FIX: Supabase Realtime table names must match the actual Postgres table names
// The schema uses @@map("payment_intents") etc. which sets the real PG table name.
// Supabase Realtime listens on the actual PG table name — not the Prisma model name.
//
// BEFORE (broken): table: 'PaymentIntent'   ← Prisma model name, doesn't exist in PG
// AFTER  (fixed):  table: 'payment_intents' ← actual PG table name from @@map()
//
// These subscriptions were silently never firing because the table names were wrong.

import { useEffect, useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase-client'

export type RealtimeEvent = {
  type: 'payment' | 'webhook' | 'notification'
  payload: Record<string, unknown>
  timestamp: Date
}

export function useRealtimeDashboard(onRefresh: () => void) {
  const [events, setEvents] = useState<RealtimeEvent[]>([])
  const [connected, setConnected] = useState(false)
  const supabase = useMemo(() => createClient(), [])

  const pushEvent = useCallback(
    (event: RealtimeEvent) => {
      setEvents((prev) => [event, ...prev].slice(0, 50))
      onRefresh()
    },
    [onRefresh]
  )

  useEffect(() => {
    if (!supabase) return

    const channel = supabase
      .channel('admin-dashboard')

      // FIX: 'payment_intents' not 'PaymentIntent'
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'payment_intents' },
        (payload) => {
          pushEvent({
            type: 'payment',
            payload: payload.new as Record<string, unknown>,
            timestamp: new Date(),
          })
        }
      )

      // FIX: 'webhook_logs' not 'WebhookLog'
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'webhook_logs' },
        (payload) => {
          pushEvent({
            type: 'webhook',
            payload: payload.new as Record<string, unknown>,
            timestamp: new Date(),
          })
        }
      )

      // FIX: 'internal_notifications' not 'InternalNotification'
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'internal_notifications' },
        (payload) => {
          pushEvent({
            type: 'notification',
            payload: payload.new as Record<string, unknown>,
            timestamp: new Date(),
          })
        }
      )

      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED')
      })

    return () => {
      if (supabase) supabase.removeChannel(channel)
    }
  }, [pushEvent])

  return { events, connected }
}
