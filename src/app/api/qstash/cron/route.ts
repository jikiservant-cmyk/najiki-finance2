import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'
import { completePayment, enqueueWebhookNotification, resolvePaymentCredentials } from '@/lib/payments'
import { verifyCronRequest } from '@/lib/qstash-verify'
import { webhookSecretFromRow } from '@/lib/application-auth'
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
    const skippedIsolation: Array<{
      reference: string
      tenantId: string | null
      reason: string
      missing?: string[]
    }> = []

    for (const payment of pendingPayments) {
      try {
        // Tenant isolation (pen-test F-2b) — see the same comment in
        // src/app/api/cron/sync-payments/route.ts. A tenant payment with no
        // usable credential row is SKIPPED, never polled on platform
        // credentials: the webhook path refuses it, so polling it here would
        // settle it against the platform account instead.
        const resolved = await resolvePaymentCredentials({
          tenantId: payment.tenantId,
          providerId: payment.providerId,
          paymentType: payment.paymentType,
        })

        if (!resolved.ok) {
          const detail =
            resolved.reason === 'incomplete-credentials'
              ? `incomplete credentials (missing: ${resolved.missing?.join(', ')})`
              : 'no active credentials configured'
          console.error(
            `[qstash-cron] Skipping ${payment.reference} (tenant ${payment.tenantId}): ${detail}. ` +
              'Refusing to poll on platform credentials — this is a tenant collection.'
          )
          skippedIsolation.push({
            reference: payment.reference,
            tenantId: payment.tenantId,
            reason: resolved.reason,
            missing: resolved.missing,
          })
          continue
        }

        const providerClient = getPaymentProvider(payment.provider.code, resolved.credentials)
        if (providerClient.checkPaymentStatus) {
          const result = await providerClient.checkPaymentStatus(
            payment.reference,
            payment.currency,
            payment.providerPaymentId || undefined
          )

          if (result && (result.status === 'success' || result.status === 'failed')) {
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
              await enqueueWebhookNotification({
                paymentIntentId: payment.id,
                reference: payment.reference,
                status: result.status,
                amount: Number(payment.amount),
                currency: payment.currency,
                providerPaymentId: result.providerPaymentId || payment.providerPaymentId || '',
                failureReason: result.failureReason,
                applicationId: payment.applicationId,
                webhookUrl: `${payment.application.baseUrl}${payment.application.webhookPath}`,
                webhookSecret: webhookSecretFromRow(payment.application),
              externalEntityId: payment.externalEntityId,
              tenantId: payment.tenantId,
              tenantCode: payment.tenant?.code ?? null,
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
      skippedIsolationCount: skippedIsolation.length,
      ...(skippedIsolation.length > 0 ? { skippedIsolation } : {}),
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
