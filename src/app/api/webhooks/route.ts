/**
 * Webhook delivery log — the read side of the Webhooks page.
 *
 * This route never existed, although both the page and the data function did:
 * `getWebhookLogsData()` has been sitting in `src/lib/data.ts` with zero
 * callers, and `/webhooks` called this URL, got a 404, and swallowed it into an
 * empty list. The page therefore showed "no webhooks yet" forever instead of an
 * error, which is the worst possible failure mode for an audit view.
 *
 * Read-only, super-admin only, never cached.
 */

import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/auth'
import { getWebhookLogsData } from '@/lib/data'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Pending payment intents, for the simulation picker on the same page. */
async function getActivePayments(limit = 25) {
  const { db } = await import('@/lib/db')
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
      provider: { select: { code: true, name: true } },
    },
  })

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    // Prisma Decimal is not JSON-serialisable as-is.
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    // Masked: the browser must not receive customer numbers in cleartext.
    phoneNumber: row.phoneNumber ? `${row.phoneNumber.slice(0, 4)}****${row.phoneNumber.slice(-2)}` : null,
    provider: row.provider.code,
    providerCode: row.provider.code,
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

    const [logs, activePayments] = await Promise.all([
      getWebhookLogsData(limit),
      getActivePayments(),
    ])

    return NextResponse.json(
      {
        logs,
        activePayments,
        limit,
        // The page renders a count; make the truncation explicit rather than
        // letting it imply "this is everything".
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
