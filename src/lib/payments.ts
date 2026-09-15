import { db } from './db'
import { getPaymentProvider } from './providers'
import { decrypt } from './encryption'

export async function processPayment(data: {
  paymentIntentId: string,
  amount: number,
  currency: string,
  phoneNumber: string,
  reference: string,
  providerCode: string,
  description: string,
  metadata: any,
  webhookUrl: string
}) {
  const { paymentIntentId, amount, currency, phoneNumber, reference, providerCode, description, metadata, webhookUrl } = data

  try {
    // Check if there is an active tenant-specific config for this provider
    let customCredentials: any = undefined
    const payment = await db.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { application: true, paymentType: true },
    })

    // Define payment types that go to the platform (owner's main account)
    const platformFeeTypes = ['SMS', 'BUY_SMS', 'SMS_TOPUP', 'ACTIVATION', 'ACCOUNT_ACTIVATION', 'SUBSCRIPTION', 'MONTHLY_SUBSCRIPTION', 'PLATFORM_FEE']
    const isPlatformPayment = payment?.paymentType && platformFeeTypes.includes(payment.paymentType.code.toUpperCase())

    // Only load tenant credentials if it's NOT a platform payment. 
    // Platform payments use the default global credentials.
    if (payment?.tenantId && payment?.providerId && !isPlatformPayment) {
      const tenantConfig = await db.tenantProviderConfig.findFirst({
        where: {
          tenantId: payment.tenantId,
          providerId: payment.providerId,
          isActive: true,
        },
      })
      if (tenantConfig?.configJson && typeof tenantConfig.configJson === 'object') {
        customCredentials = tenantConfig.configJson
        if (customCredentials?._encrypted) {
          customCredentials = JSON.parse(decrypt(customCredentials._encrypted))
        }
      }
    }

    const providerClient = getPaymentProvider(providerCode, customCredentials)
    const providerResponse = await providerClient.initiatePayment({
      amount,
      currency,
      phoneNumber,
      reference,
      description,
      metadata,
      webhookUrl,
    })

    await db.$transaction([
      db.paymentIntent.update({
        where: { id: paymentIntentId },
        data: {
          status: providerResponse.status,
          providerPaymentId: providerResponse.providerPaymentId,
          failureReason: providerResponse.failureReason,
          completedAt: providerResponse.status === 'success' ? new Date() : null,
        },
      }),
      db.paymentTransaction.create({
        data: {
          paymentIntentId: paymentIntentId,
          status: providerResponse.status,
          rawProviderResponse: JSON.stringify(providerResponse),
          note: `PAYMENT_INITIATED | Webhook URL: ${webhookUrl}`,
        },
      }),
    ])

    if (providerResponse.status === 'success' || providerResponse.status === 'failed') {
      if (payment) {
        await enqueueWebhookNotification({
          paymentIntentId,
          reference,
          status: providerResponse.status,
          amount,
          currency,
          providerPaymentId: providerResponse.providerPaymentId || '',
          failureReason: providerResponse.failureReason,
          applicationId: payment.applicationId,
          webhookUrl: `${payment.application.baseUrl}${payment.application.webhookPath}`,
          apiKey: payment.application.apiKey,
          externalEntityId: payment.externalEntityId,
          metadata: payment.metadata ? JSON.parse(payment.metadata) : {},
        })
      }
    }
  } catch (err: any) {
    console.error(`processPayment error for ${paymentIntentId}:`, err)
    await db.paymentIntent.update({ where: { id: paymentIntentId }, data: { status: "failed", failureReason: err.message } }).catch(console.error)
  }
}

