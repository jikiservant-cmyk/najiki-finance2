import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { db } from '@/lib/db'
import { smsStore } from '@/lib/sms-store'
import { smsQueue } from '@/lib/sms-queue'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// Use Upstash Redis for distributed rate limiting if configured
let ratelimit: Ratelimit | null = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = Redis.fromEnv()
    ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(60, '1 m'), // 60 SMS requests per minute per application
      analytics: true,
    })
  }
} catch (e) {
  console.warn('Failed to initialize rate limiter:', e)
}

export function OPTIONS(request: Request) {
  const origin = request.headers.get('origin') || '*'
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)
  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    return new NextResponse(null, { status: 403, headers: { 'Access-Control-Allow-Origin': 'null' } })
  }
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    'Vary': 'Origin',
  }

  // Only echo back an origin we actually allow (see /api/payments for details).
  if (allowedOrigins.length === 0) {
    headers['Access-Control-Allow-Origin'] = '*'
  } else if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return new NextResponse(null, { status: 204, headers })
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

    // 2. Authenticate against the registered applications
    if (apiKey) {
      try {
        application = await db.application.findFirst({
          where: { apiKey, isActive: true },
        })
      } catch (dbErr) {
        console.warn('[Messaging API] DB lookup by apiKey failed:', dbErr)
      }
    }

    if (!application) {
      return NextResponse.json({ error: 'Invalid or missing API key' }, { status: 401 })
    }
    
    if (applicationCode && application.code !== applicationCode) {
      return NextResponse.json({ error: 'Application code mismatch' }, { status: 403 })
    }

    if (ratelimit) {
      try {
        const ratelimitPromise = ratelimit.limit(`sms_${apiKey}`)
        const timeoutPromise = new Promise<{success: boolean}>((_, reject) => 
          setTimeout(() => reject(new Error('Rate limit timeout')), 1000)
        )
        const { success } = await Promise.race([ratelimitPromise, timeoutPromise])
        if (!success) {
          return NextResponse.json(
            { error: 'Too many requests' },
            { status: 429, headers: { 'Retry-After': '60' } }
          )
        }
      } catch (ratelimitError) {
        console.warn('Rate limiter failed or timed out:', ratelimitError)
        if (process.env.NODE_ENV === 'production') {
          return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 })
        }
      }
    }

    const appCode = application.code
    const appId = application.id
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
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

