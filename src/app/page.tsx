'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Navigation } from '@/components/app/navigation'
import { CursorTrail } from '@/components/app/cursor-trail'
import { FloatingGeometry } from '@/components/app/floating-geometry'
import { TiltCard } from '@/components/app/tilt-card'
import { PaymentFlow3D } from '@/components/app/payment-flow-3d'
import Link from 'next/link'
import { useRealtimeDashboard } from '@/hooks/useRealtimeDashboard'

interface DashboardData {
  totalRevenue: number
  statusCounts: { success: number; pending: number; processing: number; failed: number; expired: number; cancelled: number }
  successRate: string
  appRevenue: { code: string; name: string; revenue: number; count: number; successCount: number }[]
  providerRevenue: { code: string; name: string; revenue: number; count: number }[]
  tenantRevenue: { code: string; name: string; application: string; revenue: number; count: number }[]
  dailyRevenue: { date: string; revenue: number; count: number; failed: number }[]
  funnel: { application: string; total: number; success: number; failed: number; inFlight: number; rate: string }[]
  recentIntents: {
    id: string; reference: string; application: string; applicationCode: string
    tenantName: string | null; tenantCode: string | null; paymentType: string | null
    amount: number; currency: string; status: string; provider: string; providerCode: string
    phoneNumber: string | null; externalEntityId: string | null; failureReason: string | null
    createdAt: string; completedAt: string | null
  }[]
  totalPayments: number
  notifStats: { total: number; delivered: number; pending: number; retrying: number; exhausted: number }
}

