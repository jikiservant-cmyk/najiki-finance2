import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { smsStore, SMS_COST_PLACEHOLDER } from '@/lib/sms-store'
import { smsQueue } from '@/lib/sms-queue'
import { requireSuperAdmin } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { z } from 'zod'

const QuickSendSchema = z.object({
  to: z.string().min(9).max(20),
  message: z.string().min(1).max(918),
  applicationCode: z.string().min(1).max(64).optional(),
})

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

    const parsed = QuickSendSchema.safeParse(await request.json())
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      return NextResponse.json({ error: 'Validation failed', details }, { status: 400 })
    }
    const { to, message, applicationCode } = parsed.data

    // 2. Resolve target application
    const appCode = applicationCode || 'church'
    let application: any = null
    try {
      application = await db.application.findFirst({
        where: { code: appCode, isActive: true },
      })
    } catch (dbErr) {
      console.warn('[Quick Send API] Application lookup failed, falling back:', dbErr)
    }

    // 3. Create SMS record in store
    const smsRequest = await smsStore.create({
      recipient: to,
      message,
      applicationCode: application?.code || appCode,
      providerCode: 'africastalking',
      // Placeholder until the provider reports the real charge; overwritten
      // by smsQueue via smsStore.updateProviderCost(). See SMS_COST_PLACEHOLDER.
      cost: SMS_COST_PLACEHOLDER,
      applicationId: application?.id,
    })

    // 4. Enqueue for background execution
    await smsQueue.enqueue(smsRequest.id)

    // Trigger worker asynchronously using Next.js 15 'after' API if available in request context
    try {
      after(() => {
        smsQueue.processBatch(5).catch(err => console.error('Background worker error:', err))
      })
    } catch {
      // Fallback: smsQueue.enqueue already triggered detached background batch processing
    }

    return NextResponse.json({
      success: true,
      message: 'SMS send job queued successfully',
      smsId: smsRequest.id,
      reference: smsRequest.reference,
      status: smsRequest.status,
    }, { status: 202 })
  } catch (error) {
    console.error('Quick send API Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
