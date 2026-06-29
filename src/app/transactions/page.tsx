'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Navigation } from '@/components/app/navigation'
import { FloatingGeometry } from '@/components/app/floating-geometry'
import { CursorTrail } from '@/components/app/cursor-trail'

interface PaymentIntent {
  id: string; reference: string; application: string; applicationCode: string
  tenantName: string | null; tenantCode: string | null; paymentType: string | null
  amount: number; currency: string; status: string; provider: string; providerCode: string
  phoneNumber: string | null; externalEntityId: string | null; failureReason: string | null
  createdAt: string; completedAt: string | null
}

interface DashboardData {
  recentIntents: PaymentIntent[]
  appRevenue: { code: string; name: string }[]
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
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) + ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

const appColors: Record<string, string> = { sacco: '#4ade80', church: '#fbbf24', school: '#fb923c' }
const statusColors: Record<string, string> = { success: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20', pending: 'bg-amber-500/15 text-amber-400 border border-amber-500/20', processing: 'bg-sky-500/15 text-sky-400 border border-sky-500/20', failed: 'bg-red-500/15 text-red-400 border border-red-500/20', expired: 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/20', cancelled: 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/20' }

export default function TransactionsPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [filterApp, setFilterApp] = useState('ALL')
  const [filterStatus, setFilterStatus] = useState('ALL')
  const [filterType, setFilterType] = useState('ALL')

  useEffect(() => {
    fetch('/api/dashboard')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const safeRecentIntents = Array.isArray(data?.recentIntents) ? data.recentIntents : []
  const payments = safeRecentIntents
  const filtered = payments.filter(p => {
    if (filterApp !== 'ALL' && p.applicationCode !== filterApp) return false
    if (filterStatus !== 'ALL' && p.status !== filterStatus) return false
    if (filterType !== 'ALL' && p.paymentType !== filterType) return false
    return true
  })

  const paymentTypes = [...new Set(payments.map(p => p.paymentType).filter((t): t is string => t !== null))]
  const totalFiltered = filtered.reduce((s, p) => s + p.amount, 0)
  const successFiltered = filtered.filter(p => p.status === 'success').length

  return (
    <main className="min-h-screen relative">
      <FloatingGeometry />
      <CursorTrail />
      <Navigation />
      <div className="pt-14">
        <div className="px-6 md:px-16 lg:px-24 pt-8 pb-4">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-black tracking-tight">Payment Intents</h1>
              <p className="text-sm text-foreground/40 mt-1">All payment intents across applications and tenants</p>
            </div>
            <div className="flex gap-4 text-sm font-mono">
              <span className="text-foreground/40">{filtered.length} results</span>
              <span className="text-foreground/20">|</span>
              <span className="text-accent/70">{fmt(totalFiltered)}</span>
              <span className="text-foreground/20">|</span>
              <span className="text-green-400/70">{successFiltered} successful</span>
            </div>
          </div>
        </div>

        <div className="px-6 md:px-16 lg:px-24 py-4">
          <div className="flex flex-wrap gap-3">
            <select value={filterApp} onChange={e => setFilterApp(e.target.value)} className="bg-card border border-foreground/10 px-3 py-2 text-xs font-mono text-foreground/60 focus:border-accent focus:outline-none">
              <option value="ALL">All Applications</option>
              <option value="sacco">SACCO</option>
              <option value="church">Church</option>
              <option value="school">School</option>
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="bg-card border border-foreground/10 px-3 py-2 text-xs font-mono text-foreground/60 focus:border-accent focus:outline-none">
              <option value="ALL">All Status</option>
              <option value="success">Success</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="failed">Failed</option>
              <option value="expired">Expired</option>
            </select>
            <select value={filterType} onChange={e => setFilterType(e.target.value)} className="bg-card border border-foreground/10 px-3 py-2 text-xs font-mono text-foreground/60 focus:border-accent focus:outline-none">
              <option value="ALL">All Types</option>
              {paymentTypes.map(t => <option key={t} value={t}>{(t || '').replace(/_/g, ' ')}</option>)}
            </select>
          </div>
        </div>

        <div className="px-6 md:px-16 lg:px-24 pb-8">
          {loading ? (
            <div className="space-y-3">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-12 bg-card border border-foreground/5 animate-pulse" />)}</div>
          ) : (
            <div className="bg-card border border-foreground/10 overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-foreground/10">
                    {['Reference', 'App', 'Tenant', 'Type', 'Amount', 'Provider', 'Phone', 'Entity', 'Date', 'Status'].map(h => (
                      <th key={h} className="text-[10px] font-mono tracking-[0.15em] text-foreground/30 uppercase p-3 pr-4">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p, i) => (
                    <motion.tr key={p.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.02 }} className="border-b border-foreground/5 hover:bg-foreground/[0.02]">
                      <td className="text-xs font-mono text-foreground/70 p-3 pr-4">{p.reference}</td>
                      <td className="text-xs font-mono p-3 pr-4" style={{ color: appColors[p.applicationCode] }}>{p.applicationCode}</td>
                      <td className="text-xs font-mono text-foreground/50 p-3 pr-4">{p.tenantName || '—'}</td>
                      <td className="text-xs font-mono text-foreground/50 p-3 pr-4">{(p.paymentType || '').replace(/_/g, ' ')}</td>
                      <td className="text-xs font-mono p-3 pr-4">{fmt(p.amount)}</td>
                      <td className="text-xs font-mono text-foreground/50 p-3 pr-4">{p.providerCode}</td>
                      <td className="text-xs font-mono text-foreground/40 p-3 pr-4">{p.phoneNumber || '—'}</td>
                      <td className="text-xs font-mono text-foreground/40 p-3 pr-4">{p.externalEntityId || '—'}</td>
                      <td className="text-xs font-mono text-foreground/40 p-3 pr-4">{fmtDate(p.createdAt)}</td>
                      <td className="p-3"><span className={`text-[10px] font-mono tracking-wider px-2 py-0.5 rounded-sm ${statusColors[p.status] || ''}`}>{p.status}</span></td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && <div className="p-8 text-center text-sm text-foreground/30 font-mono">No payment intents match your filters</div>}
            </div>
          )}
        </div>
      </div>
      <footer className="px-6 md:px-16 lg:px-24 py-6 border-t border-foreground/5 mt-auto">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-foreground/20">Na&apos;jiki Tech — Payment Service</span>
          <span className="text-[10px] font-mono text-foreground/20">{new Date().getFullYear()}</span>
        </div>
      </footer>
    </main>
  )
}
