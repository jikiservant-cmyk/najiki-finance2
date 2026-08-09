import { NextResponse } from 'next/server'
import { smsQueue } from '@/lib/sms-queue'

// Optional: allow function to run longer on Vercel
export const maxDuration = 60

export async function POST(request: Request) {
  try {
    // Process up to 20 SMS messages in one batch
    const results = await smsQueue.processBatch(20)
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      processedCount: results.length,
      results,
    })
  } catch (error: any) {
    console.error('SMS cron error:', error)
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
  }
}

// Support GET requests for Vercel Cron
export async function GET(request: Request) {
  return POST(request)
}
