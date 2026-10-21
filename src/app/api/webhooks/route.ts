/**
 * Complete End-to-End Webhook Diagnostics & Live Settlement Endpoint (`GET /api/webhooks`).
 *
 * Exposes raw backend messages for BOTH live hops AND immediately reconciles any
 * in-flight payments + partner notifications so refreshing `/api/webhooks` settles
 * pending transactions and shows the exact wire JSON from both LivePay and Kunity/ChurchOS:
 *
 *   - `liveReconciliation`: live `/api/transaction-status` check + raw LivePay JSON
 *   - `hop1_livepayToNajiki` (`logs`): every inbound webhook hit from LivePay -> Najiki
 *   - `hop2_najikiToPartnerApps` (`outboundNotifications`): every outbound webhook from
 *     Najiki -> Partner App (`kunitydev.netlify.app`, ChurchOS, etc.), with exact HTTP
 *     status code, raw response JSON/body, sent payload, and target URL
 *   - `recentPaymentAuditTrail`: recent `payment_transactions` audit rows
 *   - `activePayments`: remaining `pending` / `processing` payment intents
 *
 * Super-admin only, never cached.
 */

import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/auth'
import { getWebhookLogsData } from '@/lib/data'
import { db } from '@/lib/db'
import { reconcileProcessingPayments } from '@/lib/reconcile-payments'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function tryParseJson(raw: string | null | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Pending payment intents, for the simulation picker & live status view. */
async function getActivePayments(limit = 25) {
  const rows = await db.paymentIntent.findMany({
    where: { status: { in: ['pending', 'processing'] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      reference: true,
      amount: true,
      currency: true,
      status: true,
      phoneNumber: true,
      providerPaymentId: true,
      failureReason: true,
      createdAt: true,
      lastPolledAt: true,
      provider: { select: { code: true, name: true } },
    },
  })

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    phoneNumber: row.phoneNumber
      ? `${row.phoneNumber.slice(0, 4)}****${row.phoneNumber.slice(-2)}`
      : null,
    provider: row.provider.code,
    providerCode: row.provider.code,
    providerPaymentId: row.providerPaymentId,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    lastPolledAt: row.lastPolledAt,
  }))
}

async function getOutboundNotificationsData(limit = 50) {
  const rows = await db.internalNotification.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      application: {
        select: { code: true, name: true, baseUrl: true, webhookPath: true },
      },
      paymentIntent: {
        select: {
          reference: true,
          amount: true,
          currency: true,
          status: true,
          providerPaymentId: true,
          externalEntityId: true,
          completedAt: true,
          tenant: { select: { code: true, name: true } },
        },
      },
    },
  })

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    lastAttemptAt: row.lastAttemptAt,
    nextRetryAt: row.nextRetryAt,
    applicationCode: row.application.code,
    applicationName: row.application.name,
    tenantCode: row.paymentIntent.tenant?.code ?? null,
    reference: row.paymentIntent.reference,
    paymentStatus: row.paymentIntent.status,
    amount: Number(row.paymentIntent.amount),
    currency: row.paymentIntent.currency,
    providerPaymentId: row.paymentIntent.providerPaymentId,
    targetUrl: row.url,
    deliveryStatus: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    responseHttpStatus: row.lastResponseStatus,
    rawBackendResponse: tryParseJson(row.lastResponseBody),
    rawBackendResponseText: row.lastResponseBody,
    sentPayload: tryParseJson(row.payload),
  }))
}

async function getRecentPaymentAuditTrail(limit = 25) {
  const rows = await db.paymentTransaction.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      paymentIntent: {
        select: {
          reference: true,
          amount: true,
          currency: true,
          status: true,
          tenant: { select: { code: true } },
        },
      },
    },
  })

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    reference: row.paymentIntent.reference,
    tenantCode: row.paymentIntent.tenant?.code ?? null,
    intentStatus: row.paymentIntent.status,
    amount: Number(row.paymentIntent.amount),
    currency: row.paymentIntent.currency,
    eventStatus: row.status,
    note: row.note,
    rawProviderResponse: tryParseJson(row.rawProviderResponse),
  }))
}

export async function GET(request: Request) {
  try {
    await requireSuperAdmin()

    const { searchParams } = new URL(request.url)
    const requested = Number(searchParams.get('limit') || DEFAULT_LIMIT)
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
      : DEFAULT_LIMIT

    const skipReconcile = searchParams.get('reconcile') === '0'
    const liveReconciliation = skipReconcile
      ? null
      : await reconcileProcessingPayments({
          limit: 15,
          minAgeMs: 0,
          minPollIntervalMs: 0,
          budgetMs: 12_000,
        })

    const [logs, outboundNotifications, recentPaymentAuditTrail, activePayments] =
      await Promise.all([
        getWebhookLogsData(limit),
        getOutboundNotificationsData(limit),
        getRecentPaymentAuditTrail(25),
        getActivePayments(),
      ])

    const hop1_livepayToNajiki = logs.map((l) => ({
      ...l,
      parsedHeaders: tryParseJson(l.headers),
      parsedPayload: tryParseJson(l.payload),
    }))

    return NextResponse.json(
      {
        summary: {
          hop1_inboundTotal: hop1_livepayToNajiki.length,
          hop1_signatureVerified: hop1_livepayToNajiki.filter((l) => l.signatureValid).length,
          hop1_processed: hop1_livepayToNajiki.filter((l) => l.processed).length,
          hop2_outboundTotal: outboundNotifications.length,
          hop2_delivered: outboundNotifications.filter((n) => n.deliveryStatus === 'delivered').length,
          hop2_failed: outboundNotifications.filter((n) =>
            n.deliveryStatus.startsWith('failed')
          ).length,
          activePendingCount: activePayments.length,
        },
        liveReconciliation,
        hop1_livepayToNajiki,
        hop2_najikiToPartnerApps: outboundNotifications,
        recentPaymentAuditTrail,
        // Preserved top-level fields for `/webhooks` UI page compatibility:
        logs,
        outboundNotifications,
        activePayments,
        limit,
        truncated: logs.length >= limit,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  } catch (error: any) {
    const message = error?.message || ''
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (message.includes('Forbidden') || message.includes('Super Admin')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('Webhook logs error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
