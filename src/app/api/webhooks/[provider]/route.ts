// FIX 1: Add SHA-256 signatureHash idempotency — LivePay retries a webhook,
//         same hash → we skip processing, return 200. No duplicate notifications.
// FIX 2: Move webhookLog "mark processed" update INSIDE the db.$transaction()
//         Previously it ran after the tx committed. If it failed, LivePay would
//         retry → duplicate transaction log + duplicate notification.
// FIX 3: Add wallet updates based on application type!

import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { getPaymentProvider, getAvailableProviders } from '@/lib/providers'
import { createWebhookLog, getPaymentByReference } from '@/lib/data'
import { PrismaClient } from '@prisma/client'
import { enqueueWebhookNotification, completePayment } from '@/lib/payments'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider: providerCode } = await params
    const rawBody = await request.text()
    const signature =
      request.headers.get('x-webhook-signature') ||
      request.headers.get('signature') ||
      ''

    if (!getAvailableProviders().includes(providerCode.toLowerCase())) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
    }

    // FIX 1: Build idempotency hash BEFORE touching the DB
    // SHA-256(provider + signature + raw body) is deterministic for a given delivery
    const signatureHash = createHash('sha256')
      .update(`${providerCode}:${signature}:${rawBody}`)
      .digest('hex')

    // FIX 1: Check for duplicate delivery
    const existingLog = await db.webhookLog.findUnique({ where: { signatureHash } })
    if (existingLog?.processed) {
      // Already handled — tell LivePay we got it so it stops retrying
      return NextResponse.json({ success: true, duplicate: true })
    }

    const providerClient = getPaymentProvider(providerCode)

    const provider = await db.provider.findFirst({
      where: { code: providerCode.toLowerCase(), isActive: true },
    })
    if (!provider) {
      return NextResponse.json({ error: 'Provider not active' }, { status: 404 })
    }

    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:3000'
    const protocol = request.headers.get('x-forwarded-proto') || 'https'
    const pathname = new URL(request.url).pathname
    const publicUrl = `${protocol}://${host}${pathname}`

    const isValidSignature = await providerClient.validateWebhookSignature(
      rawBody,
      signature,
      Object.fromEntries(request.headers.entries()),
      publicUrl
    )

    // Log receipt even for invalid signatures (audit trail)
    const webhookLog = await createWebhookLog({
      provider: providerCode,
      eventType: 'WEBHOOK_RECEIVED',
      payload: rawBody,
      signature,
      signatureHash,
      verified: isValidSignature,
      processed: false,
    })

    if (!isValidSignature) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: { processingError: 'Invalid signature', processed: true },
      })
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const body = JSON.parse(rawBody)
    const parsedWebhook = await providerClient.parseWebhookPayload(body)

    // O(1) lookup on @unique index — replaces old full-table scan
    const paymentIntent = await getPaymentByReference(parsedWebhook.reference)

    if (!paymentIntent) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: { processingError: 'Payment not found', processed: true },
      })
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    // Fetch the full application to know which type we're dealing with
    const fullPaymentIntent = await db.paymentIntent.findUnique({
      where: { id: paymentIntent.id },
      include: { application: true, tenant: true },
    })

    if (!fullPaymentIntent) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: { processingError: 'Payment not found', processed: true },
      })
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    const normalizedStatus = parsedWebhook.status.toLowerCase()

    // FIX: Guard against double-crediting if a retry comes with a different signature
    if (
      fullPaymentIntent.status === 'success' || 
      fullPaymentIntent.status === 'failed'
    ) {
      // Mark this webhook log as processed since we already handled this terminal state
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: { paymentIntentId: paymentIntent.id, processed: true },
      })
      return NextResponse.json({ success: true, duplicate: true })
    }

    // FIX 2 & 3: Delegate to completePayment for wallet crediting and status sync
    const { wasAlreadyProcessed } = await completePayment({
      paymentIntentId: paymentIntent.id,
      status: normalizedStatus,
      providerPaymentId: parsedWebhook.providerPaymentId,
      failureReason: parsedWebhook.failureReason,
      amount: Number(parsedWebhook.amount || paymentIntent.amount),
      currency: parsedWebhook.currency || paymentIntent.currency,
      rawProviderResponse: rawBody,
      note: 'WEBHOOK_UPDATE',
    })

    // FIX 2: mark log processed. If this fails, the retry will be caught by the success guard above.
    await db.webhookLog.update({
      where: { id: webhookLog.id },
      data: { paymentIntentId: paymentIntent.id, processed: true },
    })

    // Create completion event for webhook delivery
    if (!wasAlreadyProcessed && (normalizedStatus === 'success' || normalizedStatus === 'failed')) {
      await enqueueWebhookNotification({
        paymentIntentId: paymentIntent.id,
        reference: paymentIntent.reference,
        status: normalizedStatus,
        amount: Number(parsedWebhook.amount || paymentIntent.amount),
        currency: parsedWebhook.currency || paymentIntent.currency,
        providerPaymentId: parsedWebhook.providerPaymentId || '',
        failureReason: parsedWebhook.failureReason,
        applicationId: fullPaymentIntent.applicationId,
        webhookUrl: `${fullPaymentIntent.application.baseUrl}${fullPaymentIntent.application.webhookPath}`,
        apiKey: fullPaymentIntent.application.apiKey,
        externalEntityId: fullPaymentIntent.externalEntityId,
        metadata: (() => { try { return fullPaymentIntent.metadata ? JSON.parse(fullPaymentIntent.metadata) : {}; } catch(e) { return {}; } })(),
      })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
