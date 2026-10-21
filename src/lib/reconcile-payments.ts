import { db } from './db'
import { getPaymentProvider } from './providers'
import {
  completePayment,
  deliverQueuedNotification,
  enqueueWebhookNotification,
  recordNotificationDelivered,
  recordNotificationFailure,
} from './payments'
import { resolveTenantOrPlatformCredentials } from './tenant-credentials'
import { isConfirmedTerminalStatus } from './payment-security'
import { isPlatformFeeType, resolvePartnerWebhookUrl } from './constants'
import { webhookSecretFromRow } from './application-auth'
import { safeJsonObject } from './json'

export interface ReconcileSingleResult {
  status: string
  failureReason: string | null
  completedAt: Date | null
  providerPaymentId: string | null
  transitioned: boolean
}

/**
 * Flush any undelivered outbound notifications (`pending` / `failed_retrying`)
 * for a settled payment so partner apps (Kunity / ChurchOS) receive wallet
 * credits even if an earlier delivery attempt was interrupted.
 */
export async function flushPendingNotificationsForPayment(
  paymentIntentId: string,
  opts: { fallbackWebhookSecret?: string | null } = {}
): Promise<number> {
  try {
    const rows = await db.internalNotification.findMany({
      where: {
        paymentIntentId,
        status: { in: ['pending', 'failed_retrying'] },
      },
      orderBy: { createdAt: 'asc' },
      take: 5,
    })

    let delivered = 0
    for (const row of rows) {
      const outcome = await deliverQueuedNotification(row, {
        fallbackSecret: opts.fallbackWebhookSecret ?? null,
      })
      if (outcome.success) {
        await recordNotificationDelivered(paymentIntentId, outcome.statusCode ?? 200)
        delivered++
      } else {
        const permanent = Boolean(outcome.error?.includes('(permanent)'))
        await recordNotificationFailure(paymentIntentId, outcome.error || 'Delivery retry failed', {
          permanent,
          statusCode: outcome.statusCode,
        })
      }
    }
    return delivered
  } catch (err) {
    console.warn(`[reconcile] Failed flushing notifications for ${paymentIntentId}:`, err)
    return 0
  }
}

/**
 * Poll the payment provider for a single non-terminal `PaymentIntent` and, when
 * the provider confirms a terminal state (`success` / `failed`), atomically
 * settle the ledger and dispatch the signed partner notification.
 */
export async function reconcileSinglePaymentById(
  paymentIntentId: string,
  opts: {
    note?: string
    fallbackWebhookSecret?: string | null
  } = {}
): Promise<ReconcileSingleResult | null> {
  const payment = await db.paymentIntent.findUnique({
    where: { id: paymentIntentId },
    include: {
      provider: true,
      application: true,
      tenant: true,
      paymentType: true,
    },
  })

  if (!payment) return null

  if (payment.status === 'success' || payment.status === 'failed') {
    await flushPendingNotificationsForPayment(payment.id, {
      fallbackWebhookSecret: opts.fallbackWebhookSecret ?? payment.application?.apiKey ?? null,
    })
    return {
      status: payment.status,
      failureReason: payment.failureReason,
      completedAt: payment.completedAt,
      providerPaymentId: payment.providerPaymentId,
      transitioned: false,
    }
  }

  if (!payment.provider?.code) {
    return {
      status: payment.status,
      failureReason: payment.failureReason,
      completedAt: payment.completedAt,
      providerPaymentId: payment.providerPaymentId,
      transitioned: false,
    }
  }

  const intentMeta = safeJsonObject(payment.metadata)
  const resolvedPaymentTypeCode =
    payment.paymentType?.code ?? (intentMeta?.paymentTypeCode as string | undefined) ?? null
  const isPlatformPayment = isPlatformFeeType(resolvedPaymentTypeCode)

  let customCredentials: any = undefined
  if (payment.tenantId && payment.providerId && !isPlatformPayment) {
    const resolved = await resolveTenantOrPlatformCredentials(
      payment.tenantId,
      payment.providerId,
      payment.tenant?.code
    )
    if (!resolved) {
      return {
        status: payment.status,
        failureReason: payment.failureReason,
        completedAt: payment.completedAt,
        providerPaymentId: payment.providerPaymentId,
        transitioned: false,
      }
    }
    customCredentials = resolved.credentials
  }

  const providerClient = getPaymentProvider(payment.provider.code, customCredentials)
  if (!providerClient.checkPaymentStatus) {
    return {
      status: payment.status,
      failureReason: payment.failureReason,
      completedAt: payment.completedAt,
      providerPaymentId: payment.providerPaymentId,
      transitioned: false,
    }
  }

  const statusResult = await providerClient.checkPaymentStatus(
    payment.reference,
    payment.currency,
    payment.providerPaymentId || undefined
  )

  await db.paymentIntent
    .update({
      where: { id: payment.id },
      data: { lastPolledAt: new Date() },
    })
    .catch(() => {})

  if (
    isConfirmedTerminalStatus(statusResult, {
      amount: Number(payment.amount),
      currency: payment.currency,
      providerPaymentId: payment.providerPaymentId,
      reference: payment.reference,
    })
  ) {
    const completion = await completePayment({
      paymentIntentId: payment.id,
      status: statusResult.status,
      providerPaymentId: statusResult.providerPaymentId || payment.providerPaymentId,
      failureReason: statusResult.failureReason,
      amount: Number(payment.amount),
      currency: payment.currency,
      rawProviderResponse: JSON.stringify(statusResult),
      note: opts.note || 'LIVE_STATUS_RECONCILIATION',
    })

    if (!completion.wasAlreadyProcessed) {
      await enqueueWebhookNotification({
        paymentIntentId: payment.id,
        reference: payment.reference,
        status: statusResult.status,
        amount: Number(payment.amount),
        currency: payment.currency,
        providerPaymentId: statusResult.providerPaymentId || payment.providerPaymentId || '',
        failureReason: statusResult.failureReason,
        applicationId: payment.applicationId,
        webhookUrl: resolvePartnerWebhookUrl(payment.application),
        webhookSecret: webhookSecretFromRow(payment.application),
        fallbackWebhookSecret: opts.fallbackWebhookSecret ?? payment.application.apiKey ?? null,
        externalEntityId: payment.externalEntityId,
        tenantId: payment.tenantId,
        tenantCode: payment.tenant?.code ?? null,
        paymentTypeCode: resolvedPaymentTypeCode,
        metadata: intentMeta,
      })
    } else {
      await flushPendingNotificationsForPayment(payment.id, {
        fallbackWebhookSecret: opts.fallbackWebhookSecret ?? payment.application.apiKey ?? null,
      })
    }

    return {
      status: completion.intent.status,
      failureReason: completion.intent.failureReason,
      completedAt: completion.intent.completedAt,
      providerPaymentId: completion.intent.providerPaymentId,
      transitioned: !completion.wasAlreadyProcessed,
    }
  }

  return {
    status: payment.status,
    failureReason: payment.failureReason,
    completedAt: payment.completedAt,
    providerPaymentId: payment.providerPaymentId,
    transitioned: false,
  }
}

