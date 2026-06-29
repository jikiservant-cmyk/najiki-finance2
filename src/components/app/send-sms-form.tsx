'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'

export function SendSmsForm() {
  const [to, setTo] = useState('')
  const [message, setMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!to || !message) {
      toast.error('Phone number and message are required')
      return
    }

    setIsLoading(true)

    try {
      const response = await fetch('/api/messaging/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, message })
      })

      const data = await response.json()

      if (response.ok) {
        toast.success('Message sent successfully')
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
      <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground uppercase block mb-4">Quick Send (Africa's Talking)</span>
      
      <form onSubmit={handleSubmit} className="space-y-4 max-w-xl">
        <div className="space-y-1.5">
          <label htmlFor="to" className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Recipient Phone Number (e.g., +256770000000)</label>
          <input
            id="to"
            type="tel"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="+256..."
            className="w-full bg-background border border-border/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary/50 transition-colors"
            required
          />
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
      </form>
    </motion.div>
  )
}
