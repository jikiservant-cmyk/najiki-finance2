import { db } from './db'
import { getPaymentProvider } from './providers'
import { decrypt } from './encryption'
import { PLATFORM_FEE_TYPES } from './constants'

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
    const isPlatformPayment = payment?.paymentType && PLATFORM_FEE_TYPES.includes(payment.paymentType.code.toUpperCase())

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
    const isNetworkAmbiguous = err?.name === 'AbortError' || err?.code === 'ECONNRESET'
      || err?.code === 'ETIMEDOUT' || err?.name === 'TimeoutError' || err?.message?.includes('fetch failed')

    await db.$transaction([
      db.paymentIntent.update({
        where: { id: paymentIntentId },
        data: {
          // Ambiguous: leave it reconcilable (processing), do NOT mark failed!
          status: isNetworkAmbiguous ? 'processing' : 'failed',
          failureReason: isNetworkAmbiguous ? `INITIATE_AMBIGUOUS: ${err.message}` : err.message,
        },
      }),
      db.paymentTransaction.create({
        data: {
          paymentIntentId,
          status: isNetworkAmbiguous ? 'initiate_ambiguous' : 'initiate_failed',
          rawProviderResponse: JSON.stringify({ error: err.message, name: err?.name, code: err?.code }),
          note: 'PAYMENT_INITIATE_ERROR',
        },
      }),
    ]).catch(console.error)
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
    const isPlatformPayment = fullPaymentIntent.paymentType && PLATFORM_FEE_TYPES.includes(fullPaymentIntent.paymentType.code.toUpperCase())

    // P0-4 & Phase 1a: Atomic wallet balance credit and immutable ledger entry using Prisma public models
    if (status === 'success' && fullPaymentIntent.tenant && !isPlatformPayment) {
      const appCode = fullPaymentIntent.application.code.toLowerCase()
      const tenantId = fullPaymentIntent.tenant.id
      const amountMinor = BigInt(Math.round(amount * 100))

      const existingWallet = await tx.walletAccount.findUnique({
        where: {
          tenantId_appCode_currency: {
            tenantId,
            appCode,
            currency,
          },
        },
      })

      let walletId: string
      let balanceAfterMinor: bigint

      if (!existingWallet) {
        const created = await tx.walletAccount.create({
          data: {
            tenantId,
            appCode,
            currency,
            balanceMinor: amountMinor,
            version: 1,
          },
        })
        walletId = created.id
        balanceAfterMinor = created.balanceMinor
      } else {
        const updated = await tx.walletAccount.update({
          where: { id: existingWallet.id, version: existingWallet.version },
          data: {
            balanceMinor: { increment: amountMinor },
            version: { increment: 1 },
          },
        })
        walletId = updated.id
        balanceAfterMinor = updated.balanceMinor
      }

      // Record immutable ledger entry with idempotency key
      const idempotencyKey = `${paymentIntentId}:payment_in`
      await tx.ledgerEntry.upsert({
        where: { idempotencyKey },
        create: {
          walletId,
          paymentIntentId,
          direction: 'credit',
          amountMinor,
          currency,
          entryType: 'payment_in',
          idempotencyKey,
          balanceAfterMinor,
        },
        update: {},
      })
    }

    // P0-7: Write outbound notification ledger record in the transaction
    if (status === 'success' || status === 'failed') {
      const webhookUrl = `${fullPaymentIntent.application.baseUrl}${fullPaymentIntent.application.webhookPath}`
      const notificationPayload = {
        paymentIntentId,
        reference: fullPaymentIntent.reference,
        status,
        amount: Number(amount),
        currency,
        providerPaymentId: providerPaymentId || '',
        failureReason: failureReason || null,
        externalEntityId: fullPaymentIntent.externalEntityId,
        metadata: (() => { try { return fullPaymentIntent.metadata ? JSON.parse(fullPaymentIntent.metadata) : {}; } catch { return {}; } })(),
      }

      await tx.internalNotification.create({
        data: {
          paymentIntentId,
          applicationId: fullPaymentIntent.applicationId,
          url: webhookUrl,
          payload: JSON.stringify(notificationPayload),
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 5,
          nextRetryAt: new Date(),
        },
      })
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
import { safeFetch, validateSafeUrl } from './safe-fetch'

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
  // P1-4: Reject SSRF / private targets before enqueuing or delivering
  try {
    await validateSafeUrl(data.webhookUrl)
  } catch (urlErr: any) {
    console.error(`[Webhook] Refusing to send webhook to unsafe/internal URL: ${data.webhookUrl} (${urlErr?.message})`)
    await db.internalNotification.updateMany({
      where: { paymentIntentId: data.paymentIntentId, status: 'pending' },
      data: {
        status: 'failed',
        lastAttemptAt: new Date(),
        lastResponseBody: `Unsafe webhook URL: ${urlErr?.message}`,
      },
    })
    return
  }

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

  // P1-5: Replay protection with timestamped signature
  if (data.apiKey) {
    const timestamp = Date.now()
    const signature = createHmac('sha256', data.apiKey)
      .update(`${timestamp}.${payloadString}`)
      .digest('hex')
    headers['X-Najiki-Timestamp'] = String(timestamp)
    headers['X-Najiki-Signature'] = `t=${timestamp},v=${signature}`
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
      await db.internalNotification.updateMany({
        where: { paymentIntentId: data.paymentIntentId, status: 'pending' },
        data: {
          status: 'delivered',
          lastAttemptAt: new Date(),
          lastResponseStatus: 200,
        },
      })
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
      signal: AbortSignal.timeout(10_000),
    })
    console.log(`[Webhook] Direct delivery response status: ${res.status}`)
    if (res.ok) {
      await db.internalNotification.updateMany({
        where: { paymentIntentId: data.paymentIntentId, status: 'pending' },
        data: {
          status: 'delivered',
          lastAttemptAt: new Date(),
          lastResponseStatus: res.status,
        },
      })
    } else {
      await db.internalNotification.updateMany({
        where: { paymentIntentId: data.paymentIntentId, status: 'pending' },
        data: {
          status: 'failed',
          lastAttemptAt: new Date(),
          lastResponseStatus: res.status,
          lastResponseBody: `HTTP ${res.status}`,
        },
      })
    }
  } catch (directErr: any) {
    console.error('[Webhook] Direct safeFetch delivery error:', directErr)
    await db.internalNotification.updateMany({
      where: { paymentIntentId: data.paymentIntentId, status: 'pending' },
      data: {
        status: 'failed',
        lastAttemptAt: new Date(),
        lastResponseBody: directErr instanceof Error ? directErr.message : 'Unknown direct delivery error',
      },
    })
  }
}