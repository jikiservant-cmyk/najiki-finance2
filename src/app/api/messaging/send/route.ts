import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { db } from '@/lib/db'
import { smsStore } from '@/lib/sms-store'
import { smsQueue } from '@/lib/sms-queue'
import { checkRateLimit, clientIdentifier } from '@/lib/rate-limit'
import { findApplicationByApiKey } from '@/lib/application-auth'

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
    const ipDecision = await checkRateLimit('sms-ip', clientIdentifier(request), { tokens: 120, window: '1 m' })
    if (!ipDecision.ok) {
      return NextResponse.json(
        { error: ipDecision.message },
        { status: ipDecision.status, headers: ipDecision.retryAfter ? { 'Retry-After': ipDecision.retryAfter } : {} }
      )
    }

    const rawBody = await request.json()
    const { to, message, applicationCode, from, senderId, apiKey: bodyApiKey } = rawBody

    // Standard `Idempotency-Key` header, with the body field as a fallback for
    // clients that cannot set headers.
    const idempotencyKey = (
      request.headers.get('Idempotency-Key') ||
      request.headers.get('idempotency-key') ||
      rawBody.idempotencyKey ||
      ''
    ).toString().trim().slice(0, 255) || null

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

    // 2. Authenticate against the registered applications.
    // Hash-first, with a fallback to the legacy cleartext column — see
    // src/lib/application-auth.ts.
    if (apiKey) {
      try {
        const auth = await findApplicationByApiKey(apiKey)
        application = auth?.application ?? null
      } catch (dbErr) {
        console.warn('[Messaging API] DB lookup by API key failed:', dbErr)
      }
    }

    if (!application) {
      return NextResponse.json({ error: 'Invalid or missing API key' }, { status: 401 })
    }
    
    if (applicationCode && application.code !== applicationCode) {
      return NextResponse.json({ error: 'Application code mismatch' }, { status: 403 })
    }

    const keyDecision = await checkRateLimit('sms-key', apiKey, { tokens: 60, window: '1 m' })
    if (!keyDecision.ok) {
      return NextResponse.json(
        { error: keyDecision.message },
        { status: keyDecision.status, headers: keyDecision.retryAfter ? { 'Retry-After': keyDecision.retryAfter } : {} }
      )
    }

    const appCode = application.code
    const appId = application.id
    const customSender = from || senderId || undefined

    // 5. Create the message record, deduplicated on the caller's key if given.
    // A partner whose request times out cannot tell whether the SMS was sent,
    // so the sane retry is the same request again. Without this, every retry
    // is a second SMS and a second charge.
    const { sms: smsRequest, created } = await smsStore.createOrGet({
      recipient: to,
      message,
      applicationCode: appCode,
      providerCode: 'africastalking', // default provider
      cost: 50, // standard rate in UGX
      applicationId: appId,
      senderId: customSender,
      idempotencyKey,
    })

    // A reused record has already been queued and is on its way. Re-enqueuing
    // it would send the message a second time, which is the exact bug this
    // guards against.
    if (created) {
      // 6. Push to the queue for background execution
      await smsQueue.enqueue(smsRequest.id)

      // Trigger the worker asynchronously using Next.js 15 'after' API if available in request context
      try {
        after(() => {
          smsQueue.processBatch(5).catch(err => console.error('Background worker error:', err))
        })
      } catch {
        // Fallback: smsQueue.enqueue already triggered detached background batch processing
      }
    }

    // 7. Return 202 Accepted fast-path
    return NextResponse.json({
      success: true,
      message: created
        ? 'SMS send job queued successfully'
        : 'Duplicate request — the original SMS job was returned',
      smsId: smsRequest.id,
      reference: smsRequest.reference,
      status: smsRequest.status,
      deduplicated: !created,
      // Relative to when the ORIGINAL request was accepted, not this one.
      createdAt: smsRequest.createdAt,
    }, { status: 202 })

  } catch (error) {
    console.error('Send SMS API Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

