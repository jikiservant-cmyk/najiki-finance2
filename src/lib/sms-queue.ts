import { redis } from './redis'
import { smsStore, SmsRequest } from './sms-store'
import { sendSmsViaProvider } from './sms'
import { db } from './db'
import { createHmac } from 'crypto'
import { safeFetch, isPlaceholderUrl } from './safe-fetch'

const SMS_QUEUE_KEY = 'sms:queue'

export const smsQueue = {
  /**
   * Pushes a new SMS job to the Redis queue.
   */
  enqueue: async (smsId: string) => {
    // We only push the ID to the queue
    await redis.lpush(SMS_QUEUE_KEY, smsId)
    // Guarantee background execution so messages are processed immediately without depending solely on external cron
    const timer = setTimeout(() => {
      smsQueue.processBatch(5).catch(err => {
        console.error('[smsQueue] Background processBatch error:', err)
      })
    }, 10)
    if (timer && typeof timer.unref === 'function') {
      timer.unref()
    }
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
      let sms: SmsRequest | undefined | null

      try {
        sms = await smsStore.get(smsId)
        
        if (!sms) {
          console.error(`SMS not found in store: ${smsId}`)
          continue
        }

        console.log(`[smsQueue] Processing SMS ${smsId} for ${sms.recipient} (attempt ${(sms.attemptCount || 0) + 1})`);
        
        // Update status to pending
        await smsStore.updateStatus(smsId, 'pending')

        // Safely resolve application for post-delivery webhook without blocking provider delivery
        try {
          if (sms.applicationId) {
            application = await db.application.findUnique({ where: { id: sms.applicationId } })
          } else if (sms.applicationCode) {
            application = await db.application.findFirst({ where: { code: sms.applicationCode } })
          }
        } catch (dbErr) {
          console.warn(`[smsQueue] Could not resolve application for SMS ${smsId} (webhook may be skipped):`, dbErr)
        }

        // Send SMS via Provider
        console.log(`[smsQueue] Sending via provider...`);
        const result = await sendSmsViaProvider(sms.recipient, sms.message, sms.senderId)
        console.log(`[smsQueue] Send result:`, result);
        
        if (!result.success) {
          throw new Error(result.error || 'Provider rejected SMS delivery')
        }

        // Update status to delivered and attach provider tracking message ID
        await smsStore.updateStatus(smsId, 'delivered', undefined, undefined, result.providerId)
        
        results.push({ smsId, success: true, providerId: result.providerId })

        // Fire webhook to connected app
        if (application && application.webhookPath) {
          const rawBaseUrl = (application.baseUrl || '').trim()
          const rawPath = (application.webhookPath || '').trim()
          const webhookUrl = `${rawBaseUrl}${rawPath.startsWith('/') ? '' : '/'}${rawPath}`

          if (isPlaceholderUrl(webhookUrl)) {
            console.log(`[smsQueue] Skipped partner webhook for ${application.code}: endpoint is a placeholder domain (${webhookUrl}). SMS delivery was completed successfully.`)
          } else {
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
              await safeFetch(webhookUrl, {
                method: 'POST',
                headers,
                body: payload
              })
              console.log(`[smsQueue] Successfully dispatched webhook to ${webhookUrl}`)
            } catch (webhookErr: any) {
              console.warn(`[smsQueue] Webhook delivery note for ${webhookUrl}: ${webhookErr?.message || 'Network error'}. Note: SMS was delivered successfully.`)
            }
          }
        }
      } catch (error: any) {
        console.error(`Failed to process SMS ${smsId}:`, error)
        
        const maxRetries = 3;
        const currentAttempts = sms?.attemptCount ?? 0;
        const nextAttempt = currentAttempts + 1;

        if (sms && nextAttempt < maxRetries) {
          console.log(`[smsQueue] Re-queueing SMS ${smsId} (attempt ${nextAttempt}/${maxRetries})`);
          // Update attempt count and failure note in store
          await smsStore.updateStatus(
            smsId,
            'failed',
            `Retry ${nextAttempt}/${maxRetries}: ${error.message || 'Unknown error'}`,
            nextAttempt
          )
          
          // Requeue it to the left side so it gets retried
          await redis.lpush(SMS_QUEUE_KEY, smsId);
          
          results.push({ smsId, success: false, error: error.message, retried: true });
          continue;
        }
        
        // Terminal failure: reached max retries or unrecoverable
        console.log(`[smsQueue] Terminal failure for SMS ${smsId} after ${nextAttempt} attempts`);
        await smsStore.updateStatus(
          smsId,
          'failed',
          `Permanent failure after ${nextAttempt} attempts: ${error.message || 'Unknown error'}`,
          nextAttempt
        )
        
        results.push({ smsId, success: false, error: error.message, retried: false })

        // Fire webhook for failure
        if (sms && application && application.webhookPath) {
          const rawBaseUrl = (application.baseUrl || '').trim()
          const rawPath = (application.webhookPath || '').trim()
          const webhookUrl = `${rawBaseUrl}${rawPath.startsWith('/') ? '' : '/'}${rawPath}`

          if (isPlaceholderUrl(webhookUrl)) {
            console.log(`[smsQueue] Skipped failure webhook dispatch for ${application.code}: target is a placeholder domain (${webhookUrl}).`)
          } else {
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
              await safeFetch(webhookUrl, { method: 'POST', headers, body: payload })
            } catch (webhookErr: any) {
              console.warn(`[smsQueue] Failure webhook notice for ${webhookUrl}: ${webhookErr?.message || 'Network error'}.`)
            }
          }
        }
      }
    }
    
    return results
  }
}
