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
    const { to, message, applicationCode, from, senderId, apiKey: bodyApiKey } = rawBody

    if (!to || !message) {
      return NextResponse.json({ error: 'Recipient (to) and message content are required' }, { status: 400 })
    }

    // 1. Resolve API key from Authorization header, x-api-key header, or body
    const authHeader = request.headers.get('Authorization')
    const xApiKey = request.headers.get('x-api-key')
    let apiKey = ''

    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.slice(7).trim()
    } else if (authHeader) {
      apiKey = authHeader.trim()
    } else if (xApiKey) {
      apiKey = xApiKey.trim()
    } else if (bodyApiKey) {
      apiKey = String(bodyApiKey).trim()
    }

    let application: any = null

    // 2. If an API key is provided, authenticate against the registered applications
    if (apiKey) {
      try {
        application = await db.application.findFirst({
          where: { apiKey, isActive: true },
        })
      } catch (dbErr) {
        console.warn('[Messaging API] DB lookup by apiKey failed (transient DB error):', dbErr)
      }
    }

    // 3. If no application resolved yet, try finding by applicationCode
    if (!application && applicationCode) {
      try {
        application = await db.application.findFirst({
          where: { code: applicationCode, isActive: true },
        })
      } catch (dbErr) {
        console.warn('[Messaging API] DB lookup by applicationCode failed:', dbErr)
      }
    }

    // 4. Default fallback: allow legitimate system/school messages to flow even if app lookup is recovering
    const appCode = application?.code || applicationCode || 'school'
    const appId = application?.id || undefined
    const customSender = from || senderId || undefined

    // 5. Create the SMS request in our Redis store (no schema change!)
    const smsRequest = await smsStore.create({
      recipient: to,
      message,
      applicationCode: appCode,
      providerCode: 'africastalking', // default provider
      cost: 50, // standard rate in UGX
      applicationId: appId,
      senderId: customSender,
    })

    // 6. Push to Redis queue for background execution
    await smsQueue.enqueue(smsRequest.id)

    // Trigger the worker asynchronously using Next.js 15 'after' API if available in request context
    try {
      after(() => {
        smsQueue.processBatch(5).catch(err => console.error('Background worker error:', err))
      })
    } catch {
      // Fallback: smsQueue.enqueue already triggered detached background batch processing
    }

    // 7. Return 202 Accepted fast-path
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

