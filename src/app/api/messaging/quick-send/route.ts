import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { smsStore } from '@/lib/sms-store'
import { smsQueue } from '@/lib/sms-queue'
import { requireAuth } from '@/lib/auth'

export async function POST(request: Request) {
  try {
    // 1. Enforce dashboard session authentication
    try {
      await requireAuth()
    } catch {
      return NextResponse.json({ error: 'Unauthorized: Log in to use dashboard quick send' }, { status: 401 })
    }

    const { to, message, applicationCode } = await request.json()

    if (!to || !message) {
      return NextResponse.json({ error: 'Recipient (to) and message content are required' }, { status: 400 })
    }

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
      cost: 50,
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
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 })
  }
}
