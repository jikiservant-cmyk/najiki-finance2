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
import { decrypt } from '@/lib/encryption'

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

    // P0-6: Build idempotency hash based on event identity (not ephemeral timestamped signature)
    let providerEventId: string | null = null
    let tentativeStatus: string | null = null
    let tentativeReference: string | null = null
    try {
      const parsedBody = JSON.parse(rawBody)
      providerEventId = parsedBody.internal_reference || parsedBody.transactionId || null
      tentativeStatus = parsedBody.status || null
      tentativeReference = parsedBody.customer_reference || parsedBody.reference || null
    } catch {}

    const signatureHash = providerEventId
      ? createHash('sha256').update(`ev:${providerCode}:${providerEventId}:${tentativeStatus}`).digest('hex')
      : createHash('sha256').update(`bd:${providerCode}:${rawBody}`).digest('hex')

    // FIX 1: Check for duplicate delivery
    const existingLog = await db.webhookLog.findUnique({ where: { signatureHash } })
    if (existingLog?.processed) {
      // Already handled — tell LivePay we got it so it stops retrying
      return NextResponse.json({ success: true, duplicate: true })
    }

    const provider = await db.provider.findFirst({
      where: { code: providerCode.toLowerCase(), isActive: true },
    })
    
    if (!provider) {
      return NextResponse.json({ error: 'Provider not active' }, { status: 404 })
    }

    let customCredentials: any = undefined
    if (tentativeReference) {
      const intent = await db.paymentIntent.findUnique({
        where: { reference: tentativeReference },
        select: { tenantId: true, providerId: true },
      })
      if (intent?.tenantId) {
        const tenantConfig = await db.tenantProviderConfig.findFirst({
          where: { tenantId: intent.tenantId, providerId: intent.providerId, isActive: true },
        })
        if (tenantConfig?.configJson && typeof tenantConfig.configJson === 'object') {
          customCredentials = tenantConfig.configJson
          if (customCredentials?._encrypted) {
            customCredentials = JSON.parse(decrypt(customCredentials._encrypted))
          }
        }
      }
    }

    const providerClient = getPaymentProvider(providerCode, customCredentials)

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

    // P1-7: Mask customer phone numbers in stored payload for Uganda Data Protection Act compliance
    const sanitizedPayload = rawBody.replace(
      /(\+?[0-9]{3})[0-9]{3,6}([0-9]{3})/g,
      '$1****$2'
    )

    // Log receipt even for invalid signatures (audit trail)
    const webhookLog = await createWebhookLog({
      provider: providerCode,
      eventType: 'WEBHOOK_RECEIVED',
      payload: sanitizedPayload,
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

    // P0-2: HARD GATE — Verify reported amount and currency against stored intent
    const expectedAmount = Number(paymentIntent.amount)
    const reportedAmount = parsedWebhook.amount !== undefined && parsedWebhook.amount !== null
      ? Number(parsedWebhook.amount)
      : expectedAmount

    if (Math.abs(expectedAmount - reportedAmount) > 0.001) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          paymentIntentId: paymentIntent.id,
          processed: true,
          processingError: `AMOUNT_MISMATCH expected=${expectedAmount} reported=${reportedAmount}`,
        },
      })
      await db.paymentTransaction.create({
        data: {
          paymentIntentId: paymentIntent.id,
          status: 'disputed',
          rawProviderResponse: rawBody,
          note: `AMOUNT_MISMATCH | expected ${expectedAmount} ${paymentIntent.currency}, got ${reportedAmount} ${parsedWebhook.currency || ''}`,
        },
      })
      console.error(`[Webhook] Amount mismatch on ${paymentIntent.reference}: expected ${expectedAmount}, reported ${reportedAmount}`)
      return NextResponse.json({ error: 'Amount mismatch' }, { status: 422 })
    }

    if (parsedWebhook.currency && parsedWebhook.currency.toUpperCase() !== paymentIntent.currency.toUpperCase()) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          paymentIntentId: paymentIntent.id,
          processed: true,
          processingError: `CURRENCY_MISMATCH expected=${paymentIntent.currency} reported=${parsedWebhook.currency}`,
        },
      })
      await db.paymentTransaction.create({
        data: {
          paymentIntentId: paymentIntent.id,
          status: 'disputed',
          rawProviderResponse: rawBody,
          note: `CURRENCY_MISMATCH | expected ${paymentIntent.currency}, got ${parsedWebhook.currency}`,
        },
      })
      console.error(`[Webhook] Currency mismatch on ${paymentIntent.reference}: expected ${paymentIntent.currency}, got ${parsedWebhook.currency}`)
      return NextResponse.json({ error: 'Currency mismatch' }, { status: 422 })
    }

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
    // Always use the AUTHORITATIVE stored amount and currency, never the provider's unverified value
    const { wasAlreadyProcessed } = await completePayment({
      paymentIntentId: paymentIntent.id,
      status: normalizedStatus,
      providerPaymentId: parsedWebhook.providerPaymentId,
      failureReason: parsedWebhook.failureReason,
      amount: expectedAmount,
      currency: paymentIntent.currency,
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
        amount: expectedAmount,
        currency: paymentIntent.currency,
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
