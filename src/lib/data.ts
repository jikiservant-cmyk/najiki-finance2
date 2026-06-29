// data.ts — fixed version
// Changes from current repo:
//  FIX 1: Daily revenue loop (28 sequential queries) → single SQL GROUP BY DATE
//  FIX 2: getPaymentsWithApps() removed — was a full-table findMany with no filter
//  FIX 3: getPaymentByReference uses findUnique (not findFirst) to hit @unique index
//  FIX 4: getPendingNotifications adds nextRetryAt filter so only due rows are loaded

import { db } from './db'

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

export async function getDashboardData() {
  const [
    totalPayments,
    totalRevenueData,
    statusCountData,
    appRevenueData,
    providerRevenueData,
    recentIntents,
    notificationsData,
    tenantRevenueData,
    appFunnelData,
    // FIX 1: one SQL query with GROUP BY DATE replaces the 28-query JS for-loop
    dailyRevenueRaw,
  ] = await Promise.all([
    db.paymentIntent.count(),

    db.paymentIntent.aggregate({
      where: { status: 'success' },
      _sum: { amount: true },
    }),

    db.paymentIntent.groupBy({
      by: ['status'],
      _count: true,
    }),

    db.paymentIntent.groupBy({
      by: ['applicationId'],
      where: { status: 'success' },
      _sum: { amount: true },
      _count: true,
    }),

    db.paymentIntent.groupBy({
      by: ['providerId'],
      where: { status: 'success' },
      _sum: { amount: true },
      _count: true,
    }),

    db.paymentIntent.findMany({
      include: {
        application: true,
        tenant: true,
        provider: true,
        paymentType: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),

    db.internalNotification.groupBy({
      by: ['status'],
      _count: true,
    }),

    db.paymentIntent.groupBy({
      by: ['tenantId', 'applicationId'],
      where: { status: 'success', tenantId: { not: null } },
      _sum: { amount: true },
      _count: true,
    }),

    db.paymentIntent.groupBy({
      by: ['applicationId', 'status'],
      _count: true,
    }),

    // FIX 1: single raw SQL query — DB does the date bucketing and summing
    // replaces: for (let d = 13; d >= 0; d--) { await Promise.all([aggregate, count]) }
    // which fired 14 × 2 = 28 sequential round-trips per dashboard load
    db.$queryRaw<{ date: string; revenue: number; count: bigint; failed: bigint }[]>`
      SELECT
        TO_CHAR(DATE_TRUNC('day', COALESCE(completed_at, created_at)), 'YYYY-MM-DD') AS date,
        COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0)         AS revenue,
        COUNT(CASE WHEN status = 'success' THEN 1 END)                                AS count,
        COUNT(CASE WHEN status = 'failed'  THEN 1 END)                                AS failed
      FROM payment_intents
      WHERE created_at >= NOW() - INTERVAL '14 days'
      GROUP BY DATE_TRUNC('day', COALESCE(completed_at, created_at))
      ORDER BY date ASC
    `,
  ])

  const totalRevenue = totalRevenueData._sum.amount || 0

  // Status counts
  const statusCounts: Record<string, number> = {
    success: 0, pending: 0, processing: 0,
    failed: 0, expired: 0, cancelled: 0,
  }
  for (const item of statusCountData) {
    statusCounts[item.status] = item._count
  }

  const successRate =
    totalPayments > 0
      ? ((statusCounts.success / totalPayments) * 100).toFixed(1)
      : '0'

  // App revenue — fetch names in one query
  const appIds = appRevenueData.map((i) => i.applicationId)
  const apps = await db.application.findMany({ where: { id: { in: appIds } } })
  const appMap = new Map(apps.map((a) => [a.id, a]))

  const appRevenue = appRevenueData.map((i) => ({
    code: appMap.get(i.applicationId)?.code || 'unknown',
    name: appMap.get(i.applicationId)?.name || 'Unknown',
    revenue: Number(i._sum.amount || 0),
    count: i._count,
    successCount: i._count,
  }))

  // Provider revenue
  const providerIds = providerRevenueData.map((i) => i.providerId)
  const providers = await db.provider.findMany({ where: { id: { in: providerIds } } })
  const providerMap = new Map(providers.map((p) => [p.id, p]))

  const providerRevenue = providerRevenueData.map((i) => ({
    code: providerMap.get(i.providerId)?.code || 'unknown',
    name: providerMap.get(i.providerId)?.name || 'Unknown',
    revenue: Number(i._sum.amount || 0),
    count: i._count,
  }))

  // Tenant revenue
  const tenantIds = tenantRevenueData.map((i) => i.tenantId!).filter(Boolean)
  const tenants = await db.tenant.findMany({
    where: { id: { in: tenantIds } },
    include: { application: true },
  })
  const tenantMap = new Map(tenants.map((t) => [t.id, t]))

  const tenantRevenue = tenantRevenueData.map((i) => {
    const tenant = tenantMap.get(i.tenantId!)
    return {
      code: tenant?.code || 'unknown',
      name: tenant?.name || 'Unknown',
      application: tenant?.application.code || 'unknown',
      revenue: Number(i._sum.amount || 0),
      count: i._count,
    }
  })

  // FIX 1: daily revenue from the single SQL query above
  // BigInt → number conversion for JSON serialisation
  const dailyRevenue = dailyRevenueRaw.map((r) => ({
    date: r.date,
    revenue: Number(r.revenue),
    count: Number(r.count),
    failed: Number(r.failed),
  }))

  // Payment funnel
  const funnel: Record<string, {
    application: string; total: number; success: number
    failed: number; inFlight: number; rate: string
  }> = {}
  for (const item of appFunnelData) {
    const app = appMap.get(item.applicationId)
    if (!app) continue
    const key = app.code
    if (!funnel[key]) {
      funnel[key] = { application: app.name, total: 0, success: 0, failed: 0, inFlight: 0, rate: '0' }
    }
    funnel[key].total += item._count
    if (item.status === 'success') funnel[key].success += item._count
    if (item.status === 'failed') funnel[key].failed += item._count
    if (item.status === 'pending' || item.status === 'processing') funnel[key].inFlight += item._count
  }
  for (const key of Object.keys(funnel)) {
    const f = funnel[key]
    f.rate = f.total > 0 ? ((f.success / f.total) * 100).toFixed(1) : '0'
  }

  // Recent intents
  const recentIntentsFormatted = recentIntents.map((i) => ({
    id: i.id,
    reference: i.reference,
    application: i.application.name,
    applicationCode: i.application.code,
    tenantName: i.tenant?.name || null,
    tenantCode: i.tenant?.code || null,
    paymentType: i.paymentType?.code || null,
    amount: Number(i.amount),
    currency: i.currency,
    status: i.status,
    provider: i.provider.name,
    providerCode: i.provider.code,
    phoneNumber: i.phoneNumber,
    externalEntityId: i.externalEntityId,
    failureReason: i.failureReason,
    createdAt: i.createdAt,
    completedAt: i.completedAt,
  }))

  // Notification stats
  const notifStats = { total: 0, delivered: 0, pending: 0, retrying: 0, exhausted: 0 }
  for (const item of notificationsData) {
    notifStats.total += item._count
    if (item.status === 'delivered') notifStats.delivered = item._count
    if (item.status === 'pending') notifStats.pending = item._count
    if (item.status === 'failed_retrying') notifStats.retrying = item._count
    if (item.status === 'failed_exhausted') notifStats.exhausted = item._count
  }

  return {
    totalRevenue,
    statusCounts,
    successRate,
    appRevenue,
    providerRevenue,
    tenantRevenue,
    dailyRevenue,
    funnel: Object.values(funnel),
    recentIntents: recentIntentsFormatted,
    totalPayments,
    notifStats,
  }
}

// ─── WEBHOOK LOGS ─────────────────────────────────────────────────────────────

export async function getWebhookLogsData(limit = 50) {
  const logs = await db.webhookLog.findMany({
    include: {
      provider: true,
      paymentIntent: { select: { reference: true, amount: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  return logs.map((l) => ({
    id: l.id,
    providerId: l.providerId,
    providerCode: l.provider.code,
    providerName: l.provider.name,
    paymentIntentId: l.paymentIntentId,
    payload: l.payload,
    headers: l.headers,
    signatureValid: l.signatureValid,
    processed: l.processed,
    processingError: l.processingError,
    createdAt: l.createdAt,
    payment: l.paymentIntent
      ? {
          reference: l.paymentIntent.reference,
          amount: Number(l.paymentIntent.amount),
          status: l.paymentIntent.status,
        }
      : null,
  }))
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

// FIX 4: add nextRetryAt filter — only load rows that are actually due now
// Previously: loaded ALL pending/retrying rows regardless of retry schedule
export async function getPendingNotifications() {
  return db.internalNotification.findMany({
    where: {
      status: { in: ['pending', 'failed_retrying'] },
      nextRetryAt: { lte: new Date() }, // only due rows — uses @@index([status, nextRetryAt])
    },
    include: {
      paymentIntent: { include: { application: true } },
      application: true,
    },
    orderBy: { nextRetryAt: 'asc' },
    take: 100, // hard cap — never drain unbounded in one cron tick
  })
}

// ─── PAYMENT HELPERS ──────────────────────────────────────────────────────────

// FIX 2: getPaymentsWithApps() REMOVED
// It did: db.paymentIntent.findMany({ include: everything }) — no filter, no limit.
// Every caller that wanted one payment loaded the ENTIRE table and did .find() in JS.
// Use getPaymentByReference(ref) instead — it's a single indexed O(1) lookup.

// FIX 3: findUnique (not findFirst) — hits the @unique index on reference directly
export async function getPaymentByReference(reference: string) {
  return db.paymentIntent.findUnique({
    where: { reference },
    include: {
      application: true,
      tenant: true,
      provider: true,
      paymentType: true,
    },
  })
}

export async function updatePaymentStatus(
  reference: string,
  status: string,
  externalRef?: string,
  metadata?: string
) {
  const normalizedStatus = status.toLowerCase()
  return db.paymentIntent.update({
    where: { reference }, // update (not updateMany) — reference is @unique
    data: {
      status: normalizedStatus,
      ...(externalRef && { externalEntityId: externalRef }),
      ...(normalizedStatus === 'success' || normalizedStatus === 'failed'
        ? { completedAt: new Date() }
        : {}),
      ...(metadata && { failureReason: metadata }),
    },
  })
}

export async function createWebhookLog(data: {
  provider: string
  eventType: string
  payload: string
  signature: string
  signatureHash: string
  verified: boolean
  processed: boolean
}) {
  let provider = await db.provider.findFirst({ where: { code: data.provider.toLowerCase() } })
  if (!provider) {
    provider = await db.provider.findFirst({ where: { isActive: true } })
  }
  if (!provider) {
    throw new Error(`No provider found for webhook: ${data.provider}`)
  }

  return db.webhookLog.create({
    data: {
      payload: data.payload,
      headers: JSON.stringify({ signature: data.signature, eventType: data.eventType }),
      signatureHash: data.signatureHash,
      signatureValid: data.verified,
      processed: data.processed,
      providerId: provider.id,
    },
  })
}

export async function updateWebhookLog(
  id: string,
  data: { paymentId?: string; error?: string; processed?: boolean }
) {
  return db.webhookLog.update({
    where: { id },
    data: {
      ...(data.paymentId && { paymentIntentId: data.paymentId }),
      ...(data.error && { processingError: data.error }),
      ...(data.processed !== undefined && { processed: data.processed }),
    },
  })
}

export async function createPaymentTransaction(data: {
  paymentId: string
  type: string
  status: string
  amount: number
  metadata: string
}) {
  return db.paymentTransaction.create({
    data: {
      paymentIntentId: data.paymentId,
      status: data.status.toLowerCase(),
      rawProviderResponse: data.metadata,
      note: data.type,
    },
  })
}