/**
 * Bounded reconciliation sweep for serverless deployments (e.g. Netlify where
 * Vercel Cron does not run automatically). Reconciles recent `processing` /
 * `pending` intents and retries due partner notifications within `budgetMs`.
 */
export async function reconcileProcessingPayments(
  opts: {
    limit?: number
    minAgeMs?: number
    minPollIntervalMs?: number
    budgetMs?: number
  } = {}
): Promise<{ polled: number; transitioned: number; retriedNotifications: number }> {
  const limit = opts.limit ?? 12
  const minAgeMs = opts.minAgeMs ?? 5_000
  const minPollIntervalMs = opts.minPollIntervalMs ?? 10_000
  const budgetMs = opts.budgetMs ?? 8_000
  const startedAt = Date.now()

  let polled = 0
  let transitioned = 0
  let retriedNotifications = 0

  try {
    const createdCutoff = new Date(Date.now() - minAgeMs)
    const pollCutoff = new Date(Date.now() - minPollIntervalMs)
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)

    const candidates = await db.paymentIntent.findMany({
      where: {
        status: { in: ['processing', 'pending'] },
        createdAt: { lte: createdCutoff, gte: fourteenDaysAgo },
        OR: [{ lastPolledAt: null }, { lastPolledAt: { lte: pollCutoff } }],
      },
      select: { id: true },
      orderBy: [{ lastPolledAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: limit,
    })

    for (const item of candidates) {
      if (Date.now() - startedAt >= budgetMs) break
      polled++
      try {
        const res = await reconcileSinglePaymentById(item.id, {
          note: 'AUTO_RECONCILE_SWEEP',
        })
        if (res?.transitioned) transitioned++
      } catch (itemErr) {
        console.warn(`[reconcile] Error polling ${item.id}:`, itemErr)
      }
    }

    if (Date.now() - startedAt < budgetMs) {
      const dueNotifications = await db.internalNotification.findMany({
        where: {
          status: { in: ['pending', 'failed_retrying'] },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      })

      for (const row of dueNotifications) {
        if (Date.now() - startedAt >= budgetMs) break
        retriedNotifications++
        try {
          const outcome = await deliverQueuedNotification(row)
          if (outcome.success) {
            await recordNotificationDelivered(row.paymentIntentId, outcome.statusCode ?? 200)
          } else {
            const permanent = Boolean(outcome.error?.includes('(permanent)'))
            await recordNotificationFailure(
              row.paymentIntentId,
              outcome.error || 'Notification retry failed',
              { permanent, statusCode: outcome.statusCode }
            )
          }
        } catch (notifErr) {
          console.warn(`[reconcile] Error delivering notification ${row.id}:`, notifErr)
        }
      }
    }
  } catch (err) {
    console.warn('[reconcile] Sweep warning:', err)
  }

  return { polled, transitioned, retriedNotifications }
}
