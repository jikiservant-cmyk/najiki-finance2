import { redis } from './redis'
import { smsStore, SmsRequest } from './sms-store'
import { sendSmsViaProvider } from './sms'
import { db } from './db'
import { safeFetch, isPlaceholderUrl } from './safe-fetch'
import { computeNextRetryAt, isExhausted } from './backoff'
import { maskPhoneNumber } from './redact'
import { webhookSecretFromRow } from './application-auth'
import { buildNotificationHeaders } from './notification-signature'
import { parseProviderCost } from './provider-cost'

const SMS_QUEUE_KEY = 'sms:queue'
/** Set of ids currently in the queue — makes enqueue idempotent. */
const SMS_QUEUE_SEEN_KEY = 'sms:queue:seen'

const SMS_MAX_ATTEMPTS = 3

export const smsQueue = {
  /**
   * Pushes a new SMS job to the Redis queue.
   *
   * Idempotent: the same id is never queued twice (a retried HTTP request used
   * to enqueue a duplicate and send the message twice).
   */
  enqueue: async (smsId: string) => {
    const added = await redis.sadd(SMS_QUEUE_SEEN_KEY, smsId)
    if (Number(added) === 0) {
      console.log(`[smsQueue] SMS ${smsId} is already queued — skipping duplicate enqueue`)
      return
    }

    await redis.lpush(SMS_QUEUE_KEY, smsId)
    await smsStore.setNextAttemptAt(smsId, new Date())

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
      if (!smsId) {
        console.log(`[smsQueue] Queue empty, stopping batch`);
        break
      }

      // Claim the id. A second worker (or a retry that re-queued without
      // clearing the marker) must not send the same message twice.
      const claimed = await redis.srem(SMS_QUEUE_SEEN_KEY, smsId)
      if (Number(claimed) === 0) {
        console.log(`[smsQueue] Skipping ${smsId}: already claimed by another worker`)
        continue
      }
      console.log(`[smsQueue] processing smsId=${smsId}`)

      let application: any = null
      let sms: SmsRequest | undefined | null

      try {
        sms = await smsStore.get(smsId)

        if (!sms) {
          console.error(`SMS not found in store: ${smsId}`)
          continue
        }

        // Honour the retry schedule: a message that failed a moment ago waits
        // out its backoff instead of being re-sent on the very next tick.
        //
        // The id was popped and un-marked above, so it MUST be put back before
        // stopping — otherwise the message would be dropped from the queue and
        // never sent. The batch then ends: everything behind this message is
        // no more due than it is, and the next tick is a minute away.
        if (sms.nextAttemptAt && new Date(sms.nextAttemptAt).getTime() > Date.now()) {
          await redis.lpush(SMS_QUEUE_KEY, smsId)
          await redis.sadd(SMS_QUEUE_SEEN_KEY, smsId)
          console.log(
            `[smsQueue] Deferring ${smsId} until ${new Date(sms.nextAttemptAt).toISOString()} — ending batch`
          )
          break
        }

        console.log(`[smsQueue] Processing SMS ${smsId} for ${maskPhoneNumber(sms.recipient)} (attempt ${(sms.attemptCount || 0) + 1})`);
        
        // Update status to pending
        await smsStore.updateStatus(smsId, 'pending')
        await smsStore.setNextAttemptAt(smsId, null)

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
        const result = await sendSmsViaProvider(sms.recipient, sms.message, sms.senderId ?? undefined)
        console.log(`[smsQueue] Send result:`, result);
        
        if (!result.success) {
          throw new Error(result.error || 'Provider rejected SMS delivery')
        }

        // Update status to delivered and attach provider tracking message ID
        await smsStore.updateStatus(
          smsId,
          'delivered',
          undefined,
          (sms.attemptCount || 0) + 1,
          result.providerId
        )
        await smsStore.setNextAttemptAt(smsId, null)

        // Replace the placeholder cost with what the provider charged. Real cost
        // varies by destination, sender ID and message length (long messages are
        // billed per part); the dashboard sums this column as "Total Cost".
        const parsedCost = parseProviderCost(result.cost)
        if (parsedCost) {
          const updated = await smsStore.updateProviderCost(smsId, parsedCost.amountMinor)
          if (!updated) {
            console.warn(
              `[smsQueue] Provider cost for ${smsId} not applied (already recorded or row missing)`
            )
          }
        }

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
            
            // Same signer as the payment-notification path. This used to build
            // its own bare HMAC and *also* send `Authorization: Bearer <secret>`,
            // which meant a partner had to implement two verification schemes,
            // the SMS one had no timestamp (so a captured body stayed valid
            // forever), and the signing secret itself was copied into a header a
            // partner's proxy or log aggregator would record.
            const headers = buildNotificationHeaders(
              webhookSecretFromRow(application),
              payload
            )

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

        const currentAttempts = sms?.attemptCount ?? 0;
        const nextAttempt = currentAttempts + 1;

        if (sms && !isExhausted(nextAttempt, SMS_MAX_ATTEMPTS)) {
          console.log(`[smsQueue] Re-queueing SMS ${smsId} (attempt ${nextAttempt}/${SMS_MAX_ATTEMPTS})`);
          // Keep the row in "queued" while it is still retryable so the
          // dashboard does not report a retrying message as permanently failed.
          await smsStore.updateStatus(
            smsId,
            'queued',
            `Retry ${nextAttempt}/${SMS_MAX_ATTEMPTS}: ${error.message || 'Unknown error'}`,
            nextAttempt
          )
          await smsStore.setNextAttemptAt(smsId, computeNextRetryAt(nextAttempt, { baseDelayMs: 15_000 }))

          // Requeue it to the left side so it gets retried
          await redis.lpush(SMS_QUEUE_KEY, smsId);
          await redis.sadd(SMS_QUEUE_SEEN_KEY, smsId);

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
        await smsStore.setNextAttemptAt(smsId, null)
        
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
            
            const headers = buildNotificationHeaders(
              webhookSecretFromRow(application),
              payload
            )

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
