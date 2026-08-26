import { db } from './db'
import { getPaymentProvider } from './providers'

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
      include: { application: true },
    })

    if (payment?.tenantId && payment?.providerId) {
      const tenantConfig = await db.tenantProviderConfig.findFirst({
        where: {
          tenantId: payment.tenantId,
          providerId: payment.providerId,
          isActive: true,
        },
      })
      if (tenantConfig?.configJson && typeof tenantConfig.configJson === 'object') {
        customCredentials = tenantConfig.configJson
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
  }
}

import { Client } from '@upstash/qstash'
import { createHmac } from 'crypto'

const qstash = new Client({ token: process.env.QSTASH_TOKEN || 'fake-token' })

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

  try {
    await qstash.publishJSON({
      url: data.webhookUrl,
      body: payloadObject,
      headers,
      retries: 5, // QStash native retries with exponential backoff
    })
  } catch (err: any) {
    console.error('Failed to enqueue webhook via QStash:', err)
  }
}