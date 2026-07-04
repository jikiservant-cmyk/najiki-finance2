'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Navigation } from '@/components/app/navigation'
import { FloatingGeometry } from '@/components/app/floating-geometry'
import { CursorTrail } from '@/components/app/cursor-trail'
import { useToast } from '@/hooks/use-toast'
import { Zap, RefreshCw, CheckCircle2, AlertTriangle, Play, HelpCircle } from 'lucide-react'

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

interface PaymentIntent {
  id: string
  reference: string
  amount: number
  currency: string
  status: string
  provider: string
  providerCode: string
  phoneNumber: string | null
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
  
  // Simulation states
  const [activePayments, setActivePayments] = useState<PaymentIntent[]>([])
  const [selectedRef, setSelectedRef] = useState('')
  const [simStatus, setSimStatus] = useState('success')
  const [simulating, setSimulating] = useState(false)
  const [simResult, setSimResult] = useState<any | null>(null)
  const { toast } = useToast()

  const fetchLogs = () => {
    setLoading(true)
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
  }

  const fetchActivePayments = () => {
    fetch('/api/dashboard')
      .then(r => r.json())
      .then(d => {
        if (d && Array.isArray(d.recentIntents)) {
          // Filter to show pending or processing payment intents
          const pending = d.recentIntents.filter((p: any) => p.status === 'processing' || p.status === 'pending')
          setActivePayments(pending)
          if (pending.length > 0) {
            setSelectedRef(pending[0].reference)
          }
        }
      })
      .catch(err => console.error('Failed to load active payments:', err))
  }

  useEffect(() => {
    fetchLogs()
    fetchActivePayments()
  }, [])

