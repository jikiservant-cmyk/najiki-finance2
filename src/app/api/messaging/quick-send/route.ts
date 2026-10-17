import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { smsStore, SMS_COST_PLACEHOLDER, SmsDailyLimitError, SmsIdempotencyConflictError } from '@/lib/sms-store'
import { smsQueue } from '@/lib/sms-queue'
import { requireSuperAdmin } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { SmsInputSchema, MAX_SMS_BODY_BYTES, resolveSmsDailyLimit } from '@/lib/sms-policy'
import { readTextWithLimit, PayloadTooLargeError } from '@/lib/request-body'

export async function POST(request: Request) {
  try {
    // 1. Enforce dashboard session authentication.
    //
    // SECURITY: this previously used requireAuth(), so ANY authenticated
    // Supabase user (including tenant end-users) could send SMS billed to the
    // platform. Sending from the dashboard is now super-admin only.
    try {
      await requireSuperAdmin()
    } catch (authErr) {
      const message = authErr instanceof Error ? authErr.message : 'Unauthorized'
      if (message.includes('Forbidden')) {
        return NextResponse.json({ error: 'Forbidden: Super Admin required' }, { status: 403 })
      }
      return NextResponse.json({ error: 'Unauthorized: Log in to use dashboard quick send' }, { status: 401 })
    }

    const contentType = request.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      return NextResponse.json({ error: 'Unsupported media type' }, { status: 415 })
    }

    // Dashboard quick-send spends platform SMS credit on one click — cap it.
    const decision = await checkRateLimit('quick-send', 'dashboard', { tokens: 30, window: '1 m' })
    if (!decision.ok) {
      return NextResponse.json(
        { error: decision.message },
        { status: decision.status, headers: decision.retryAfter ? { 'Retry-After': decision.retryAfter } : {} }
      )
    }

    const parsed = SmsInputSchema.safeParse(JSON.parse(await readTextWithLimit(request, MAX_SMS_BODY_BYTES)))
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      return NextResponse.json({ error: 'Validation failed', details }, { status: 400 })
    }
    const { to, message, applicationCode } = parsed.data
    const key = request.headers.get('Idempotency-Key')?.trim() || parsed.data.idempotencyKey
    if (key && (key.length < 8 || key.length > 255)) {
      return NextResponse.json({ error: 'Invalid idempotency key' }, { status: 400 })
    }

    // 2. Resolve target application
    const appCode = applicationCode || 'church'
    const application = await db.application.findFirst({ where: { code: appCode, isActive: true } })
    if (!application) return NextResponse.json({ error: 'Active application not found' }, { status: 404 })

    // Apply the same atomic application ceiling as partner requests. Admin
    // quick-sends do not debit purchased credits (partners own those ledgers).
    const { sms: smsRequest, created } = await smsStore.createOrGet({
      recipient: to, message, applicationCode: application.code,
      providerCode: 'africastalking', cost: SMS_COST_PLACEHOLDER,
      applicationId: application.id, idempotencyKey: key,
      dailyLimit: resolveSmsDailyLimit(process.env.SMS_DAILY_LIMIT_PER_APP),
    })

    // 4. Enqueue for background execution
    if (created) await smsQueue.enqueue(smsRequest.id)

    // Trigger worker asynchronously using Next.js 15 'after' API if available in request context
    if (created) {
      try {
        after(() => {
          smsQueue.processBatch(5).catch(() => console.error('Background SMS worker failed'))
        })
      } catch {
        // Cron sweeps the durable DB outbox if after() is unavailable.
      }
    }

    return NextResponse.json({
      success: true,
      message: 'SMS send job queued successfully',
      smsId: smsRequest.id,
      reference: smsRequest.reference,
      status: smsRequest.status,
    }, { status: 202 })
  } catch (error) {
    if (error instanceof SmsDailyLimitError) return NextResponse.json(
      { error: error.message }, { status: 429, headers: { 'Retry-After': String(error.retryAfter) } }
    )
    if (error instanceof SmsIdempotencyConflictError) return NextResponse.json({ error: error.message }, { status: 409 })
    if (error instanceof PayloadTooLargeError) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    console.error('Quick send API failed (details omitted)')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