const fmt = (n: number | undefined | null) => {
  if (typeof n !== 'number' || isNaN(n)) return 'UGX 0'
  if (n >= 1000000) return `UGX ${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `UGX ${(n / 1000).toFixed(0)}K`
  return `UGX ${n.toLocaleString()}`
}

const fmtDate = (d: string | Date | undefined | null) => {
  if (!d) return '—'
  const date = new Date(d)
  if (isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

// NEW COLOR PALETTE — vibrant teal/cyan family
const appColors: Record<string, string> = { sacco: '#4ade80', church: '#fbbf24', school: '#fb923c' }
const provColors: Record<string, string> = { livepay: '#4ade80', mtn: '#fbbf24', airtel: '#f87171', pesapal: '#a78bfa' }
const statusColors: Record<string, string> = {
  success: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20',
  pending: 'bg-amber-500/15 text-amber-400 border border-amber-500/20',
  processing: 'bg-sky-500/15 text-sky-400 border border-sky-500/20',
  failed: 'bg-red-500/15 text-red-400 border border-red-500/20',
  expired: 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/20',
  cancelled: 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/20',
}

function StatCard({ label, value, sub, accent, delay }: { label: string; value: string; sub?: string; accent?: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="stat-card p-4 md:p-5 bg-card border border-border/50 rounded-xl"
    >
      <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase">{label}</span>
      <motion.div
        initial={{ opacity: 0, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: delay + 0.2, duration: 0.4 }}
        className="text-xl md:text-2xl font-black tracking-tight mt-1"
        style={accent ? { color: accent } : {}}
      >
        {value}
      </motion.div>
      {sub && <span className="text-[10px] font-mono text-muted-foreground mt-1 block">{sub}</span>}
    </motion.div>
  )
}

function BarChart({ data, maxVal, color, failData }: { data: number[]; maxVal: number; color: string; failData?: number[] }) {
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)
  const safeData = Array.isArray(data) ? data : []
  const safeFailData = Array.isArray(failData) ? failData : []
  return (
    <div className="space-y-1">
      <div className="flex items-end gap-1.5 h-24">
        {safeData.map((v, i) => (
          <motion.div
            key={i}
            initial={{ height: 0 }}
            animate={{ height: `${Math.max(3, (v / maxVal) * 100)}%` }}
            transition={{ delay: 0.8 + i * 0.03, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="flex-1 min-w-[4px] rounded-t-md cursor-pointer transition-all"
            style={{ backgroundColor: v > 0 ? color : 'oklch(0.23 0.04 260)' }}
            onMouseEnter={() => setHoveredBar(i)}
            onMouseLeave={() => setHoveredBar(null)}
          >
            {hoveredBar === i && v > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className="relative -top-8 left-1/2 -translate-x-1/2 bg-card border border-border px-2 py-1 rounded text-[9px] font-mono text-foreground whitespace-nowrap"
              >
                {fmt(v)}
              </motion.div>
            )}
          </motion.div>
        ))}
      </div>
      {safeFailData && safeFailData.length > 0 && (
        <div className="flex items-end gap-1.5 h-8">
          {safeFailData.map((v, i) => (
            <motion.div
              key={i}
              initial={{ height: 0 }}
              animate={{ height: `${Math.max(v > 0 ? 15 : 0, (v / maxVal) * 100)}%` }}
              transition={{ delay: 1 + i * 0.03, duration: 0.5 }}
              className="flex-1 min-w-[4px] rounded-t-sm"
              style={{ backgroundColor: v > 0 ? '#f87171' : 'transparent' }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function HomePage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    fetch('/api/dashboard').then(r => r.json()).then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const { events, connected } = useRealtimeDashboard(refresh)

  const safeData = data || {
    totalRevenue: 0,
    statusCounts: { success: 0, pending: 0, processing: 0, failed: 0, expired: 0, cancelled: 0 },
    successRate: '0',
    appRevenue: [],
    providerRevenue: [],
    tenantRevenue: [],
    dailyRevenue: [],
    funnel: [],
    recentIntents: [],
    totalPayments: 0,
    notifStats: { total: 0, delivered: 0, pending: 0, retrying: 0, exhausted: 0 }
  }

  // Extra safety checks
  const safeStatusCounts = safeData.statusCounts || { success: 0, pending: 0, processing: 0, failed: 0, expired: 0, cancelled: 0 }
  const safeNotifStats = safeData.notifStats || { total: 0, delivered: 0, pending: 0, retrying: 0, exhausted: 0 }

  const maxDaily = Array.isArray(safeData.dailyRevenue) && safeData.dailyRevenue.length > 0 
    ? Math.max(...safeData.dailyRevenue.map(d => d.revenue), 1) 
    : 1

  return (
    <main className="min-h-screen relative">
      <FloatingGeometry />
      <CursorTrail />
      <Navigation />

      <div className="pt-16">
        {/* Hero heading with kinetic type */}
        <div className="px-6 md:px-16 lg:px-24 pt-8 pb-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
          >
            <div className="overflow-hidden">
              <motion.h1
                initial={{ y: 80 }}
                animate={{ y: 0 }}
                transition={{ delay: 0.3, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                className="text-4xl md:text-6xl font-black tracking-[-0.03em]"
              >
                Finance<span className="text-primary"> HQ</span>
              </motion.h1>
            </div>
            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ delay: 1, duration: 1, ease: [0.22, 1, 0.36, 1] }}
              className="h-px bg-gradient-to-r from-primary via-primary/30 to-transparent mt-4 origin-left"
            />
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.4, duration: 0.5 }}
              className="flex flex-col md:flex-row md:items-center md:justify-between mt-4 gap-3"
            >
              <p className="text-sm text-muted-foreground">Payment Service — multi-app, multi-tenant, multi-provider</p>
              <div className="flex items-center gap-3">
                {/* Realtime Connection Status */}
                <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
                  connected ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/15 text-red-400 border border-red-500/20'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                  {connected ? 'Live' : 'Reconnecting...'}
                </div>
                <div className="w-2 h-2 rounded-full bg-emerald-400 pulse-live" />
                <span className="text-[10px] font-mono text-muted-foreground">All systems operational</span>
              </div>
            </motion.div>
          </motion.div>
        </div>

        {loading ? (
          <div className="px-6 md:px-16 lg:px-24 py-8 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.1 }} className="p-6 bg-card border border-border/50 rounded-xl animate-pulse">
                <div className="h-3 bg-foreground/10 w-20 mb-2 rounded" />
                <div className="h-8 bg-foreground/10 w-28 rounded" />
              </motion.div>
            ))}
          </div>
        ) : (
          <div className="px-6 md:px-16 lg:px-24 py-4 space-y-6">

            {/* Top stats — 3D tilt cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 scene-3d">
              {[
                { label: 'Total Revenue', value: fmt(safeData.totalRevenue), sub: `${safeData.totalPayments} intents`, accent: '#4ade80', delay: 1.6 },
                { label: 'Success Rate', value: `${safeData.successRate}%`, sub: `${safeStatusCounts.success} successful`, accent: '#34d399', delay: 1.7 },
                { label: 'Processing', value: String(safeStatusCounts.processing), sub: 'Awaiting customer', delay: 1.8 },
                { label: 'Pending', value: String(safeStatusCounts.pending), sub: 'Not yet sent', delay: 1.9 },
                { label: 'Failed', value: String(safeStatusCounts.failed), sub: 'Needs attention', accent: '#f87171', delay: 2.0 },
                { label: 'Expired', value: String(safeStatusCounts.expired), sub: 'Timed out', delay: 2.1 },
              ].map((stat, i) => (
                <TiltCard key={stat.label} tiltAmount={8}>
                  <motion.div
                    initial={{ opacity: 0, y: 30, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: stat.delay, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                    className="p-4 md:p-5 bg-card border border-border/50 rounded-xl"
                  >
                    <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase">{stat.label}</span>
                    <motion.div
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: stat.delay + 0.2, duration: 0.4 }}
                      className="text-xl md:text-2xl font-black tracking-tight mt-1"
                      style={stat.accent ? { color: stat.accent } : {}}
                    >
                      {stat.value}
                    </motion.div>
                    {stat.sub && <span className="text-[10px] font-mono text-muted-foreground mt-1 block">{stat.sub}</span>}
                  </motion.div>
                </TiltCard>
              ))}
            </div>

            {/* Revenue by app + Funnel */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <motion.div initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 2.2, duration: 0.6 }}>
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase">Revenue by Application</span>
                <div className="space-y-3 mt-3">
                  {(Array.isArray(safeData.appRevenue) ? safeData.appRevenue : []).map((app, i) => {
                    const pct = safeData.totalRevenue > 0 ? (app.revenue / safeData.totalRevenue) * 100 : 0
                    return (
                      <motion.div
                        key={app.code}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 2.3 + i * 0.1 }}
                        className="stat-card p-4 bg-card border border-border/50 rounded-xl"
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <h4 className="text-xs font-bold text-muted-foreground">{app.name}</h4>
                            <span className="text-2xl font-black" style={{ color: appColors[app.code] }}>{fmt(app.revenue)}</span>
                          </div>
                          <span className="text-[10px] font-mono text-muted-foreground">{app.successCount}/{app.count}</span>
                        </div>
                        <div className="mt-3 h-2 bg-foreground/5 rounded-full overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${pct}%` }}
                            transition={{ delay: 2.5 + i * 0.1, duration: 1, ease: [0.22, 1, 0.36, 1] }}
                            className="h-full rounded-full"
                            style={{ backgroundColor: appColors[app.code] }}
                          />
                        </div>
                        <span className="text-[10px] font-mono text-muted-foreground mt-1 block">{pct.toFixed(1)}% of total</span>
                      </motion.div>
                    )
                  })}
                </div>
              </motion.div>

              <motion.div initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 2.4, duration: 0.6 }}>
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase">Payment Funnel</span>
                <div className="space-y-3 mt-3">
                  {(Array.isArray(safeData.funnel) ? safeData.funnel : []).map((f, i) => (
                    <motion.div
                      key={f.application}
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 2.5 + i * 0.1 }}
                      className="stat-card p-4 bg-card border border-border/50 rounded-xl"
                    >
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-sm font-bold">{f.application}</span>
                        <span className="text-lg font-black text-primary">{f.rate}%</span>
                      </div>
                      <div className="flex gap-1 h-7 rounded-lg overflow-hidden bg-foreground/5">
                        {f.success > 0 && (
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${(f.success / f.total) * 100}%` }}
                            transition={{ delay: 2.7 + i * 0.1, duration: 0.8 }}
                            className="bg-emerald-500/70 flex items-center justify-center"
                          >
                            <span className="text-[9px] font-mono text-white font-bold">{f.success}</span>
                          </motion.div>
                        )}
                        {f.inFlight > 0 && (
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${(f.inFlight / f.total) * 100}%` }}
                            transition={{ delay: 2.9 + i * 0.1, duration: 0.8 }}
                            className="bg-amber-500/50 flex items-center justify-center"
                          >
                            <span className="text-[9px] font-mono text-white font-bold">{f.inFlight}</span>
                          </motion.div>
                        )}
                        {f.failed > 0 && (
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${(f.failed / f.total) * 100}%` }}
                            transition={{ delay: 3.1 + i * 0.1, duration: 0.8 }}
                            className="bg-red-500/50 flex items-center justify-center"
                          >
                            <span className="text-[9px] font-mono text-white font-bold">{f.failed}</span>
                          </motion.div>
                        )}
                      </div>
                      <div className="flex gap-4 mt-2 text-[9px] font-mono text-muted-foreground">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500/70" />success</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500/50" />in-flight</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/50" />failed</span>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            </div>

            {/* Daily revenue + Provider */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 3.2 }} className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl">
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase block mb-4">Daily Revenue — 14 Days</span>
                <BarChart 
                  data={(Array.isArray(safeData.dailyRevenue) ? safeData.dailyRevenue : []).map(d => d.revenue)} 
                  maxVal={maxDaily} 
                  color="#4ade80" 
                  failData={(Array.isArray(safeData.dailyRevenue) ? safeData.dailyRevenue : []).map(d => d.failed)} 
                />
                <div className="flex justify-between mt-2">
                  <span className="text-[10px] font-mono text-muted-foreground">14 days ago</span>
                  <span className="text-[10px] font-mono text-muted-foreground">Today</span>
                </div>
              </motion.div>

              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 3.3 }} className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl">
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase block mb-4">Revenue by Provider</span>
                <div className="space-y-3">
                  {(Array.isArray(safeData.providerRevenue) ? safeData.providerRevenue : []).map((p, i) => {
                    const providerRevenueArray = Array.isArray(safeData.providerRevenue) ? safeData.providerRevenue : []
                    const maxP = providerRevenueArray.length > 0 
                      ? Math.max(...providerRevenueArray.map(x => x.revenue), 1) 
                      : 1
                    return (
                      <motion.div key={p.code} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 3.4 + i * 0.08 }}>
                        <div className="flex justify-between mb-1">
                          <span className="text-sm font-mono font-medium">{p.name}</span>
                          <span className="text-sm font-mono text-muted-foreground">{fmt(p.revenue)}</span>
                        </div>
                        <div className="h-2 bg-foreground/5 rounded-full overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${(p.revenue / maxP) * 100}%` }}
                            transition={{ delay: 3.5 + i * 0.08, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                            className="h-full rounded-full"
                            style={{ backgroundColor: provColors[p.code] }}
                          />
                        </div>
                      </motion.div>
                    )
                  })}
                </div>
              </motion.div>
            </div>

            {/* Tenant Revenue + Notifications */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 3.6 }} className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl">
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase block mb-4">Revenue by Tenant</span>
                <div className="space-y-2">
                  {(Array.isArray(safeData.tenantRevenue) ? safeData.tenantRevenue : []).map((t, i) => (
                    <motion.div key={t.code} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 3.7 + i * 0.08 }}
                      className="table-row-hover flex items-center justify-between py-2.5 px-3 border-b border-border/30 rounded-lg"
                    >
                      <div>
                        <span className="text-sm font-mono font-medium">{t.name}</span>
                        <span className="text-[10px] font-mono text-muted-foreground ml-2">({t.application})</span>
                      </div>
                      <div className="text-right">
                        <span className="text-sm font-mono font-bold" style={{ color: appColors[t.application] }}>{fmt(t.revenue)}</span>
                        <span className="text-[10px] font-mono text-muted-foreground ml-2">{t.count}</span>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>

              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 3.8 }} className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl">
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase block mb-4">Internal Notifications</span>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Delivered', value: safeNotifStats.delivered, color: '#34d399' },
                    { label: 'Pending', value: safeNotifStats.pending, color: '#fbbf24' },
                    { label: 'Retrying', value: safeNotifStats.retrying, color: '#38bdf8' },
                    { label: 'Exhausted', value: safeNotifStats.exhausted, color: '#f87171' },
                  ].map((n, i) => (
                    <motion.div key={n.label} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 3.9 + i * 0.08, type: 'spring', stiffness: 200 }}
                      className="p-3 bg-foreground/[0.03] border border-border/30 rounded-lg text-center"
                    >
                      <span className="text-[10px] font-mono text-muted-foreground block">{n.label}</span>
                      <span className="text-xl font-black block mt-1" style={{ color: n.color }}>{n.value}</span>
                    </motion.div>
                  ))}
                </div>
                <p className="text-[10px] font-mono text-muted-foreground mt-3">Cron retries pending/failed_retrying with exponential backoff</p>
              </motion.div>
            </div>

            {/* 3D Architecture Flow */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 4 }} className="glass-3d p-4 md:p-6 rounded-xl">
              <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase block mb-4">Architecture Overview — 3D Payment Flow</span>
              <PaymentFlow3D />
              <p className="text-[10px] font-mono text-muted-foreground text-center mt-3">
                Routing by application_id + tenant_id (NOT string-parsing) · Idempotency: idempotency_key on payment_intents
              </p>
            </motion.div>

            {/* Recent transactions */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 4.2 }} className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase">Recent Payment Intents</span>
                <Link href="/transactions" className="text-[10px] font-mono tracking-[0.15em] text-primary hover:text-primary/80 transition-colors uppercase">View All →</Link>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border/50">
                      {['Reference', 'App', 'Tenant', 'Type', 'Amount', 'Provider', 'Date', 'Status'].map(h => (
                        <th key={h} className="text-[10px] font-mono tracking-[0.15em] text-muted-foreground uppercase pb-3 pr-4">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(Array.isArray(safeData.recentIntents) ? safeData.recentIntents : []).slice(0, 10).map((p, i) => (
                      <motion.tr key={p.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 4.3 + i * 0.03 }}
                        className="table-row-hover border-b border-border/20"
                      >
                        <td className="text-xs font-mono text-foreground/70 py-2.5 pr-4">{p.reference}</td>
                        <td className="text-xs font-mono py-2.5 pr-4 font-medium" style={{ color: appColors[p.applicationCode] }}>{p.applicationCode}</td>
                        <td className="text-xs font-mono text-muted-foreground py-2.5 pr-4">{p.tenantName || '—'}</td>
                        <td className="text-xs font-mono text-muted-foreground py-2.5 pr-4">{(p.paymentType || '').replace(/_/g, ' ')}</td>
                        <td className="text-xs font-mono py-2.5 pr-4 font-medium">{fmt(p.amount)}</td>
                        <td className="text-xs font-mono text-muted-foreground py-2.5 pr-4">{p.providerCode}</td>
                        <td className="text-xs font-mono text-muted-foreground py-2.5 pr-4">{fmtDate(p.createdAt)}</td>
                        <td className="py-2.5"><span className={`text-[10px] font-mono tracking-wider px-2.5 py-1 rounded-md ${statusColors[p.status] || ''}`}>{p.status}</span></td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>

            {/* Live Feed */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 4.5 }} className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase">Live Feed</span>
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {events.map((event, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-center gap-3 text-xs p-3 bg-foreground/[0.02] rounded-lg border border-border/30"
                  >
                    <span className="text-lg">
                      {event.type === 'payment' ? '💳' : event.type === 'webhook' ? '🔔' : '📢'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-muted-foreground font-mono">{event.timestamp.toLocaleTimeString()}</span>
                      <span className="ml-2 font-medium">
                        {event.type === 'payment'
                          ? `Payment ${(event.payload.status as string) || 'updated'} — ${(event.payload.reference as string) || 'Unknown'}`
                          : event.type === 'webhook'
                          ? `Webhook received`
                          : `Notification ${(event.payload.status as string) || 'updated'}`
                        }
                      </span>
                    </div>
                  </motion.div>
                ))}
                {events.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    <p>No live events yet</p>
                    <p className="text-xs mt-1">Events will appear here as they happen</p>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </div>

      <footer className="px-6 md:px-16 lg:px-24 py-6 border-t border-border/30 mt-8">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-muted-foreground">Na&apos;jiki Tech — Payment Service</span>
          <span className="text-[10px] font-mono text-muted-foreground">{new Date().getFullYear()}</span>
        </div>
      </footer>
    </main>
  )
}