  const handleSimulate = async () => {
    if (!selectedRef) {
      toast({
        title: "Error",
        description: "Please select a payment intent to simulate.",
        variant: "destructive"
      })
      return
    }

    setSimulating(true)
    setSimResult(null)

    try {
      const response = await fetch('/api/webhooks/simulate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reference: selectedRef,
          status: simStatus,
        }),
      })

      const result = await response.json()

      if (response.ok && result.success) {
        toast({
          title: "Simulation Successful",
          description: `Successfully processed webhook simulation for ${selectedRef}`,
        })
        setSimResult({
          success: true,
          status: result.status,
          payload: result.simulatedPayload,
          signatureHeader: result.signatureHeader,
          response: result.data,
        })
        // Refresh logs and payments
        fetchLogs()
        fetchActivePayments()
      } else {
        toast({
          title: "Simulation Failed",
          description: result.error || "Failed to process simulation.",
          variant: "destructive"
        })
        setSimResult({
          success: false,
          error: result.error || "Webhook endpoint returned an error.",
          response: result,
        })
      }
    } catch (err: any) {
      toast({
        title: "Request Error",
        description: err.message || "An error occurred during the simulation fetch request.",
        variant: "destructive"
      })
    } finally {
      setSimulating(false)
    }
  }

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
              <h1 className="text-3xl md:text-4xl font-black tracking-tight flex items-center gap-2">
                Webhook Logs
              </h1>
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

        {/* Stats Cards */}
        <div className="px-6 md:px-16 lg:px-24 py-2">
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-card border border-foreground/10 rounded-sm">
              <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase">Signature Verified</span>
              <div className="text-xl font-black text-green-400 mt-1">{verifiedCount} / {safeLogs.length}</div>
            </div>
            <div className="p-4 bg-card border border-foreground/10 rounded-sm">
              <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase">Processed</span>
              <div className="text-xl font-black text-blue-400 mt-1">{processedCount} / {safeLogs.length}</div>
            </div>
            <div className="p-4 bg-card border border-foreground/10 rounded-sm">
              <span className="text-[10px] font-mono tracking-[0.2em] text-foreground/30 uppercase">Errors</span>
              <div className="text-xl font-black text-red-400 mt-1">{errorCount}</div>
            </div>
          </div>
        </div>

        {/* Webhook Simulator Section */}
        <div className="px-6 md:px-16 lg:px-24 py-4">
          <div className="bg-card/40 border border-foreground/10 p-6 rounded-sm backdrop-blur-sm">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-5 h-5 text-yellow-400 fill-yellow-400" />
              <h2 className="text-lg font-bold tracking-tight">LivePay Webhook Simulator & Debugger</h2>
            </div>
            <p className="text-xs text-foreground/60 mb-6 max-w-3xl leading-relaxed">
              When payments are initiated in sandbox environments, webhooks may not reach your preview server due to URL/port routing mismatches or local development limits. Use this simulator to dispatch a perfectly signed, valid webhook to your backend handler to process pending intents, test transactions, and verify wallets and SMS integrations.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-mono tracking-[0.15em] text-foreground/40 uppercase block mb-1.5">
                    Select Processing Intent
                  </label>
                  {activePayments.length === 0 ? (
                    <div className="text-xs font-mono text-foreground/40 p-3 border border-dashed border-foreground/10 text-center rounded-sm">
                      No pending/processing payments found. Create a payment first!
                    </div>
                  ) : (
                    <select
                      value={selectedRef}
                      onChange={(e) => setSelectedRef(e.target.value)}
                      className="w-full bg-background border border-foreground/10 px-3 py-2 text-xs font-mono text-foreground/80 focus:outline-none focus:border-foreground/30 rounded-sm"
                    >
                      {activePayments.map((p) => (
                        <option key={p.id} value={p.reference}>
                          {p.reference.slice(0, 20)}... ({p.provider.toUpperCase()} - UGX {Number(p.amount).toLocaleString()})
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="text-[10px] font-mono tracking-[0.15em] text-foreground/40 uppercase block mb-1.5">
                    Webhook Status
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSimStatus('success')}
                      type="button"
                      className={`flex-1 py-1.5 px-3 border text-xs font-mono flex items-center justify-center gap-1.5 rounded-sm transition-colors ${
                        simStatus === 'success'
                          ? 'bg-green-500/10 border-green-500/50 text-green-400'
                          : 'border-foreground/10 text-foreground/40 hover:border-foreground/20'
                      }`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Success
                    </button>
                    <button
                      onClick={() => setSimStatus('failed')}
                      type="button"
                      className={`flex-1 py-1.5 px-3 border text-xs font-mono flex items-center justify-center gap-1.5 rounded-sm transition-colors ${
                        simStatus === 'failed'
                          ? 'bg-red-500/10 border-red-500/50 text-red-400'
                          : 'border-foreground/10 text-foreground/40 hover:border-foreground/20'
                      }`}
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Failed
                    </button>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    onClick={handleSimulate}
                    disabled={simulating || !selectedRef}
                    className="w-full h-[36px] bg-foreground text-background font-mono text-xs font-bold hover:bg-foreground/90 disabled:opacity-50 flex items-center justify-center gap-2 rounded-sm transition-opacity"
                  >
                    {simulating ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Running...
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-background" />
                        Simulate Webhook
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Simulation Result Panel */}
              <div className="lg:col-span-2 border border-foreground/10 p-4 bg-background/50 rounded-sm">
                <span className="text-[10px] font-mono tracking-[0.15em] text-foreground/40 uppercase block mb-2">
                  Simulation Logs & Response
                </span>
                {simResult ? (
                  <div className="space-y-3 text-xs font-mono leading-relaxed">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground/40">Status:</span>
                      <span className={simResult.success ? 'text-green-400' : 'text-red-400'}>
                        {simResult.success ? `SUCCESS (${simResult.status})` : 'FAILED'}
                      </span>
                    </div>

                    {simResult.signatureHeader && (
                      <div>
                        <span className="text-foreground/40 block mb-1">Generated x-webhook-signature:</span>
                        <div className="p-2 bg-foreground/[0.03] text-[10px] rounded-sm text-foreground/60 overflow-x-auto select-all break-all">
                          {simResult.signatureHeader}
                        </div>
                      </div>
                    )}

                    {simResult.payload && (
                      <div>
                        <span className="text-foreground/40 block mb-1">Signed JSON Payload:</span>
                        <pre className="p-2 bg-foreground/[0.03] text-[10px] rounded-sm text-foreground/50 overflow-x-auto max-h-24">
                          {JSON.stringify(simResult.payload, null, 2)}
                        </pre>
                      </div>
                    )}

                    {simResult.response && (
                      <div>
                        <span className="text-foreground/40 block mb-1">Endpoint API Response:</span>
                        <pre className="p-2 bg-foreground/[0.03] text-[10px] rounded-sm text-foreground/70 overflow-x-auto max-h-24">
                          {JSON.stringify(simResult.response, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center py-6 text-center text-foreground/30">
                    <HelpCircle className="w-8 h-8 mb-2 opacity-50" />
                    <p className="text-xs">No simulation run yet. Select an intent and click Simulate above.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 md:px-16 lg:px-24 py-4 pb-8">
          {loading ? (
            <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 bg-card border border-foreground/5 animate-pulse" />)}</div>
          ) : (
            <div className="space-y-2">
              <h2 className="text-sm font-mono tracking-[0.15em] text-foreground/40 uppercase mb-3">
                Received Webhook Logs History
              </h2>
              {safeLogs.map((log, i) => (
                <motion.div key={log.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} className="bg-card border border-foreground/10 rounded-sm">
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
