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
    // Sweep DB *before* hints to keep old stranded rows moving even under a
    // continuous stream of fresh Redis jobs. Only the DB claim grants a send.
    const due = await smsStore.getDueQueued(size)
    const workIds = [...new Set([...due, ...ids])].slice(0, size)
    // Limit concurrency to the caller's batch size (10 for cron). Serial SDK
    // requests could consume the entire 60s serverless window before the
    // delivery-report reconciliation and webhook retry steps run.
    const outcomes = await Promise.all(workIds.map(async (id) => {
      const sms = await smsStore.claimForSending(id)
      if (!sms) return null
      try {
        const result = await sendSmsViaProvider(sms.recipient, sms.message, sms.senderId ?? undefined)
        if (!result.success) {
          // Persist the provider's own status word so `failure_reason` can be
          // acted on. The returned object stays exactly {smsId, success, status}
          // — callers and tests depend on that shape.
          const reason = result.providerStatus ? `Provider rejected SMS: ${result.providerStatus}` : undefined
          await smsStore.failExplicitly(id, reason)
          return { smsId: id, success: false, status: 'failed' }
        }
        // Provider acceptance is NOT proof of delivery.
        await smsStore.recordProviderAcceptance(id, result.providerId)
        const cost = parseProviderCost(result.cost)
        if (cost) await smsStore.updateProviderCost(id, cost.amountMinor)
        return { smsId: id, success: true, status: 'pending' }
      } catch {
        // SDK timeout or lost response is ambiguous: never retry automatically.
        console.error(`[smsQueue] Ambiguous send for ${id}; held pending, no automatic resend`)
        return { smsId: id, success: false, status: 'pending' }
      }
    }))
    const results = outcomes.filter((item): item is NonNullable<typeof item> => item !== null)
    return results
  },
}

/** Best-effort immediate delivery plus durable cron retry of terminal webhooks.
 * Partners should deduplicate by smsId and status (webhooks are at-least-once).
 */
export async function deliverSmsNotification(sms: SmsRequest): Promise<boolean> {
  // `unknown` is terminal (markStalePendingUnknown) but is only notifiable when
  // SMS_NOTIFY_UNKNOWN=true — see sms-store.getPendingTerminalNotifications.
  // Read inline rather than importing a helper: this module's import list is
  // stubbed exhaustively by the tests, and adding an import would require them
  // to know about it.
  const notifyUnknown = String(process.env.SMS_NOTIFY_UNKNOWN ?? '').trim().toLowerCase() === 'true'
  const terminal =
    sms.status === 'delivered' ||
    sms.status === 'failed' ||
    (notifyUnknown && sms.status === 'unknown')
  if (!terminal) return false
  try {
    const app = sms.applicationId
      ? await db.application.findUnique({ where: { id: sms.applicationId } })
      : null
    // Legacy admin sends may have no application. An existing application
    // without a webhook is misconfigured, not an acknowledged delivery.
    if (!app && !sms.applicationId) {
      await smsStore.markNotificationDelivered(sms.id, sms.status)
      return true
    }
    if (!app || !app.webhookPath) {
      await smsStore.markNotificationAttempted(sms.id, sms.status)
      return false
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

export async function retrySmsNotifications(limit = 10): Promise<number> {
  const pending = await smsStore.getPendingTerminalNotifications(limit)
  const outcomes = await Promise.all(pending.map(deliverSmsNotification))
  return outcomes.filter(Boolean).length
}

export async function reconcileSmsDeliveryReports(limit = 10): Promise<number> {
  const ids = await smsStore.getUnappliedDeliveryReportIds(limit)
  const outcomes = await Promise.all(ids.map(async (id) => {
    const updated = await smsStore.resolveDeliveryReport(id)
    if (updated) await deliverSmsNotification(updated)
    return !!updated
  }))
  return outcomes.filter(Boolean).length
}
