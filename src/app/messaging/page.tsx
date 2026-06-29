'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Navigation } from '@/components/app/navigation'
import { CursorTrail } from '@/components/app/cursor-trail'
import { FloatingGeometry } from '@/components/app/floating-geometry'
import { TiltCard } from '@/components/app/tilt-card'
import { SendSmsForm } from '@/components/app/send-sms-form'
import Link from 'next/link'

interface MessagingDashboardData {
  totalSent: number
  statusCounts: { delivered: number; pending: number; failed: number; queued: number }
  deliveryRate: string
  appUsage: { code: string; name: string; count: number; cost: number }[]
  providerUsage: { code: string; name: string; count: number; cost: number }[]
  dailyVolume: { date: string; volume: number; failed: number }[]
  recentMessages: {
    id: string; reference: string; application: string; applicationCode: string
    recipient: string; status: string; providerCode: string
    createdAt: string; cost: number
  }[]
  totalCost: number
}

const fmtCost = (n: number | undefined | null) => {
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

// Color palette
const appColors: Record<string, string> = { sacco: '#4ade80', church: '#fbbf24', school: '#fb923c' }
const provColors: Record<string, string> = { africastalking: '#38bdf8', twilio: '#f87171' }
const statusColors: Record<string, string> = {
  delivered: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20',
  pending: 'bg-amber-500/15 text-amber-400 border border-amber-500/20',
  queued: 'bg-sky-500/15 text-sky-400 border border-sky-500/20',
  failed: 'bg-red-500/15 text-red-400 border border-red-500/20',
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
                {v.toLocaleString()} msgs
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

export default function MessagingDashboard() {
  const [data, setData] = useState<MessagingDashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  // MOCK DATA for Interface building
  useEffect(() => {
    setTimeout(() => {
      setData({
        totalSent: 12450,
        totalCost: 373500,
        statusCounts: { delivered: 11800, pending: 350, failed: 100, queued: 200 },
        deliveryRate: '98.5',
        appUsage: [
          { code: 'school', name: 'School Fees App', count: 8500, cost: 255000 },
          { code: 'sacco', name: 'Sacco Connect', count: 2100, cost: 63000 },
          { code: 'church', name: 'Church Tithes', count: 1850, cost: 55500 },
        ],
        providerUsage: [
          { code: 'africastalking', name: "Africa's Talking", count: 11000, cost: 330000 },
          { code: 'twilio', name: 'Twilio (WhatsApp)', count: 1450, cost: 43500 },
        ],
        dailyVolume: Array.from({ length: 14 }).map((_, i) => ({
          date: new Date(Date.now() - (13 - i) * 86400000).toISOString(),
          volume: Math.floor(Math.random() * 1500) + 500,
          failed: Math.floor(Math.random() * 50)
        })),
        recentMessages: [
          { id: '1', reference: 'MSG-001', application: 'School Fees App', applicationCode: 'school', recipient: '+256770000001', status: 'delivered', providerCode: 'africastalking', createdAt: new Date(Date.now() - 10000).toISOString(), cost: 30 },
          { id: '2', reference: 'MSG-002', application: 'Sacco Connect', applicationCode: 'sacco', recipient: '+256780000002', status: 'queued', providerCode: 'africastalking', createdAt: new Date(Date.now() - 45000).toISOString(), cost: 30 },
          { id: '3', reference: 'MSG-003', application: 'School Fees App', applicationCode: 'school', recipient: '+256750000003', status: 'failed', providerCode: 'twilio', createdAt: new Date(Date.now() - 120000).toISOString(), cost: 50 },
          { id: '4', reference: 'MSG-004', application: 'Church Tithes', applicationCode: 'church', recipient: '+256700000004', status: 'delivered', providerCode: 'africastalking', createdAt: new Date(Date.now() - 360000).toISOString(), cost: 30 },
        ]
      })
      setLoading(false)
    }, 1000)
  }, [])

  const safeData = data || {
    totalSent: 0,
    totalCost: 0,
    statusCounts: { delivered: 0, pending: 0, failed: 0, queued: 0 },
    deliveryRate: '0',
    appUsage: [],
    providerUsage: [],
    dailyVolume: [],
    recentMessages: []
  }

  const safeStatusCounts = safeData.statusCounts
  const maxDaily = Array.isArray(safeData.dailyVolume) && safeData.dailyVolume.length > 0 
    ? Math.max(...safeData.dailyVolume.map(d => d.volume), 1) 
    : 1

  return (
    <main className="min-h-screen relative">
      <FloatingGeometry />
      <CursorTrail />
      <Navigation />

      <div className="pt-16">
        <div className="px-6 md:px-16 lg:px-24 pt-8 pb-6">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
            <div className="overflow-hidden">
              <motion.h1
                initial={{ y: 80 }}
                animate={{ y: 0 }}
                transition={{ delay: 0.3, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                className="text-4xl md:text-6xl font-black tracking-[-0.03em]"
              >
                Messaging<span className="text-primary"> HQ</span>
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
              <p className="text-sm text-muted-foreground">Omnichannel Messaging — SMS, WhatsApp, Push</p>
              <div className="flex items-center gap-3">
                <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Live
                </div>
                <div className="w-2 h-2 rounded-full bg-emerald-400 pulse-live" />
                <span className="text-[10px] font-mono text-muted-foreground">Providers online</span>
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
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 scene-3d">
              {[
                { label: 'Total Sent', value: safeData.totalSent.toLocaleString(), sub: 'Across all channels', accent: '#38bdf8', delay: 1.6 },
                { label: 'Delivery Rate', value: `${safeData.deliveryRate}%`, sub: `${safeStatusCounts.delivered} confirmed`, accent: '#34d399', delay: 1.7 },
                { label: 'Queued', value: String(safeStatusCounts.queued), sub: 'Waiting for provider', delay: 1.8 },
                { label: 'Pending', value: String(safeStatusCounts.pending), sub: 'In transit', delay: 1.9 },
                { label: 'Failed', value: String(safeStatusCounts.failed), sub: 'Delivery failed', accent: '#f87171', delay: 2.0 },
                { label: 'Total Cost', value: fmtCost(safeData.totalCost), sub: 'Estimated spend', accent: '#fbbf24', delay: 2.1 },
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

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <motion.div initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 2.2, duration: 0.6 }}>
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase">Volume by Application</span>
                <div className="space-y-3 mt-3">
                  {safeData.appUsage.map((app, i) => {
                    const pct = safeData.totalSent > 0 ? (app.count / safeData.totalSent) * 100 : 0
                    return (
                      <motion.div key={app.code} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 2.3 + i * 0.1 }} className="stat-card p-4 bg-card border border-border/50 rounded-xl">
                        <div className="flex justify-between items-start">
                          <div>
                            <h4 className="text-xs font-bold text-muted-foreground">{app.name}</h4>
                            <span className="text-2xl font-black" style={{ color: appColors[app.code] }}>{app.count.toLocaleString()}</span>
                          </div>
                          <span className="text-[10px] font-mono text-muted-foreground">{fmtCost(app.cost)}</span>
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
                        <span className="text-[10px] font-mono text-muted-foreground mt-1 block">{pct.toFixed(1)}% of total volume</span>
                      </motion.div>
                    )
                  })}
                </div>
              </motion.div>

              <motion.div initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 2.4, duration: 0.6 }} className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl">
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase block mb-4">Volume by Provider</span>
                <div className="space-y-4">
                  {safeData.providerUsage.map((p, i) => {
                    const maxP = Math.max(...safeData.providerUsage.map(x => x.count), 1)
                    return (
                      <motion.div key={p.code} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2.5 + i * 0.1 }}>
                        <div className="flex justify-between mb-1">
                          <span className="text-sm font-mono font-medium">{p.name}</span>
                          <span className="text-sm font-mono text-muted-foreground">{p.count.toLocaleString()}</span>
                        </div>
                        <div className="h-2 bg-foreground/5 rounded-full overflow-hidden mb-1">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${(p.count / maxP) * 100}%` }}
                            transition={{ delay: 2.6 + i * 0.1, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                            className="h-full rounded-full"
                            style={{ backgroundColor: provColors[p.code] }}
                          />
                        </div>
                        <span className="text-[10px] font-mono text-muted-foreground text-right block">{fmtCost(p.cost)} cost</span>
                      </motion.div>
                    )
                  })}
                </div>
              </motion.div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 3.2 }} className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl">
                <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase block mb-4">Daily Volume — 14 Days</span>
                <BarChart 
                  data={safeData.dailyVolume.map(d => d.volume)} 
                  maxVal={maxDaily} 
                  color="#38bdf8" 
                  failData={safeData.dailyVolume.map(d => d.failed)} 
                />
                <div className="flex justify-between mt-2">
                  <span className="text-[10px] font-mono text-muted-foreground">14 days ago</span>
                  <span className="text-[10px] font-mono text-muted-foreground">Today</span>
                </div>
              </motion.div>

              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 3.3 }} className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase">Recent Messages</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-border/50">
                        {['Recipient', 'App', 'Provider', 'Date', 'Status'].map(h => (
                          <th key={h} className="text-[10px] font-mono tracking-[0.15em] text-muted-foreground uppercase pb-3 pr-4">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {safeData.recentMessages.slice(0, 6).map((m, i) => (
                        <motion.tr key={m.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 3.4 + i * 0.03 }}
                          className="table-row-hover border-b border-border/20"
                        >
                          <td className="text-xs font-mono text-foreground/70 py-2.5 pr-4">{m.recipient}</td>
                          <td className="text-xs font-mono py-2.5 pr-4 font-medium" style={{ color: appColors[m.applicationCode] }}>{m.applicationCode}</td>
                          <td className="text-xs font-mono text-muted-foreground py-2.5 pr-4">{m.providerCode}</td>
                          <td className="text-xs font-mono text-muted-foreground py-2.5 pr-4">{fmtDate(m.createdAt)}</td>
                          <td className="py-2.5"><span className={`text-[10px] font-mono tracking-wider px-2.5 py-1 rounded-md ${statusColors[m.status] || ''}`}>{m.status}</span></td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </motion.div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <SendSmsForm />
            </div>
          </div>
        )}
      </div>

      <footer className="px-6 md:px-16 lg:px-24 py-6 border-t border-border/30 mt-8">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-muted-foreground">Na&apos;jiki Tech — Messaging Service</span>
          <span className="text-[10px] font-mono text-muted-foreground">{new Date().getFullYear()}</span>
        </div>
      </footer>
    </main>
  )
}
