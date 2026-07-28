import { redis } from './redis'
import { smsStore, SmsRequest } from './sms-store'
import { sendSmsViaProvider } from './sms'
import { db } from './db'
import { createHmac } from 'crypto'

const SMS_QUEUE_KEY = 'sms:queue'

export const smsQueue = {
  /**
   * Pushes a new SMS job to the Redis queue.
   */
  enqueue: async (smsId: string) => {
    // We only push the ID to the queue
    await redis.lpush(SMS_QUEUE_KEY, smsId)
  },

  /**
   * Worker function: pulls a batch of SMS jobs from Redis and processes them.
   * This would typically be called by a cron job (e.g., Vercel Cron) every minute.
   */
  processBatch: async (batchSize = 10) => {
    console.log(`[smsQueue] processBatch called with batchSize=${batchSize}`);
    const results: any[] = []
    
    for (let i = 0; i < batchSize; i++) {
      // Pop an item from the right side of the list
      const smsId = await redis.rpop<string>(SMS_QUEUE_KEY)
      console.log(`[smsQueue] popped smsId=${smsId}`);
      
      if (!smsId) {
        // Queue is empty
        console.log(`[smsQueue] Queue empty, stopping batch`);
        break
      }

      let application: any = null
      let sms: SmsRequest | undefined

      try {
        const smsList = smsStore.getAll()
        sms = smsList.find((s: SmsRequest) => s.id === smsId)
        
        if (!sms) {
          console.error(`SMS not found in store: ${smsId}`)
          continue
        }

        console.log(`[smsQueue] Processing SMS ${smsId} for ${sms.recipient}`);
        // Update status to pending
        smsStore.updateStatus(smsId, 'pending')

        if (sms.applicationId) {
          application = await db.application.findUnique({ where: { id: sms.applicationId } })
        } else if (sms.applicationCode) {
          application = await db.application.findFirst({ where: { code: sms.applicationCode } })
        }

        // Send SMS via Provider
        console.log(`[smsQueue] Sending via provider...`);
        const result = await sendSmsViaProvider(sms.recipient, sms.message)
        console.log(`[smsQueue] Send result:`, result);
        
        // Update status to delivered
        smsStore.updateStatus(smsId, 'delivered')
        
        results.push({ smsId, success: true })

        // Fire webhook to connected app
        if (application && application.webhookPath) {
          const webhookUrl = `${application.baseUrl}${application.webhookPath}`
          const payload = JSON.stringify({
            eventType: 'SMS_DELIVERY_UPDATE',
            smsId: smsId,
            reference: sms.reference,
            status: 'delivered',
            providerId: result.providerId,
            recipient: sms.recipient,
            applicationCode: application.code
          })
          
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Najiki-Notification': 'true'
          }
          if (application.apiKey) {
            headers['X-Najiki-Signature'] = createHmac('sha256', application.apiKey).update(payload).digest('hex')
            headers['Authorization'] = `Bearer ${application.apiKey}`
          }

          try {
            await fetch(webhookUrl, {
              method: 'POST',
              headers,
              body: payload
            })
            console.log(`[smsQueue] Successfully dispatched webhook to ${webhookUrl}`)
          } catch (webhookErr) {
            console.error(`[smsQueue] Failed to dispatch webhook to ${webhookUrl}:`, webhookErr)
          }
        }
      } catch (error: any) {
        console.error(`Failed to process SMS ${smsId}:`, error)
        
        // Update status to failed
        smsStore.updateStatus(smsId, 'failed', error.message || 'Unknown error')
        
        results.push({ smsId, success: false, error: error.message })

        // Fire webhook for failure
        if (sms && application && application.webhookPath) {
          const webhookUrl = `${application.baseUrl}${application.webhookPath}`
          const payload = JSON.stringify({
            eventType: 'SMS_DELIVERY_UPDATE',
            smsId: smsId,
            reference: sms.reference,
            status: 'failed',
            error: error.message,
            recipient: sms.recipient,
            applicationCode: application.code
          })
          
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Najiki-Notification': 'true'
          }
          if (application.apiKey) {
            headers['X-Najiki-Signature'] = createHmac('sha256', application.apiKey).update(payload).digest('hex')
            headers['Authorization'] = `Bearer ${application.apiKey}`
          }

          try {
            await fetch(webhookUrl, { method: 'POST', headers, body: payload })
          } catch (webhookErr) {
            console.error(`[smsQueue] Failed to dispatch failure webhook to ${webhookUrl}:`, webhookErr)
          }
        }
      }
    }
    
    return results
  }
}
