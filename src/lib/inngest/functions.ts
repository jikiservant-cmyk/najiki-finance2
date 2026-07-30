import { inngest } from './client'
import { smsStore } from '../sms-store'
import { db } from '../db'
import { getPaymentProvider } from '../providers'
import { createHmac } from 'crypto'
import { sendSmsViaProvider } from '../sms'
import { safeFetch } from '../safe-fetch'

// 1. Send SMS background job
export const handleSmsSendRequested = inngest.createFunction(
  { 
    id: 'sms-send-requested', 
    name: 'Send SMS Background Job',
    triggers: [{ event: 'sms.send.requested' }]
  },
  async ({ event, step }) => {
    const { smsId, to, message } = event.data

    await step.run('set-pending', async () => {
      smsStore.updateStatus(smsId, 'pending')
    })

    const result = await step.run('send-sms', async () => {
      return await sendSmsViaProvider(to, message)
    })

    await step.run('set-delivered', async () => {
      smsStore.updateStatus(smsId, 'delivered')
    })

    return { success: true, providerId: result.providerId }
  }
)

// 2. Initiate Payment background job
export const handlePaymentRequested = inngest.createFunction(
  { 
    id: 'payment-requested', 
    name: 'Initiate Payment Background Job',
    triggers: [{ event: 'payment.requested' }]
  },
  async ({ event, step }) => {
    const { paymentIntentId, amount, currency, phoneNumber, reference, providerCode, description, metadata, webhookUrl } = event.data

    const providerResponse = await step.run('initiate-payment', async () => {
      const providerClient = getPaymentProvider(providerCode)
      return await providerClient.initiatePayment({
        amount,
        currency,
        phoneNumber,
        reference,
        description,
        metadata,
        webhookUrl,
      })
    })

    await step.run('update-db', async () => {
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
    })

    if (providerResponse.status === 'success' || providerResponse.status === 'failed') {
      await step.run('emit-completed', async () => {
        const payment = await db.paymentIntent.findUnique({
          where: { id: paymentIntentId },
          include: { application: true },
        })

        if (payment) {
          await inngest.send({
            name: 'payment.completed',
            data: {
              paymentIntentId,
              reference,
              status: providerResponse.status,
              amount,
              currency,
              providerPaymentId: providerResponse.providerPaymentId,
              failureReason: providerResponse.failureReason,
              applicationId: payment.applicationId,
              webhookUrl: `${payment.application.baseUrl}${payment.application.webhookPath}`,
              apiKey: payment.application.apiKey,
              externalEntityId: payment.externalEntityId,
              metadata: payment.metadata ? JSON.parse(payment.metadata) : {},
            }
          })
        }
      })
    } else {
      // Sleep for 30 seconds after transaction initiation to check status
      await step.sleep('wait-for-webhook', '30s')

      // Check if it was resolved by a webhook while sleeping
      const currentPayment = await step.run('check-current-status', async () => {
        return await db.paymentIntent.findUnique({ where: { id: paymentIntentId } })
      })

      if (currentPayment && currentPayment.status === 'pending') {
        // Still pending, poll the provider
        const pollResult = await step.run('poll-provider-status', async () => {
          const providerClient = getPaymentProvider(providerCode)
          if (providerClient.checkPaymentStatus) {
             return await providerClient.checkPaymentStatus(reference, currency, providerResponse.providerPaymentId)
          }
          return null
        })

        if (pollResult && (pollResult.status === 'success' || pollResult.status === 'failed')) {
          await step.run('update-db-and-emit', async () => {
             await db.$transaction([
               db.paymentIntent.update({
                 where: { id: paymentIntentId },
                 data: {
                   status: pollResult.status,
                   failureReason: pollResult.failureReason,
                   completedAt: pollResult.status === 'success' ? new Date() : null,
                 },
               }),
               db.paymentTransaction.create({
                 data: {
                   paymentIntentId: paymentIntentId,
                   status: pollResult.status,
                   rawProviderResponse: JSON.stringify(pollResult),
                   note: `POLLING_COMPLETED`,
                 },
               }),
             ])

             const payment = await db.paymentIntent.findUnique({
               where: { id: paymentIntentId },
               include: { application: true },
             })

             if (payment) {
               await inngest.send({
                 name: 'payment.completed',
                 data: {
                   paymentIntentId,
                   reference,
                   status: pollResult.status,
                   amount,
                   currency,
                   providerPaymentId: pollResult.providerPaymentId || providerResponse.providerPaymentId,
                   failureReason: pollResult.failureReason,
                   applicationId: payment.applicationId,
                   webhookUrl: `${payment.application.baseUrl}${payment.application.webhookPath}`,
                   apiKey: payment.application.apiKey,
                   externalEntityId: payment.externalEntityId,
                   metadata: payment.metadata ? JSON.parse(payment.metadata) : {},
                 }
               })
             }
          })
        }
      }
    }

    return { success: true, status: providerResponse.status }
  }
)

