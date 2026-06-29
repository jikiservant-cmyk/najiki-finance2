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

    const isValidSignature = await providerClient.validateWebhookSignature(
      rawBody,
      signature,
      Object.fromEntries(request.headers.entries())
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

    // FIX 2 & 3: ALL writes — including the webhookLog update AND wallet updates — are inside one transaction.
    await db.$transaction(async (tx) => {
      // Update payment intent
      await tx.paymentIntent.update({
        where: { id: paymentIntent.id },
        data: {
          status: normalizedStatus,
          ...(parsedWebhook.providerPaymentId && {
            providerPaymentId: parsedWebhook.providerPaymentId,
          }),
          ...(parsedWebhook.failureReason && {
            failureReason: parsedWebhook.failureReason,
          }),
          ...(normalizedStatus === 'success' || normalizedStatus === 'failed'
            ? { completedAt: new Date() }
            : {}),
        },
      })

      // Append to audit log
      await tx.paymentTransaction.create({
        data: {
          paymentIntentId: paymentIntent.id,
          status: normalizedStatus,
          rawProviderResponse: rawBody,
          note: 'WEBHOOK_UPDATE',
        },
      })

      // If payment was successful, update wallet based on application type!
      if (normalizedStatus === 'success' && fullPaymentIntent.tenant) {
        // Route wallet update based on application code!
        const appCode = fullPaymentIntent.application.code.toLowerCase()
        const amount = Number(parsedWebhook.amount || paymentIntent.amount)
        const tenantId = fullPaymentIntent.tenant.id

        if (appCode === 'church') {
          // For churches, tenant.id maps to church.churches.id,
          // update church.wallets in "church" schema!
          // First ensure the wallet exists (upsert)!
          await tx.$executeRaw`
            INSERT INTO "church"."wallets" ("church_id", "balance", "sms_credits", "created_at", "updated_at")
            VALUES (${tenantId}, ${amount}, 0, NOW(), NOW())
            ON CONFLICT ("church_id") DO UPDATE 
            SET "balance" = "church"."wallets"."balance" + ${amount}, "updated_at" = NOW()
          `
        } else if (appCode === 'sacco') {
          // For SACCOs, tenant.id maps to kuntiy.saccos.id,
          // update kuntiy.wallets in "kuntiy" schema!
          await tx.$executeRaw`
            INSERT INTO "kuntiy"."wallets" ("sacco_id", "balance", "created_at", "updated_at")
            VALUES (${tenantId}, ${amount}, NOW(), NOW())
            ON CONFLICT ("sacco_id") DO UPDATE 
            SET "balance" = "kuntiy"."wallets"."balance" + ${amount}, "updated_at" = NOW()
          `
        }
      }

      // Queue internal notification for terminal statuses
      if (normalizedStatus === 'success' || normalizedStatus === 'failed') {
        await tx.internalNotification.create({
          data: {
            paymentIntentId: paymentIntent.id,
            applicationId: fullPaymentIntent.applicationId,
            url: `${fullPaymentIntent.application.baseUrl}${fullPaymentIntent.application.webhookPath}`,
            payload: JSON.stringify({
              paymentIntentId: paymentIntent.id,
              reference: paymentIntent.reference,
              status: normalizedStatus,
              amount: parsedWebhook.amount || paymentIntent.amount,
              currency: parsedWebhook.currency || paymentIntent.currency,
              providerPaymentId: parsedWebhook.providerPaymentId,
              failureReason: parsedWebhook.failureReason,
            }),
            status: 'pending',
            attemptCount: 0,
            maxAttempts: 5,
            nextRetryAt: new Date(),
          },
        })
      }

      // FIX 2: mark log processed INSIDE the transaction
      await tx.webhookLog.update({
        where: { id: webhookLog.id },
        data: { paymentIntentId: paymentIntent.id, processed: true },
      })
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
