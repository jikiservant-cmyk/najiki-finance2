import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'
import { completePayment, enqueueWebhookNotification } from '@/lib/payments'
import { verifyCronRequest } from '@/lib/qstash-verify'
import { loadTenantProviderCredentials } from '@/lib/tenant-credentials'
import { isConfirmedTerminalStatus } from '@/lib/payment-security'
import { PLATFORM_FEE_TYPES, resolvePartnerWebhookUrl } from '@/lib/constants'
import { fallbackSigningSecretsFromRow, webhookSecretFromRow } from '@/lib/application-auth'
import { safeJsonObject } from '@/lib/json'

async function handleCron(request: Request) {
  try {
    const isAuthorized = await verifyCronRequest(request)
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    // Parse query params for optional app-specific cron execution
    const url = new URL(request.url)
    const appCode = url.searchParams.get('app')
    
    // 1. Find all pending or processing payments older than 30 seconds
    const thirtySecondsAgo = new Date(Date.now() - 30_000)
    // 24h was too narrow: a payment the provider never resolved silently fell
    // out of the poller and was never reconciled again. It is now polled for a
    // week and anything older surfaces through /api/cron/alerts.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const pollCutoff = new Date(Date.now() - 30_000)
    const pendingPayments = await db.paymentIntent.findMany({
      where: {
        status: { in: ['pending', 'processing'] },
        createdAt: { lte: thirtySecondsAgo, gte: sevenDaysAgo },
        // Skip rows another worker polled in the last 30 seconds.
        OR: [{ lastPolledAt: null }, { lastPolledAt: { lte: pollCutoff } }],
        ...(appCode ? { application: { code: appCode } } : {}),
      },
      include: {
        provider: true,
        application: true,
        tenant: true,
        paymentType: true,
      },
      // Least-recently-polled first (never-polled rows first) so a backlog
      // cannot monopolise every batch.
      orderBy: [{ lastPolledAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: 50,
    })

    const pollResults: Array<{ id: string; reference: string; status: string; polledStatus?: string }> = []

    for (const payment of pendingPayments) {
      try {
        const isPlatformPayment = payment.paymentType && PLATFORM_FEE_TYPES.includes(payment.paymentType.code.toUpperCase())

        let customCredentials: any = undefined
        if (payment.tenantId && !isPlatformPayment) {
          customCredentials = await loadTenantProviderCredentials(payment.tenantId, payment.providerId)
          if (!customCredentials) {
            throw new Error(`Tenant credentials unavailable for payment ${payment.id}; refusing platform fallback`)
          }
        }

        const providerClient = getPaymentProvider(payment.provider.code, customCredentials)
        if (providerClient.checkPaymentStatus) {
          const result = await providerClient.checkPaymentStatus(
            payment.reference,
            payment.currency,
            payment.providerPaymentId || undefined
          )

          if (isConfirmedTerminalStatus(result, {
              amount: Number(payment.amount),
              currency: payment.currency,
              providerPaymentId: payment.providerPaymentId,
            })) {
            const completion = await completePayment({
              paymentIntentId: payment.id,
              status: result.status,
              providerPaymentId: result.providerPaymentId || payment.providerPaymentId || '',
              failureReason: result.failureReason,
              amount: Number(payment.amount),
              currency: payment.currency,
              rawProviderResponse: JSON.stringify(result),
              note: `QSTASH_CRON_POLL | Status: ${result.status}`,
            })

            // Only enqueue webhook if it wasn't already processed
            if (!completion.wasAlreadyProcessed) {
              // This must carry the same fields as the live webhook path in
              // /api/webhooks/[provider]/route.ts. It previously did not: the
              // payment type was omitted (so a partner relying on
              // `paymentTypeCode` saw null and could not tell a tithe from an
              // offering), the application-API-key fallback secrets were
              // omitted (so a partner verifying with its API key got a 401 and
              // no retry), and the URL was concatenated by hand instead of
              // going through resolvePartnerWebhookUrl (no legacy-path heal).
              await enqueueWebhookNotification({
                paymentIntentId: payment.id,
                reference: payment.reference,
                status: result.status,
                amount: Number(payment.amount),
                currency: payment.currency,
                providerPaymentId: result.providerPaymentId || payment.providerPaymentId || '',
                failureReason: result.failureReason,
                applicationId: payment.applicationId,
                webhookUrl: resolvePartnerWebhookUrl(payment.application),
                webhookSecret: webhookSecretFromRow(payment.application),
                fallbackWebhookSecret: payment.application.apiKey ?? null,
                fallbackWebhookSecrets: fallbackSigningSecretsFromRow(payment.application),
                externalEntityId: payment.externalEntityId,
                tenantId: payment.tenantId,
                tenantCode: payment.tenant?.code ?? null,
                paymentTypeCode:
                  payment.paymentType?.code ??
                  (safeJsonObject(payment.metadata)?.paymentTypeCode as string | undefined) ??
                  null,
                metadata: safeJsonObject(payment.metadata),
              })
            }

            pollResults.push({ id: payment.id, reference: payment.reference, status: 'resolved', polledStatus: result.status })
          } else {
            pollResults.push({ id: payment.id, reference: payment.reference, status: 'still_pending' })
          }
        }
      } catch (err: any) {
        pollResults.push({ id: payment.id, reference: payment.reference, status: 'error', polledStatus: err.message })
      } finally {
        await markPolled(db, payment.id)
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      polledPaymentsCount: pendingPayments.length,
      pollResults,
    })
  } catch (error: any) {
    console.error('QStash cron error:', error)
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
  }
}

// Vercel Cron issues GET requests; QStash and manual triggers use POST.
export async function GET(request: Request) {
  return handleCron(request)
}

export async function POST(request: Request) {
  return handleCron(request)
}

/**
 * Stamp the poll attempt so the next batch rotates to other payments.
 * Best effort: a failure here must not fail the whole cron run.
 */
async function markPolled(client: typeof db, paymentIntentId: string): Promise<void> {
  try {
    await client.paymentIntent.update({
      where: { id: paymentIntentId },
      data: { lastPolledAt: new Date() },
    })
  } catch (error) {
    console.error(`[poll] failed to record poll attempt for ${paymentIntentId}:`, error)
  }
}
