'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Navigation } from '@/components/app/navigation'
import { FloatingGeometry } from '@/components/app/floating-geometry'
import { CursorTrail } from '@/components/app/cursor-trail'

interface WebhookLog {
  id: string
  providerCode: string
  providerName: string
  paymentIntentId: string | null
  payload: string
  headers: string | null
  signatureValid: boolean
  processed: boolean
  processingError: string | null
  createdAt: string
  payment: { reference: string; amount: number; status: string } | null
}

const fmtDate = (d: string | Date) => {
  const date = new Date(d)
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) + ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const provColors: Record<string, string> = { livepay: '#4ade80', mtn: '#fbbf24', airtel: '#f87171', pesapal: '#a78bfa' }

export default function WebhooksPage() {
  const [logs, setLogs] = useState<WebhookLog[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/webhooks')
      .then(r => r.json())
      .then(d => { 
        setLogs(Array.isArray(d) ? d : []); 
        setLoading(false) 
      })
      .catch(() => { 
        setLogs([]); 
        setLoading(false) 
      })
  }, [])

  const safeLogs = Array.isArray(logs) ? logs : []
  const verifiedCount = safeLogs.filter(l => l.signatureValid).length
  const processedCount = safeLogs.filter(l => l.processed).length
  const errorCount = safeLogs.filter(l => l.processingError).length

  return (
    <main className="min-h-screen relative">
      <FloatingGeometry />
      <CursorTrail />
      <Navigation />
      <div className="pt-14">
        <div className="px-6 md:px-16 lg:px-24 pt-8 pb-4">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-black tracking-tight">Webhook Logs</h1>
              <p className="text-sm text-foreground/40 mt-1">Every webhook received — valid or not. Evidence trail for disputes and debugging.</p>
            </div>
            <div className="flex gap-4 text-sm font-mono">
              <span className="text-foreground/40">{safeLogs.length} total</span>
              <span className="text-foreground/20">|</span>
              <span className="text-green-400/70">{verifiedCount} verified</span>
              <span className="text-foreground/20">|</span>
              <span className="text-blue-400/70">{processedCount} processed</span>
              {errorCount > 0 && <><span className="text-foreground/20">|</span><span className="text-red-400/70">{errorCount} errors</span></>}
            </div>
          </div>
        </div>

        <div className="px-6 md:px-16 lg:px-24 py-2">
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-card border border-foreground/10">
              <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase">Signature Verified</span>
              <div className="text-xl font-black text-green-400 mt-1">{verifiedCount} / {safeLogs.length}</div>
            </div>
            <div className="p-4 bg-card border border-foreground/10">
              <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase">Processed</span>
              <div className="text-xl font-black text-blue-400 mt-1">{processedCount} / {safeLogs.length}</div>
            </div>
            <div className="p-4 bg-card border border-foreground/10">
              <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase">Errors</span>
              <div className="text-xl font-black text-red-400 mt-1">{errorCount}</div>
            </div>
          </div>
        </div>

        <div className="px-6 md:px-16 lg:px-24 py-4 pb-8">
          {loading ? (
            <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 bg-card border border-foreground/5 animate-pulse" />)}</div>
          ) : (
            <div className="space-y-2">
              {safeLogs.map((log, i) => (
                <motion.div key={log.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} className="bg-card border border-foreground/10">
                  <button onClick={() => setExpandedId(expandedId === log.id ? null : log.id)} className="w-full flex items-center justify-between p-4 text-left hover:bg-foreground/[0.02]">
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${log.signatureValid ? 'bg-green-500' : 'bg-red-500'}`} />
                        <span className={`w-2 h-2 rounded-full ${log.processed ? 'bg-blue-500' : 'bg-yellow-500'}`} />
                      </div>
                      <span className="text-xs font-mono font-bold" style={{ color: provColors[log.providerCode] || '#fff' }}>{log.providerName}</span>
                      {log.payment && <span className="text-xs font-mono text-foreground/40">{log.payment.reference}</span>}
                      {!log.signatureValid && <span className="text-[10px] font-mono text-red-400 bg-red-500/10 px-2 py-0.5 rounded-sm">INVALID SIG</span>}
                    </div>
                    <div className="flex items-center gap-4">
                      {log.processingError && <span className="text-[10px] font-mono text-red-400">ERROR</span>}
                      <span className="text-[10px] font-mono text-foreground/30">{fmtDate(log.createdAt)}</span>
                      <span className="text-foreground/20 text-xs">{expandedId === log.id ? '▼' : '▶'}</span>
                    </div>
                  </button>

                  {expandedId === log.id && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} className="border-t border-foreground/5 p-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                        <div>
                          <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase block mb-1">Provider</span>
                          <span className="text-sm font-mono" style={{ color: provColors[log.providerCode] }}>{log.providerName}</span>
                        </div>
                        <div>
                          <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase block mb-1">Signature Valid</span>
                          <span className={`text-sm font-mono ${log.signatureValid ? 'text-green-400' : 'text-red-400'}`}>{log.signatureValid ? 'Yes' : 'No'}</span>
                        </div>
                        <div>
                          <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase block mb-1">Processed</span>
                          <span className={`text-sm font-mono ${log.processed ? 'text-blue-400' : 'text-yellow-400'}`}>{log.processed ? 'Yes' : 'No'}</span>
                        </div>
                        {log.payment && (
                          <>
                            <div>
                              <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase block mb-1">Payment Reference</span>
                              <span className="text-sm font-mono text-foreground/60">{log.payment.reference}</span>
                            </div>
                            <div>
                              <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase block mb-1">Amount</span>
                              <span className="text-sm font-mono">UGX {log.payment.amount.toLocaleString()}</span>
                            </div>
                            <div>
                              <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase block mb-1">Payment Status</span>
                              <span className="text-sm font-mono">{log.payment.status}</span>
                            </div>
                          </>
                        )}
                        {log.processingError && (
                          <div className="md:col-span-3">
                            <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase block mb-1">Error</span>
                            <span className="text-sm font-mono text-red-400">{log.processingError}</span>
                          </div>
                        )}
                      </div>
                      <div>
                        <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase block mb-1">Payload</span>
                        <pre className="text-[10px] font-mono text-foreground/40 bg-foreground/[0.03] p-3 rounded overflow-x-auto max-h-40">
                          {(() => { try { return JSON.stringify(JSON.parse(log.payload), null, 2) } catch { return log.payload } })()}
                        </pre>
                      </div>
                      {log.headers && (
                        <div className="mt-3">
                          <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase block mb-1">Headers</span>
                          <pre className="text-[10px] font-mono text-foreground/30 bg-foreground/[0.03] p-3 rounded overflow-x-auto max-h-20">
                            {(() => { try { return JSON.stringify(JSON.parse(log.headers), null, 2) } catch { return log.headers } })()}
                          </pre>
                        </div>
                      )}
                    </motion.div>
                  )}
                </motion.div>
              ))}
              {safeLogs.length === 0 && <div className="p-8 text-center text-sm text-foreground/30 font-mono">No webhook logs found</div>}
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
