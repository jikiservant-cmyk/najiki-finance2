import { redis } from './redis'
import { smsStore, type SmsRequest } from './sms-store'
import { sendSmsViaProvider } from './sms'
import { db } from './db'
import { safeFetch, isPlaceholderUrl } from './safe-fetch'
import { webhookSecretFromRow } from './application-auth'
import { buildNotificationHeaders } from './notification-signature'
import { parseProviderCost } from './provider-cost'

const SMS_QUEUE_KEY = 'sms:queue'

/**
 * Redis is an optional wake-up hint, not the source of truth. The database's
 * queued rows are the outbox; every cron run sweeps them even when LPUSH/RPOP
 * failed or a worker died after popping a hint. A conditional DB update is the
 * only permission to call the provider. Once claimed, exceptions are ambiguous
 * and MUST NOT cause an automatic second send.
 */
export const smsQueue = {
  enqueue: async (smsId: string): Promise<void> => {
    try {
      await redis.lpush(SMS_QUEUE_KEY, smsId)
    } catch {
      console.warn(`[smsQueue] Redis hint unavailable for ${smsId}; DB outbox will recover it`)
    }
  },

  processBatch: async (batchSize = 10) => {
    const size = Math.max(1, Math.min(batchSize, 50))
    const ids: string[] = []
    try {
      for (let i = 0; i < size; i++) {
        const id = await redis.rpop<string>(SMS_QUEUE_KEY)
        if (!id) break
        ids.push(id)
      }
    } catch {
      console.warn('[smsQueue] Redis read unavailable; sweeping DB outbox')
    }
    // Also catches lost hints, pre-existing stranded jobs and duplicate HTTP
    // requests. A second worker/duplicate hint loses the atomic claim.
    ids.push(...await smsStore.getDueQueued(size))
    const results: Array<{ smsId: string; success: boolean; status: string }> = []
    for (const id of new Set(ids)) {
      if (results.length >= size) break
      const sms = await smsStore.claimForSending(id)
      if (!sms) continue
      try {
        const result = await sendSmsViaProvider(sms.recipient, sms.message, sms.senderId ?? undefined)
        if (!result.success) {
          await smsStore.failExplicitly(id)
          results.push({ smsId: id, success: false, status: 'failed' })
          continue
        }
        // 'success', 'submitted', and 'buffered' acknowledge acceptance only.
        // Actual delivery requires an authenticated DLR with the same provider ID.
        await smsStore.recordProviderAcceptance(id, result.providerId)
        const cost = parseProviderCost(result.cost)
        if (cost) await smsStore.updateProviderCost(id, cost.amountMinor)
        results.push({ smsId: id, success: true, status: 'pending' })
      } catch {
        // Network timeout, lost provider response, or DB write failure: the
        // provider may have sent the text already. Keep the claim in pending;
        // manual reconciliation is needed. Never retry the same SMS blindly.
        console.error(`[smsQueue] Ambiguous send for ${id}; held pending, no automatic resend`)
        results.push({ smsId: id, success: false, status: 'pending' })
      }
    }
    return results
  },
}

/** Best-effort immediate delivery plus durable cron retry of terminal webhooks.
 * Partners should deduplicate by smsId and status (webhooks are at-least-once).
 */
export async function deliverSmsNotification(sms: SmsRequest): Promise<boolean> {
  if (sms.status !== 'delivered' && sms.status !== 'failed') return false
  try {
    const app = sms.applicationId
      ? await db.application.findUnique({ where: { id: sms.applicationId } })
      : null
    // Admin quick-sends can have no application; no partner endpoint exists.
    if (!app || !app.webhookPath) {
      await smsStore.markNotificationDelivered(sms.id, sms.status)
      return true
    }
    const target = `${app.baseUrl || ''}${app.webhookPath.startsWith('/') ? '' : '/'}${app.webhookPath}`
    if (isPlaceholderUrl(target)) {
      await smsStore.markNotificationAttempted(sms.id, sms.status)
      return false
    }
    const secret = webhookSecretFromRow(app)
    if (!secret) {
      await smsStore.markNotificationAttempted(sms.id, sms.status)
      return false // never send an unsigned partner notification
    }
    const body = JSON.stringify({
      eventType: 'SMS_DELIVERY_UPDATE', smsId: sms.id, reference: sms.reference,
      status: sms.status, providerId: sms.providerMessageId,
      recipient: sms.recipient, applicationCode: app.code,
    })
    const response = await safeFetch(target, {
      method: 'POST', headers: buildNotificationHeaders(secret, body), body,
    })
    if (!response.ok) {
      await smsStore.markNotificationAttempted(sms.id, sms.status)
      return false
    }
    await smsStore.markNotificationDelivered(sms.id, sms.status)
    return true
  } catch {
    try { await smsStore.markNotificationAttempted(sms.id, sms.status) } catch { /* database unavailable */ }
    console.warn(`[smsQueue] Terminal notification for ${sms.id} not acknowledged; cron will retry`)
    return false
  }
}

export async function retrySmsNotifications(limit = 20): Promise<number> {
  const pending = await smsStore.getPendingTerminalNotifications(limit)
  let sent = 0
  for (const sms of pending) if (await deliverSmsNotification(sms)) sent++
  return sent
}
