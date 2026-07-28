import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { db } from '@/lib/db'
import { smsStore } from '@/lib/sms-store'
import { smsQueue } from '@/lib/sms-queue'

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.json()
    const { to, message, applicationCode } = rawBody

    if (!to || !message) {
      return NextResponse.json({ error: 'Recipient (to) and message content are required' }, { status: 400 })
    }

    // Resolve application
    let application: any = null
    const authHeader = request.headers.get('Authorization')
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const apiKey = authHeader.slice(7)
      application = await db.application.findFirst({
        where: { apiKey, isActive: true },
      })
      if (!application) {
        return NextResponse.json({ error: 'Invalid or inactive application API key' }, { status: 401 })
      }
    } else {
      // Find application matching applicationCode, or fallback to first active
      if (applicationCode) {
        application = await db.application.findFirst({
          where: { code: applicationCode, isActive: true },
        })
      }
      if (!application) {
        application = await db.application.findFirst({
          where: { isActive: true },
        })
      }
    }

    const appCode = application?.code || 'najiki'
    const appId = application?.id || undefined

    // 1. Create the SMS request in our file-based store (no schema change!)
    const smsRequest = smsStore.create({
      recipient: to,
      message,
      applicationCode: appCode,
      providerCode: 'africastalking', // default provider
      cost: 50, // standard rate in UGX
      applicationId: appId,
    })

    // 2. Push to Redis queue for background execution
    await smsQueue.enqueue(smsRequest.id)

    // Trigger the worker asynchronously using Next.js 15 'after' API
    // so messages get processed without blocking the response
    if (process.env.NODE_ENV === 'development' || !process.env.CRON_SECRET) {
      after(() => {
        smsQueue.processBatch(5).catch(err => console.error('Background worker error:', err))
      })
    }

    // 3. Return 202 Accepted fast-path
    return NextResponse.json({
      success: true,
      message: 'SMS send job queued successfully',
      smsId: smsRequest.id,
      reference: smsRequest.reference,
      status: smsRequest.status,
    }, { status: 202 })

  } catch (error) {
    console.error('Send SMS API Error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 })
  }
}