// 3. Webhook / Notification delivery background job with built-in retries
export const handlePaymentCompleted = inngest.createFunction(
  { 
    id: 'payment-completed', 
    name: 'Dispatch Webhook & Notifications',
    triggers: [{ event: 'payment.completed' }],
    retries: 5 
  },
  async ({ event, step }) => {
    const { 
      paymentIntentId, 
      reference, 
      status, 
      amount, 
      currency, 
      providerPaymentId, 
      failureReason, 
      applicationId, 
      webhookUrl, 
      apiKey,
      externalEntityId,
      metadata 
    } = event.data

    const payload = JSON.stringify({
      paymentIntentId,
      reference,
      status,
      amount,
      currency,
      providerPaymentId,
      failureReason,
      externalEntityId,
      metadata,
    })

    const notificationId = await step.run('create-notification-record', async () => {
      const existing = await db.internalNotification.findFirst({
        where: { paymentIntentId },
      })
      if (existing) return existing.id

      const notif = await db.internalNotification.create({
        data: {
          paymentIntentId,
          applicationId,
          url: webhookUrl,
          payload,
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 5,
          nextRetryAt: new Date(),
        }
      })
      return notif.id
    })

    try {
      await step.run('dispatch-webhook', async () => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Najiki-Notification': 'true',
        }
        if (apiKey) {
          headers['X-Najiki-Signature'] = createHmac('sha256', apiKey).update(payload).digest('hex')
          headers['Authorization'] = `Bearer ${apiKey}`
        }

        const response = await safeFetch(webhookUrl, {
          method: 'POST',
          headers,
          body: payload,
        })

        if (!response.ok) {
          throw new Error(`Webhook endpoint returned status ${response.status}`)
        }
      })

      await step.run('mark-delivered', async () => {
        const notif = await db.internalNotification.findUnique({ where: { id: notificationId } })
        await db.internalNotification.update({
          where: { id: notificationId },
          data: {
            status: 'delivered',
            attemptCount: (notif?.attemptCount || 0) + 1,
            lastAttemptAt: new Date(),
            lastResponseStatus: 200,
            nextRetryAt: null,
          }
        })
      })

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      
      await step.run('update-notification-fail', async () => {
        const notif = await db.internalNotification.findUnique({ where: { id: notificationId } })
        const newCount = (notif?.attemptCount || 0) + 1
        const maxReached = newCount >= 5
        
        await db.internalNotification.update({
          where: { id: notificationId },
          data: {
            status: maxReached ? 'failed_exhausted' : 'failed_retrying',
            attemptCount: newCount,
            lastAttemptAt: new Date(),
            lastResponseStatus: null,
            lastResponseBody: errorMsg,
            nextRetryAt: maxReached ? null : new Date(Date.now() + Math.pow(2, newCount) * 60000),
          }
        })
      })

      throw err
    }

    return { success: true }
  }
)
