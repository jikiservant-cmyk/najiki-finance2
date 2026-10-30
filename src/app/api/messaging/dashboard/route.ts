import { NextResponse } from 'next/server'
import { smsStore } from '@/lib/sms-store'
import { db } from '@/lib/db'
import { requireSuperAdmin } from '@/lib/auth'
import { maskRecipient } from '@/lib/recipient-mask'

type GroupRow = { _count: number; _sum?: { cost?: number | null } }
type AppGroupRow = GroupRow & { applicationCode: string; status: string }
type ProviderGroupRow = GroupRow & { providerCode: string; status: string }
type DailyRow = { date: string; volume: bigint | number; failed: bigint | number }

export async function GET() {
  try {
    await requireSuperAdmin()

    const since = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000)
    since.setHours(0, 0, 0, 0)

    const [stats, recent, apps, byApp, byProvider, byDay] = await Promise.all([
      smsStore.getStats(),
      smsStore.getRecent(15),
      db.application.findMany({ select: { code: true, name: true } }),
      db.smsMessage.groupBy({
        by: ['applicationCode', 'status'],
        _count: true,
        _sum: { cost: true },
      }),
      db.smsMessage.groupBy({
        by: ['providerCode', 'status'],
        _count: true,
        _sum: { cost: true },
      }),
      db.$queryRawUnsafe(
        `SELECT TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS date,
                COUNT(*) AS volume,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed
           FROM sms_messages
          WHERE created_at >= $1
          GROUP BY 1
          ORDER BY 1`,
        since
      ) as Promise<DailyRow[]>,
    ])

    const appMap = new Map(
      (apps as Array<{ code: string; name: string }>).map((a) => [a.code.toLowerCase(), a.name])
    )

    const fold = <T extends { _count: number; _sum?: { cost?: number | null } }>(
      rows: T[],
      keyOf: (row: T) => string,
      isDelivered: (row: T) => boolean
    ): Map<string, { count: number; cost: number }> => {
      const out = new Map<string, { count: number; cost: number }>()
      for (const row of rows) {
        const key = keyOf(row).toLowerCase()
        const current = out.get(key) || { count: 0, cost: 0 }
        out.set(key, {
          count: current.count + Number(row._count || 0),
          cost: current.cost + (isDelivered(row) ? Number(row._sum?.cost ?? 0) : 0),
        })
      }
      return out
    }

    const appUsageMap = fold(
      byApp as unknown as AppGroupRow[],
      (row) => row.applicationCode,
      (row) => row.status === 'delivered'
    )
    const appUsage = Array.from(appUsageMap.entries()).map(([code, value]) => ({
      code,
      name: appMap.get(code) || code.toUpperCase(),
      count: value.count,
      cost: value.cost,
    }))

    const providerUsageMap = fold(
      byProvider as unknown as ProviderGroupRow[],
      (row) => row.providerCode,
      (row) => row.status === 'delivered'
    )
    const providerUsage = Array.from(providerUsageMap.entries()).map(([code, value]) => ({
      code,
      name: code === 'africastalking' ? "Africa's Talking" : code.toUpperCase(),
      count: value.count,
      cost: value.cost,
    }))

    // Fill the 14-day window so the chart always has a full axis.
    const dayMap = new Map<string, { volume: number; failed: number }>()
    const now = new Date()
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(now.getDate() - i)
      dayMap.set(d.toISOString().split('T')[0], { volume: 0, failed: 0 })
    }
    for (const row of (byDay || []) as DailyRow[]) {
      dayMap.set(row.date, {
        volume: Number(row.volume || 0),
        failed: Number(row.failed || 0),
      })
    }
    const dailyVolume = Array.from(dayMap.entries()).map(([date, value]) => ({ date, ...value }))

    const recentMessages = recent.map((m) => ({
      id: m.id,
      reference: m.reference,
      application: appMap.get(String(m.applicationCode).toLowerCase()) || String(m.applicationCode).toUpperCase(),
      applicationCode: m.applicationCode,
      // Recipients are not returned in cleartext to the browser.
      recipient: maskRecipient(m.recipient),
      status: m.status,
      providerCode: m.providerCode === 'africastalking' ? "Africa's Talking" : String(m.providerCode).toUpperCase(),
      createdAt: m.createdAt,
      cost: m.status === 'delivered' ? m.cost : 0,
      // These three are what turn a red badge into a diagnosis: whether the
      // provider was ever reached (providerMessageId), how many times we tried
      // (attemptCount), and why it failed (failureReason). They were stored but
      // never returned, so an operator could see "failed" and nothing else.
      attemptCount: m.attemptCount ?? 0,
      providerMessageId: m.providerMessageId ?? null,
      failureReason: m.failureReason ?? null,
      // The sender ID the message was dispatched with, or null when the
      // provider's account default was used. Partner sends may supply one and
      // dashboard sends never do, so without this the two are
      // indistinguishable in a list that otherwise looks identical — and an
      // unapproved sender ID is accepted by the provider and then never
      // routed, which reads as "sent but the phone never rang".
      senderId: m.senderId ?? null,
    }))

    return NextResponse.json(
      {
        totalSent: stats.total,
        totalCost: stats.deliveredCost,
        statusCounts: {
          delivered: stats.delivered,
          pending: stats.pending,
          failed: stats.failed,
          unknown: stats.unknown,
          queued: stats.queued,
        },
        deliveryRate: stats.deliveryRate,
        appUsage,
        providerUsage,
        dailyVolume,
        recentMessages,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  } catch (error: any) {
    const message = error?.message || ''
    if (message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (message.includes('Forbidden') || message.includes('Super Admin')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('Messaging dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
