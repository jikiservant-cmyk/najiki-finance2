import { db } from './db'
import { getPaymentProvider } from './providers'
import { resolveTenantOrPlatformCredentials } from './tenant-credentials'
import { isPlatformFeeType, resolvePartnerWebhookUrl, appRequiresTenantCredentials } from './constants'
import { toMinorUnits } from './money'
import { fallbackSigningSecretsFromRow, webhookSecretFromRow } from './application-auth'
import { safeJsonObject } from './json'

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
      include: { application: true, paymentType: true, tenant: true },
    })

    // Define payment types that go to the platform (owner's main account)
    const metaObj = safeJsonObject(payment?.metadata)
    const isPlatformPayment = isPlatformFeeType(
      payment?.paymentType?.code ?? (metaObj?.paymentTypeCode as string | undefined)
    )

    // Defense in depth (payment creation rejects these): in an app that
    // requires per-tenant credentials, the money unit is the tenant — a
    // tenant-less collection is unattributed money and must never run on
    // platform credentials.
    if (
      !isPlatformPayment &&
      !payment?.tenantId &&
      payment?.application &&
      appRequiresTenantCredentials(payment.application.code)
    ) {
      throw new Error(
        `Application "${payment.application.code}" requires a tenant for tenant collections; ` +
          `payment ${paymentIntentId} has none. Platform credentials are not a fallback.`
      )
    }

    // Only load tenant credentials if it's NOT a platform payment.
    // Platform payments use the default global credentials — that account is
    // the platform wallet, where SMS purchases and platform fees belong.
    if (payment?.tenantId && payment?.providerId && !isPlatformPayment) {
      const resolved = await resolveTenantOrPlatformCredentials(
        payment.tenantId,
        payment.providerId,
        payment.tenant?.code
      )
      if (!resolved) {
        throw new Error(`TENANT_CREDENTIALS_UNAVAILABLE: ${payment.tenant?.code ?? payment.tenantId}`)
      }
      customCredentials = resolved.credentials
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

    const isTerminalOnInitiate =
      providerResponse.status === 'success' || providerResponse.status === 'failed'
    const initiateWebhookUrl = payment ? resolvePartnerWebhookUrl(payment.application) : webhookUrl
    const initiatePaymentType =
      payment?.paymentType?.code ?? (metaObj?.paymentTypeCode as string | undefined) ?? null
    const initiateNotifPayload = payment
      ? {
          paymentIntentId,
          reference,
          status: providerResponse.status,
          amount: Number(amount),
          currency,
          providerPaymentId: providerResponse.providerPaymentId || '',
          failureReason: providerResponse.failureReason || null,
          externalEntityId: payment.externalEntityId,
          tenantId: payment.tenantId ?? null,
          tenantCode: payment.tenant?.code ?? null,
          paymentType: initiatePaymentType,
          paymentTypeCode: initiatePaymentType,
          metadata: safeJsonObject(payment.metadata),
        }
      : null

    await db.$transaction([
      // Guarded, not unconditional. The provider's answer to *initiate* can
      // arrive after its own callback has already settled the payment: the
      // member approves on their phone while our HTTP call is still open. A
      // plain `update` then wrote "pending" over "success", and the next
      // callback completed the payment a second time. `updateMany` with the
      // status guard matches zero rows in that case and changes nothing.
      db.paymentIntent.updateMany({
        where: { id: paymentIntentId, status: { notIn: ['success', 'failed'] } },
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
      ...(isTerminalOnInitiate && payment && initiateNotifPayload
        ? [
            db.internalNotification.create({
              data: {
                paymentIntentId,
                applicationId: payment.applicationId,
                url: initiateWebhookUrl,
                payload: JSON.stringify(initiateNotifPayload),
                status: 'pending',
                attemptCount: 0,
                maxAttempts: 5,
                nextRetryAt: new Date(),
              },
            }),
          ]
        : []),
    ])

    if (isTerminalOnInitiate && payment) {
      await enqueueWebhookNotification({
        paymentIntentId,
        reference,
        status: providerResponse.status,
        amount,
        currency,
        providerPaymentId: providerResponse.providerPaymentId || '',
        failureReason: providerResponse.failureReason,
        applicationId: payment.applicationId,
        webhookUrl: initiateWebhookUrl,
        webhookSecret: webhookSecretFromRow(payment.application),
        fallbackWebhookSecret: payment.application.apiKey ?? null,
        externalEntityId: payment.externalEntityId,
        tenantId: payment.tenantId ?? null,
        tenantCode: payment.tenant?.code ?? null,
        paymentTypeCode: initiatePaymentType,
        metadata: safeJsonObject(payment.metadata),
      })
    }
  } catch (err: any) {
    console.error(`processPayment error for ${paymentIntentId}:`, err)
    const isNetworkAmbiguous = err?.message?.startsWith('TENANT_CREDENTIALS_UNAVAILABLE:') || err?.name === 'AbortError' || err?.code === 'ECONNRESET'
      || err?.code === 'ETIMEDOUT' || err?.name === 'TimeoutError' || err?.message?.includes('fetch failed')

    await db.$transaction([
      // Same guard as above, and it matters more here: a timeout is exactly
      // when the callback may already have settled the payment.
      db.paymentIntent.updateMany({
        where: { id: paymentIntentId, status: { notIn: ['success', 'failed'] } },
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
    const intentMeta = safeJsonObject(fullPaymentIntent.metadata)
    const isPlatformPayment = isPlatformFeeType(
      fullPaymentIntent.paymentType?.code ?? (intentMeta?.paymentTypeCode as string | undefined)
    )

    // P0-4 & Phase 1a: Atomic wallet balance credit and immutable ledger entry using Prisma public models
    if (status === 'success' && fullPaymentIntent.tenant && !isPlatformPayment) {
      const appCode = fullPaymentIntent.application.code.toLowerCase()
      const tenantId = fullPaymentIntent.tenant.id
      // Currency-aware: UGX has no minor unit, so this is not a x100. See
      // src/lib/money.ts for why a flat x100 credited 100x the real money.
      const amountMinor = toMinorUnits(amount, currency)
      const idempotencyKey = `${paymentIntentId}:payment_in`

      // The ledger entry — not the intent status — is the authority on whether
      // the money was already credited. The status guard above stops the normal
      // duplicate, but if a status ever regresses (an older build, a manual
      // fix, a restored backup), the balance would be incremented again while
      // the `upsert` below silently did nothing, leaving the wallet larger than
      // the sum of its own entries and the tenant paid out money never received.
      const alreadyCredited = await tx.ledgerEntry.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      })

      if (!alreadyCredited) {
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

        // `create`, not `upsert`. Two concurrent completions can both find no
        // entry; the unique key on `idempotencyKey` then rejects the loser and
        // rolls back its whole transaction, including the balance increment.
        // An `upsert { update: {} }` would have let that increment commit with no
        // entry to account for it.
        await tx.ledgerEntry.create({
          data: {
            walletId,
            paymentIntentId,
            direction: 'credit',
            amountMinor,
            currency,
            entryType: 'payment_in',
            idempotencyKey,
            balanceAfterMinor,
          },
        })
      }
    }

    // P0-7: Write outbound notification ledger record in the transaction
    if (status === 'success' || status === 'failed') {
      const webhookUrl = resolvePartnerWebhookUrl(fullPaymentIntent.application)
      const resolvedPaymentTypeCode =
        fullPaymentIntent.paymentType?.code ??
        (intentMeta?.paymentTypeCode as string | undefined) ??
        null
      const notificationPayload = {
        paymentIntentId,
        reference: fullPaymentIntent.reference,
        status,
        amount: Number(amount),
        currency,
        providerPaymentId: providerPaymentId || '',
        failureReason: failureReason || null,
        externalEntityId: fullPaymentIntent.externalEntityId,
        tenantId: fullPaymentIntent.tenantId,
        tenantCode: fullPaymentIntent.tenant?.code ?? null,
        paymentType: resolvedPaymentTypeCode,
        paymentTypeCode: resolvedPaymentTypeCode,
        metadata: safeJsonObject(fullPaymentIntent.metadata),
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
import { safeFetch, validateSafeUrl } from './safe-fetch'
import { buildNotificationHeaders } from './notification-signature'
import {
  NOTIFICATION_MAX_ATTEMPTS as MAX_ATTEMPTS,
  computeNextRetryAt,
  isExhausted,
  isPermanentHttpFailure,
} from './backoff'

let qstashClient: Client | null = null
function getQStashClient(): Client | null {
  const token = process.env.QSTASH_TOKEN
  if (!token) return null
  if (!qstashClient) {
    qstashClient = new Client({ token })
  }
  return qstashClient
}

// Retry policy lives in ./backoff so it can be unit-tested without a database.
export {
  NOTIFICATION_MAX_ATTEMPTS,
  computeNextRetryAt,
  isExhausted as isNotificationExhausted,
} from './backoff'

// The signer lives in ./notification-signature so it can be unit-tested; this
// re-export keeps the existing import path working.
export { buildNotificationHeaders }

/**
 * Mark all in-flight notifications for a payment intent as delivered.
 */
export async function recordNotificationDelivered(
  paymentIntentId: string,
  statusCode: number,
  responseBody?: string | null
): Promise<void> {
  await db.internalNotification.updateMany({
    where: { paymentIntentId, status: { in: ['pending', 'failed_retrying'] } },
    data: {
      status: 'delivered',
      lastAttemptAt: new Date(),
      lastResponseStatus: statusCode,
      lastResponseBody: responseBody ? responseBody.slice(0, 2000) : null,
    },
  })
}

/**
 * Mark in-flight notifications for a payment intent as handed to QStash.
 *
 * QStash retries on its own (and has its own failure handling), so our worker
 * must not double-send. The row is no longer `pending`, so
 * getPendingNotifications() ignores it.
 */
export async function recordNotificationDispatched(paymentIntentId: string): Promise<void> {
  await db.internalNotification.updateMany({
    where: { paymentIntentId, status: { in: ['pending', 'failed_retrying'] } },
    data: {
      status: 'dispatched',
      lastAttemptAt: new Date(),
      nextRetryAt: null,
    },
  })
}

/**
 * Record a failed delivery attempt.
 *
 * BUG FIX: this used to set `status: 'failed'`, but the retry worker only
 * selects rows in ('pending', 'failed_retrying') — so every failed webhook was
 * silently dropped forever and the attemptCount / nextRetryAt / maxAttempts
 * columns were never used. We now schedule a backoff retry, and only give up
 * once maxAttempts is reached (or the error is permanent).
 */
export async function recordNotificationFailure(
  paymentIntentId: string,
  reason: string,
  opts: { permanent?: boolean; statusCode?: number } = {}
): Promise<void> {
  const rows = await db.internalNotification.findMany({
    where: { paymentIntentId, status: { in: ['pending', 'failed_retrying'] } },
    select: { id: true, attemptCount: true, maxAttempts: true },
  })

  for (const row of rows) {
    const nextAttempt = (row.attemptCount ?? 0) + 1
    const maxAttempts = row.maxAttempts ?? MAX_ATTEMPTS
    const exhausted = isExhausted(nextAttempt, maxAttempts, opts.permanent === true)

    await db.internalNotification.update({
      where: { id: row.id },
      data: {
        attemptCount: nextAttempt,
        status: exhausted ? 'failed_exhausted' : 'failed_retrying',
        lastAttemptAt: new Date(),
        lastResponseBody: reason.slice(0, 2000),
        ...(opts.statusCode !== undefined ? { lastResponseStatus: opts.statusCode } : {}),
        nextRetryAt: exhausted ? null : computeNextRetryAt(nextAttempt),
      },
    })
  }
}

async function postSignedPartnerWebhook(opts: {
  url: string
  payloadString: string
  primarySecret: string | null | undefined
  fallbackSecret?: string | null | undefined
  fallbackSecrets?: Array<string | null | undefined>
}): Promise<{ ok: boolean; status: number; bodyText: string; usedUrl: string }> {
  const sendOnce = async (targetUrl: string, secret: string | null | undefined) => {
    const headers = buildNotificationHeaders(secret, opts.payloadString)
    const res = await safeFetch(targetUrl, {
      method: 'POST',
      headers,
      body: opts.payloadString,
      signal: AbortSignal.timeout(10_000),
    })
    const bodyText = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, bodyText, usedUrl: targetUrl }
  }

  let targetUrl = opts.url
  let attempt = await sendOnce(targetUrl, opts.primarySecret)

  // Self-heal legacy `/api/internal/payment-completed` path if partner app
  // exposes `/api/webhooks/najiki` instead (e.g. ChurchOS / Kunity).
  if (
    !attempt.ok &&
    (attempt.status === 404 || attempt.status === 405) &&
    /\/api\/internal\/payment-completed\/?$/i.test(targetUrl)
  ) {
    const healedUrl = targetUrl.replace(/\/api\/internal\/payment-completed\/?$/i, '/api/webhooks/najiki')
    await validateSafeUrl(healedUrl)
    targetUrl = healedUrl
    attempt = await sendOnce(targetUrl, opts.primarySecret)
  }

  // Partner verifiers fall back to `NAJIKI_API_KEY` or `internalSecretRef` when
  // `NAJIKI_WEBHOOK_SECRET` has not been set in their deployment env. Try each
  // distinct candidate secret if the primary secret received 401/403.
  if (!attempt.ok && (attempt.status === 401 || attempt.status === 403)) {
    const tried = new Set<string>(opts.primarySecret ? [opts.primarySecret] : [])
    const candidates = [opts.fallbackSecret, ...(opts.fallbackSecrets ?? [])].filter(
      (s): s is string => typeof s === 'string' && s.trim().length > 0 && !tried.has(s)
    )
    for (const candidate of candidates) {
      tried.add(candidate)
      console.warn(
        `[Webhook] Primary webhook secret rejected (${attempt.status}) at ${targetUrl}; retrying with application fallback secret.`
      )
      attempt = await sendOnce(targetUrl, candidate)
      if (attempt.ok || (attempt.status !== 401 && attempt.status !== 403)) {
        break
      }
    }
  }

  return attempt
}

/**
 * Deliver a single queued InternalNotification row (used by the cron retry
 * worker and live reconciliation). Returns whether the delivery succeeded.
 */
export async function deliverQueuedNotification(
  row: {
    id: string
    url: string
    payload: string
    applicationId: string
  },
  opts: { fallbackSecret?: string | null; fallbackSecrets?: string[] } = {}
): Promise<{ success: boolean; error?: string; statusCode?: number; responseBody?: string }> {
  const application = await db.application.findUnique({
    where: { id: row.applicationId },
    select: {
      code: true,
      baseUrl: true,
      webhookPath: true,
      internalSecretRef: true,
      apiKey: true,
      webhookSecretEncrypted: true,
    },
  })

  const effectiveUrl = application ? resolvePartnerWebhookUrl(application) : row.url

  try {
    await validateSafeUrl(effectiveUrl)
  } catch (urlErr: any) {
    return { success: false, error: `Unsafe webhook URL: ${urlErr?.message}`, statusCode: 0 }
  }

  const primarySecret = application ? webhookSecretFromRow(application) : null
  const extraFallbacks = [
    ...(opts.fallbackSecrets ?? []),
    ...fallbackSigningSecretsFromRow(application),
  ]

  try {
    const res = await postSignedPartnerWebhook({
      url: effectiveUrl,
      payloadString: row.payload,
      primarySecret,
      fallbackSecret: opts.fallbackSecret || application?.apiKey || null,
      fallbackSecrets: extraFallbacks,
    })

    if (res.ok) {
      return { success: true, statusCode: res.status, responseBody: res.bodyText }
    }

    // 4xx responses (except 408/429) are permanent — retrying won't help.
    const permanent = isPermanentHttpFailure(res.status)
    return {
      success: false,
      statusCode: res.status,
      responseBody: res.bodyText,
      error: `HTTP ${res.status}${res.bodyText ? `: ${res.bodyText.slice(0, 500)}` : ''}${permanent ? ' (permanent)' : ''}`,
    }
  } catch (err: any) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown delivery error',
    }
  }
}

/**
 * Hand a signed notification to QStash for delivery and retries.
 *
 * The exact bytes are published — the *same* `payloadString` the HMAC was
 * computed over — rather than the object via `publishJSON`. `publishJSON`
 * re-stringifies the body, so the bytes QStash forwards are only identical to
 * the signed ones as long as `JSON.stringify` keeps the same key order twice.
 * It does today, but that is a property of the object literal in one function
 * rather than a guarantee, and the failure mode is silent: the partner answers
 * 401 to a delivery we scheduled and consider handled. Publishing the string
 * removes the coupling entirely.
 */
async function publishSignedViaQStash(
  client: Client,
  url: string,
  payloadString: string,
  secret: string | null | undefined
): Promise<void> {
  await client.publish({
    url,
    body: payloadString,
    headers: buildNotificationHeaders(secret, payloadString),
    retries: 3,
  })
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
  /** Outbound signing secret — see `webhookSecretFromRow`. */
  webhookSecret: string | null
  /** Optional secondary secret (verified application API key) if partner uses legacy verifier fallback. */
  fallbackWebhookSecret?: string | null
  fallbackWebhookSecrets?: string[]
  externalEntityId?: string | null
  /** Tenant attribution, so partners can credit the right tenant (pen-test F-D). */
  tenantId?: string | null
  tenantCode?: string | null
  paymentTypeCode?: string | null
  metadata: any
}) {
  // P1-4: Reject SSRF / private targets before enqueuing or delivering
  try {
    await validateSafeUrl(data.webhookUrl)
  } catch (urlErr: any) {
    console.error(`[Webhook] Refusing to send webhook to unsafe/internal URL: ${data.webhookUrl} (${urlErr?.message})`)
    // Permanent failure — a private/placeholder URL will never become valid.
    await recordNotificationFailure(data.paymentIntentId, `Unsafe webhook URL: ${urlErr?.message}`, {
      permanent: true,
    })
    return
  }

  const resolvedPaymentType =
    data.paymentTypeCode ?? (data.metadata?.paymentTypeCode as string | undefined) ?? null

  const payloadObject = {
    paymentIntentId: data.paymentIntentId,
    reference: data.reference,
    status: data.status,
    amount: data.amount,
    currency: data.currency,
    providerPaymentId: data.providerPaymentId,
    failureReason: data.failureReason ?? null,
    externalEntityId: data.externalEntityId ?? null,
    tenantId: data.tenantId ?? null,
    tenantCode: data.tenantCode ?? null,
    paymentType: resolvedPaymentType,
    paymentTypeCode: resolvedPaymentType,
    metadata: data.metadata ?? {},
  }

  const payloadString = JSON.stringify(payloadObject)

  // 1. Primary path: Deliver synchronously via safeFetch first so partner wallets
  // (e.g. Kunity savings & SMS balances) settle sub-second with an exact HMAC
  // signature and fresh timestamp, before returning from polling/webhook routes.
  try {
    console.log(`[Webhook] Delivering directly via safeFetch to ${data.webhookUrl}...`)
    const res = await postSignedPartnerWebhook({
      url: data.webhookUrl,
      payloadString,
      primarySecret: data.webhookSecret,
      fallbackSecret: data.fallbackWebhookSecret,
      fallbackSecrets: data.fallbackWebhookSecrets,
    })
    console.log(`[Webhook] Direct delivery response status: ${res.status} (${res.usedUrl})`)
    if (res.ok) {
      await recordNotificationDelivered(data.paymentIntentId, res.status, res.bodyText)
      return
    }

    const permanent = isPermanentHttpFailure(res.status)
    if (permanent) {
      await recordNotificationFailure(
        data.paymentIntentId,
        `HTTP ${res.status}${res.bodyText ? `: ${res.bodyText.slice(0, 500)}` : ''}`,
        { permanent: true, statusCode: res.status }
      )
      return
    }

    // Transient HTTP failure (408 / 429 / 5xx) — try QStash background retry or cron backoff.
    try {
      const client = getQStashClient()
      if (client) {
        await publishSignedViaQStash(client, res.usedUrl, payloadString, data.webhookSecret)
        await recordNotificationDispatched(data.paymentIntentId)
        return
      }
    } catch (qstashErr) {
      console.warn('[QStash] Fallback enqueue failed; using DB backoff worker:', qstashErr)
    }

    await recordNotificationFailure(
      data.paymentIntentId,
      `HTTP ${res.status}${res.bodyText ? `: ${res.bodyText.slice(0, 300)}` : ''}`,
      { permanent: false, statusCode: res.status }
    )
  } catch (directErr: any) {
    console.error('[Webhook] Direct safeFetch delivery error:', directErr)
    try {
      const client = getQStashClient()
      if (client) {
        await publishSignedViaQStash(client, data.webhookUrl, payloadString, data.webhookSecret)
        await recordNotificationDispatched(data.paymentIntentId)
        return
      }
    } catch (qstashErr) {
      console.warn('[QStash] Fallback enqueue after network error failed:', qstashErr)
    }
    await recordNotificationFailure(
      data.paymentIntentId,
      directErr instanceof Error ? directErr.message : 'Unknown direct delivery error'
    )
  }
}