'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'

export function SendSmsForm() {
  const [to, setTo] = useState('')
  const [message, setMessage] = useState('')
  const [applicationCode, setApplicationCode] = useState('church')
  const [isLoading, setIsLoading] = useState(false)
  const [lastSent, setLastSent] = useState<{ reference: string; status: string } | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!to || !message) {
      toast.error('Phone number and message are required')
      return
    }

    setIsLoading(true)
    setLastSent(null)

    try {
      const response = await fetch('/api/messaging/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, message, applicationCode })
      })

      const data = await response.json()

      if (response.ok) {
        toast.success(`Message queued (${data.reference})`)
        setLastSent({ reference: data.reference, status: data.status || 'queued' })
        setTo('')
        setMessage('')
      } else {
        toast.error(data.error || 'Failed to send message')
      }
    } catch (error) {
      toast.error('An error occurred while sending the message')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }} 
      animate={{ opacity: 1, y: 0 }} 
      transition={{ delay: 3.5 }} 
      className="stat-card p-4 md:p-6 bg-card border border-border/50 rounded-xl lg:col-span-2"
    >
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase">Quick Send (Africa&apos;s Talking)</span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Active Provider</span>
      </div>
      
      <form onSubmit={handleSubmit} className="space-y-4 max-w-xl">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="app" className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Application</label>
            <select
              id="app"
              value={applicationCode}
              onChange={(e) => setApplicationCode(e.target.value)}
              className="w-full bg-background border border-border/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary/50 transition-colors"
            >
              <option value="church">Church App (church)</option>
              <option value="school">School Platform (school)</option>
              <option value="KUNITY">SACCO Platform (KUNITY)</option>
              <option value="hospital">Hospital Platform (hospital)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="to" className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Recipient Phone Number</label>
            <input
              id="to"
              type="tel"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="+2567... or 07..."
              className="w-full bg-background border border-border/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary/50 transition-colors"
              required
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="message" className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Message Content</label>
          <textarea
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Enter your message..."
            rows={3}
            className="w-full bg-background border border-border/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary/50 transition-colors resize-none"
            required
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={isLoading}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {isLoading ? (
              <>
                <span className="w-3 h-3 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                Sending...
              </>
            ) : (
              'Send Message'
            )}
          </button>

          {lastSent && (
            <span className="text-xs font-mono text-emerald-400">
              Queued: {lastSent.reference}
            </span>
          )}
        </div>
      </form>
    </motion.div>
  )
}
