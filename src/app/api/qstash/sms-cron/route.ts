import { NextResponse } from 'next/server'
import { smsQueue, retrySmsNotifications } from '@/lib/sms-queue'
import { smsStore } from '@/lib/sms-store'
import { verifyCronRequest } from '@/lib/qstash-verify'

// Optional: allow function to run longer on Vercel
export const maxDuration = 60

async function handleSmsCron(request: Request) {
  try {
    const isAuthorized = await verifyCronRequest(request)
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Process up to 20 SMS messages in one batch
    const results = await smsQueue.processBatch(20)
    const staleMarkedUnknown = await smsStore.markStalePendingUnknown()
    const notificationsDelivered = await retrySmsNotifications()
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      processedCount: results.length,
      staleMarkedUnknown,
      notificationsDelivered,
      results,
    })
  } catch (error: any) {
    console.error('SMS cron failed (details omitted)')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Vercel Cron issues GET requests; QStash and manual triggers use POST.
export async function GET(request: Request) {
  return handleSmsCron(request)
}

export async function POST(request: Request) {
  return handleSmsCron(request)
}