export async function completePayment(data: {
  paymentIntentId: string
  status: string
  providerPaymentId?: string | null
  failureReason?: string | null
  amount: number
  currency: string
  rawProviderResponse: string
  note?: string
}) {
  const { paymentIntentId, status, providerPaymentId, failureReason, amount, currency, rawProviderResponse, note } = data

  const fullPaymentIntent = await db.paymentIntent.findUnique({
    where: { id: paymentIntentId },
    include: { application: true, tenant: true, paymentType: true },
  })

  if (!fullPaymentIntent) throw new Error('Payment not found')
  
  if (fullPaymentIntent.status === 'success' || fullPaymentIntent.status === 'failed') {
    return { intent: fullPaymentIntent, wasAlreadyProcessed: true }
  }

  const result = await db.$transaction(async (tx) => {
    // ATOMIC UPDATE: only update if the current status is not success or failed
    const updateResult = await tx.paymentIntent.updateMany({
      where: { 
        id: paymentIntentId,
        status: { notIn: ['success', 'failed'] }
      },
      data: {
        status,
        ...(providerPaymentId && { providerPaymentId }),
        ...(failureReason && { failureReason }),
        ...(status === 'success' || status === 'failed' ? { completedAt: new Date() } : {}),
      },
    })

    if (updateResult.count === 0) {
      // Another process already updated it while we were waiting for the transaction
      return { updated: false }
    }

    // Append to audit log
    await tx.paymentTransaction.create({
      data: {
        paymentIntentId,
        status,
        rawProviderResponse,
        note: note || 'STATUS_UPDATE',
      },
    })

    // Define payment types that go to the platform (owner's main account)
    const platformFeeTypes = ['SMS', 'BUY_SMS', 'SMS_TOPUP', 'ACTIVATION', 'ACCOUNT_ACTIVATION', 'SUBSCRIPTION', 'MONTHLY_SUBSCRIPTION', 'PLATFORM_FEE']
    const isPlatformPayment = fullPaymentIntent.paymentType && platformFeeTypes.includes(fullPaymentIntent.paymentType.code.toUpperCase())

    // If payment was successful, update wallet based on application type!
    // We ONLY credit the tenant's actual wallet balance if it's NOT a platform payment (e.g. SAVINGS).
    if (status === 'success' && fullPaymentIntent.tenant && !isPlatformPayment) {
      const appCode = fullPaymentIntent.application.code.toLowerCase()
      const tenantId = fullPaymentIntent.tenant.id

      try {
        if (appCode === 'church') {
          await tx.$executeRaw`
            INSERT INTO "church"."wallets" ("church_id", "balance", "sms_credits", "created_at", "updated_at")
            VALUES (${tenantId}, ${amount}, 0, NOW(), NOW())
            ON CONFLICT ("church_id") DO UPDATE 
            SET "balance" = "church"."wallets"."balance" + ${amount}, "updated_at" = NOW()
          `
        } else if (appCode === 'sacco') {
          await tx.$executeRaw`
            INSERT INTO "kuntiy"."wallets" ("sacco_id", "balance", "created_at", "updated_at")
            VALUES (${tenantId}, ${amount}, NOW(), NOW())
            ON CONFLICT ("sacco_id") DO UPDATE 
            SET "balance" = "kuntiy"."wallets"."balance" + ${amount}, "updated_at" = NOW()
          `
        }
      } catch (err) {
        console.error(`Failed to credit wallet for tenant ${tenantId} in app ${appCode}:`, err)
        // We don't want the entire transaction to rollback just because wallet update failed
        // This should eventually be moved to an event-driven webhook architecture
      }
    }
    
    return { updated: true }
  })

  if (!result.updated) {
    // It was processed by another request concurrently
    return { intent: fullPaymentIntent, wasAlreadyProcessed: true }
  }
  
  const finalIntent = await db.paymentIntent.findUnique({
    where: { id: paymentIntentId },
    include: { application: true, tenant: true },
  })
  
  if (!finalIntent) throw new Error('Payment not found after update')
  
  return { intent: finalIntent, wasAlreadyProcessed: false }
}

import { Client } from '@upstash/qstash'
import { createHmac } from 'crypto'
import { safeFetch } from './safe-fetch'

let qstashClient: Client | null = null
function getQStashClient(): Client | null {
  const token = process.env.QSTASH_TOKEN
  if (!token) return null
  if (!qstashClient) {
    qstashClient = new Client({ token })
  }
  return qstashClient
}

export async function enqueueWebhookNotification(data: {
  paymentIntentId: string
  reference: string
  status: string
  amount: number
  currency: string
  providerPaymentId: string
  failureReason?: string | null
  applicationId: string
  webhookUrl: string
  apiKey: string | null
  externalEntityId?: string | null
  metadata: any
}) {
  const payloadObject = {
    paymentIntentId: data.paymentIntentId,
    reference: data.reference,
    status: data.status,
    amount: data.amount,
    currency: data.currency,
    providerPaymentId: data.providerPaymentId,
    failureReason: data.failureReason,
    externalEntityId: data.externalEntityId,
    metadata: data.metadata,
  }

  const payloadString = JSON.stringify(payloadObject)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Najiki-Notification': 'true',
  }

  if (data.apiKey) {
    const signature = createHmac('sha256', data.apiKey).update(payloadString).digest('hex')
    headers['X-Najiki-Signature'] = signature
    headers['Authorization'] = `Bearer ${data.apiKey}`
  }

  // 1. Primary path: Use Upstash QStash with 5 automatic retries and exponential backoff
  try {
    const client = getQStashClient()
    if (client) {
      await client.publishJSON({
        url: data.webhookUrl,
        body: payloadObject,
        headers,
        retries: 5, // QStash native retries with exponential backoff
      })
      console.log(`[QStash] Webhook successfully enqueued for ${data.webhookUrl}`)
      return
    } else {
      console.warn('[QStash] QSTASH_TOKEN not configured, using direct safeFetch fallback.')
    }
  } catch (err: any) {
    console.error('[QStash] Failed to enqueue webhook via QStash, falling back to direct dispatch:', err)
  }

  // 2. Resilient fallback: Direct delivery via safeFetch (with SSRF protection & placeholder prevention)
  try {
    console.log(`[Webhook] Delivering directly via safeFetch to ${data.webhookUrl}...`)
    const res = await safeFetch(data.webhookUrl, {
      method: 'POST',
      headers,
      body: payloadString,
    })
    console.log(`[Webhook] Direct delivery response status: ${res.status}`)
  } catch (directErr: any) {
    console.error('[Webhook] Direct safeFetch delivery error:', directErr)
  }
}