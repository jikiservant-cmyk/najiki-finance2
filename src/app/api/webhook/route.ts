// src/app/api/webhook/route.ts — legacy flat webhook endpoint
// (the provider-specific handler lives at /api/webhooks/[provider]/route.ts)
//
// FIX 1: Remove getPaymentsWithApps() — it loaded the ENTIRE table then did
//         .find() in JS. Replaced with getPaymentByReference() — O(1) @unique index.
// FIX 2: Wrap all writes in db.$transaction() — previously 4 separate writes
//         with no atomicity. A failure mid-way left orphaned state.
// FIX 3: Wire up the InternalNotification queue instead of the commented-out
//         direct fetch (which would have blocked the response and caused timeouts).
// FIX 4: Normalize status to lowercase to match the rest of the system.
// FIX 5: Pass signatureHash to createWebhookLog (required after schema migration).

import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import {
  getPaymentByReference,
  createWebhookLog,
  updateWebhookLog,
} from '@/lib/data'

export async function POST(request: Request) {
  try {
    const rawBody = await request.text()
    const body = JSON.parse(rawBody)
    const signature = request.headers.get('x-webhook-signature') || ''

    // Idempotency hash — same delivery from LivePay = same hash = skip duplicate
    const signatureHash = createHash('sha256')
      .update(`legacy:${signature}:${rawBody}`)
      .digest('hex')

    const existing = await db.webhookLog.findUnique({ where: { signatureHash } })
    if (existing?.processed) {
      return NextResponse.json({ success: true, duplicate: true })
    }

    const webhookLog = await createWebhookLog({
      provider: body.provider || 'livepay',
      eventType: body.eventType || 'PAYMENT_COMPLETED',
      payload: rawBody,
      signature,
      signatureHash,
      verified: true, // this endpoint trusts the payload; add HMAC check if LivePay supports it
      processed: false,
    })

    const reference = body.reference || body.merchant_reference
    if (!reference) {
      await updateWebhookLog(webhookLog.id, { error: 'Missing reference', processed: true })
      return NextResponse.json({ error: 'Missing reference' }, { status: 400 })
    }

    // FIX 1: O(1) lookup on @unique index — replaces getPaymentsWithApps() + .find()
    const payment = await getPaymentByReference(reference)

    if (!payment) {
      await updateWebhookLog(webhookLog.id, { error: 'Payment not found', processed: true })
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    // FIX 4: lowercase to match status values used everywhere else in the system
    const rawStatus = (body.status || '').toUpperCase()
    const newStatus =
      rawStatus === 'SUCCESS' ? 'success' :
      rawStatus === 'FAILED'  ? 'failed'  : 'pending'

    // FIX 2: All writes in one transaction — atomically updates payment,
    // appends audit log, queues notification, and marks webhook processed.
    await db.$transaction(async (tx) => {
      // Update payment intent
      await tx.paymentIntent.update({
        where: { id: payment.id },
        data: {
          status: newStatus,
          ...(body.provider_reference && { providerPaymentId: body.provider_reference }),
          ...(newStatus === 'success' || newStatus === 'failed'
            ? { completedAt: new Date() }
            : {}),
        },
      })

      // Append to audit log
      await tx.paymentTransaction.create({
        data: {
          paymentIntentId: payment.id,
          status: newStatus,
          rawProviderResponse: rawBody,
          note: 'LEGACY_WEBHOOK_UPDATE',
        },
      })

      // FIX 3: Queue InternalNotification instead of the commented-out direct fetch.
      // The cron worker at /api/cron/notifications drains this queue with retry + backoff.
      if (newStatus === 'success' || newStatus === 'failed') {
        await tx.internalNotification.create({
          data: {
            paymentIntentId: payment.id,
            applicationId: payment.applicationId,
            url: `${payment.application.baseUrl}${payment.application.webhookPath}`,
            payload: JSON.stringify({
              paymentIntentId: payment.id,
              reference: payment.reference,
              status: newStatus,
              amount: body.amount ?? payment.amount,
              currency: payment.currency,
              providerPaymentId: body.provider_reference ?? null,
            }),
            status: 'pending',
            attemptCount: 0,
            maxAttempts: 5,
            nextRetryAt: new Date(),
          },
        })
      }

      // Mark webhook processed inside the transaction
      await tx.webhookLog.update({
        where: { id: webhookLog.id },
        data: { paymentIntentId: payment.id, processed: true },
      })
    })

    return NextResponse.json({
      success: true,
      paymentId: payment.id,
      status: newStatus,
    })
  } catch (error) {
    console.error('Legacy webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
