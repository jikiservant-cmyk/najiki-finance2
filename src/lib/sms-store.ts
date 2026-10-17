/**
 * SMS message store.
 *
 * Backed by Postgres (`sms_messages`), not by a single Redis hash.
 *
 * The previous implementation kept every message in one Redis hash and called
 * `HGETALL` on every delivery-report callback and dashboard load. That is O(N)
 * network traffic and O(N) Upstash command billing per request, has no
 * retention story, and made the delivery-report path scan every message ever
 * sent. Indexed Postgres lookups replace it.
 *
 * The database is also the durable outbox; Redis holds optional wake-up hints
 * only. See sms-queue.ts.
 */

import { randomBytes } from 'crypto'
import { db } from './db'

export type SmsStatus = 'queued' | 'pending' | 'unknown' | 'delivered' | 'failed'

export interface SmsRequest {
  id: string
  reference: string
  recipient: string
  message: string
  status: SmsStatus
  attemptCount: number
  applicationId?: string | null
  applicationCode: string
  providerCode: string
  cost: number
  senderId?: string | null
  providerMessageId?: string | null
  failureReason?: string | null
  nextAttemptAt?: Date | null
  notificationDeliveredAt?: Date | null
  notificationAttemptedAt?: Date | null
  createdAt: string
  updatedAt: string
}

/**
 * Placeholder unit cost, in UGX, until the provider reports the real one.
 *
 * UGX has no minor unit, so this is a whole-shilling figure. Exported so the
 * send routes and the reconciliation logic agree on the sentinel value.
 */
export const SMS_COST_PLACEHOLDER = 50

function newId(): string {
  return `sms_${randomBytes(10).toString('hex')}`
}

function newReference(): string {
  return `MSG-${Date.now().toString(16).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
}

/** Prisma rows are structurally compatible; the cast keeps callers honest. */
function toSms(row: unknown): SmsRequest {
  return row as SmsRequest
}

export class SmsDailyLimitError extends Error {
  readonly retryAfter: number
  constructor(retryAfter: number) {
    super('Daily SMS limit reached for this application')
    this.name = 'SmsDailyLimitError'
    this.retryAfter = retryAfter
  }
}

function newSmsData(params: {
  recipient: string; message: string; applicationCode: string; providerCode: string
  cost: number; applicationId?: string | null; senderId?: string | null; idempotencyKey?: string | null
}) {
  return {
    id: newId(), reference: newReference(), recipient: params.recipient,
    message: params.message, status: 'queued', attemptCount: 0,
    applicationId: params.applicationId ?? null, applicationCode: params.applicationCode,
    providerCode: params.providerCode, cost: params.cost,
    senderId: params.senderId ?? null, idempotencyKey: params.idempotencyKey ?? null,
  }
}

export class SmsIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used for a different SMS')
    this.name = 'SmsIdempotencyConflictError'
  }
}

export const smsStore = {
  /**
   * Create a message, or return the one a previous attempt with the same
   * idempotency key already created.
   *
   * The lookup-then-insert would race under concurrent retries, so the unique
   * constraint on (applicationId, idempotencyKey) is the real guard: whichever
   * insert loses gets a P2002 and reads back the winner's row. SMS costs money
   * per message, so a duplicate here is a duplicate charge.
   *
   * Returns `created: false` when an existing message was reused.
   */
  createOrGet: async (params: {
    recipient: string
    message: string
    applicationCode: string
    providerCode: string
    cost: number
    applicationId: string
    senderId?: string | null
    idempotencyKey?: string | null
    dailyLimit: number
  }): Promise<{ sms: SmsRequest; created: boolean }> => {
    const key = params.idempotencyKey?.trim() || null

    // The transaction-level advisory lock serializes all sends for this app.
    // Count and insert MUST use the same transaction/connection; a separate
    // count in the route let concurrent requests all observe quota remaining.
    return db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))::text', params.applicationId)
      // Measure the UTC day AFTER waiting for the lock; otherwise a request
      // stalled across midnight can be counted against yesterday but inserted
      // into today's quota. Persist that exact timestamp with the SMS.
      const now = new Date()
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
      if (key) {
        const existing = await tx.smsMessage.findFirst({
          where: { applicationId: params.applicationId, idempotencyKey: key },
        })
        if (existing) {
          if (existing.recipient !== params.recipient || existing.message !== params.message ||
              (existing.senderId ?? null) !== (params.senderId ?? null)) {
            throw new SmsIdempotencyConflictError()
          }
          return { sms: toSms(existing), created: false }
        }
      }
      const sentToday = await tx.smsMessage.count({
        where: { applicationId: params.applicationId, createdAt: { gte: dayStart, lt: dayEnd } },
      })
      if (sentToday >= params.dailyLimit) {
        throw new SmsDailyLimitError(Math.max(1, Math.ceil((dayEnd.getTime() - now.getTime()) / 1000)))
      }
      const sms = await tx.smsMessage.create({
        data: { ...newSmsData({ ...params, idempotencyKey: key }), createdAt: now },
      })
      return { sms: toSms(sms), created: true }
    }, { maxWait: 5_000, timeout: 10_000 })
  },

  /** A DB compare-and-swap is the send claim. Duplicate Redis jobs are harmless. */
  claimForSending: async (id: string): Promise<SmsRequest | null> => {
    const now = new Date()
    const result = await db.smsMessage.updateMany({
      where: { id, status: 'queued', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      data: { status: 'pending', attemptCount: { increment: 1 }, nextAttemptAt: null },
    })
    if (result.count !== 1) return null
    const row = await db.smsMessage.findUnique({ where: { id } })
    return row ? toSms(row) : null
  },

  /** Redis is only a wake-up hint; queued DB rows survive missing list writes. */
  getDueQueued: async (limit = 50): Promise<string[]> => {
    const rows = await db.smsMessage.findMany({
      where: { status: 'queued', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
      select: { id: true }, orderBy: { createdAt: 'asc' }, take: limit,
    })
    return rows.map((row) => row.id)
  },

  /** Do not overwrite a terminal DLR that arrived before the send response. */
  recordProviderAcceptance: async (id: string, providerMessageId: string | undefined): Promise<boolean> => {
    const result = await db.smsMessage.updateMany({
      where: { id, status: 'pending' },
      data: { ...(providerMessageId ? { providerMessageId } : {}), failureReason: null },
    })
    return result.count === 1
  },

  /** Explicit provider rejection is safe to fail; transport exceptions are NOT. */
  failExplicitly: async (id: string): Promise<boolean> => {
    const result = await db.smsMessage.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'failed', failureReason: 'Provider rejected SMS' },
    })
    return result.count === 1
  },

  /** A missing/late DLR is unknown, never delivered and never auto-retried. */
  markStalePendingUnknown: async (hours = 48): Promise<number> => {
    const result = await db.smsMessage.updateMany({
      where: { status: 'pending', updatedAt: { lt: new Date(Date.now() - hours * 60 * 60 * 1000) } },
      data: { status: 'unknown' },
    })
    return result.count
  },

  getPendingTerminalNotifications: async (limit = 20): Promise<SmsRequest[]> => {
    const rows = await db.smsMessage.findMany({
      where: { status: { in: ['delivered', 'failed'] }, notificationDeliveredAt: null },
      // Never let an unavailable endpoint monopolize the first page forever.
      orderBy: { notificationAttemptedAt: { sort: 'asc', nulls: 'first' } }, take: limit,
    })
    return (rows as unknown[]).map(toSms)
  },

  markNotificationAttempted: async (id: string, status: SmsStatus): Promise<void> => {
    await db.smsMessage.updateMany({
      where: { id, status, notificationDeliveredAt: null },
      data: { notificationAttemptedAt: new Date() },
    })
  },

  markNotificationDelivered: async (id: string, status: SmsStatus): Promise<void> => {
    await db.smsMessage.updateMany({
      where: { id, status, notificationDeliveredAt: null },
      data: { notificationDeliveredAt: new Date() },
    })
  },

  /** Only a matching provider ID may transition a nonterminal message to terminal. */
  applyDeliveryReport: async (id: string, providerMessageId: string, status: 'delivered' | 'failed'): Promise<boolean> => {
    const result = await db.smsMessage.updateMany({
      where: { id, providerMessageId, status: { in: ['pending', 'unknown'] } },
      data: { status },
    })
    return result.count === 1
  },

  /** Store an authenticated report BEFORE looking up the SMS. First terminal
   * report wins, including when concurrent duplicate callbacks arrive.
   */
  rememberDeliveryReport: async (providerMessageId: string, status: 'delivered' | 'failed'): Promise<void> => {
    try {
      await db.smsDeliveryReport.create({ data: { providerMessageId, status } })
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error
    }
  },

  /** Reconcile even when a callback raced with recordProviderAcceptance(). */
  resolveDeliveryReport: async (providerMessageId: string): Promise<SmsRequest | null> => {
    const report = await db.smsDeliveryReport.findUnique({ where: { providerMessageId } })
    if (!report || report.appliedAt) return null
    const match = await smsStore.findByProviderMessageId(providerMessageId)
    if (!match || !['pending', 'unknown', 'delivered', 'failed'].includes(match.status)) {
      await db.smsDeliveryReport.updateMany({
        where: { providerMessageId, appliedAt: null }, data: { lastCheckedAt: new Date() },
      })
      return null
    }
    // CAS prevents contradictory/duplicate DLRs from rewriting terminal rows.
    const changed = await smsStore.applyDeliveryReport(match.id, providerMessageId, report.status as 'delivered' | 'failed')
    await db.smsDeliveryReport.updateMany({
      where: { providerMessageId, appliedAt: null }, data: { appliedAt: new Date() },
    })
    return changed ? smsStore.get(match.id) : null
  },

  getUnappliedDeliveryReportIds: async (limit = 20): Promise<string[]> => {
    const rows = await db.smsDeliveryReport.findMany({
      where: { appliedAt: null },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      select: { providerMessageId: true }, take: limit,
    })
    return rows.map((row) => row.providerMessageId)
  },

  pruneDeliveryReports: async (days = 7): Promise<number> => {
    const expired = await db.smsDeliveryReport.findMany({
      where: { receivedAt: { lt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } },
      select: { providerMessageId: true }, orderBy: { receivedAt: 'asc' }, take: 200,
    })
    if (!expired.length) return 0
    const result = await db.smsDeliveryReport.deleteMany({
      where: { providerMessageId: { in: expired.map((row) => row.providerMessageId) } },
    })
    return result.count
  },

  get: async (id: string): Promise<SmsRequest | null> => {
    if (!id) return null
    const row = await db.smsMessage.findUnique({ where: { id } })
    return row ? toSms(row) : null
  },

  /** Most recent messages, newest first. Bounded — the dashboard must not drain the table. */
  getRecent: async (limit = 200): Promise<SmsRequest[]> => {
    const rows = await db.smsMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 1000),
    })
    return (rows as unknown[]).map(toSms)
  },

  /** Aggregates for the dashboard, computed by the database rather than in JS. */
  getStats: async (): Promise<{
    total: number
    delivered: number
    pending: number
    failed: number
    unknown: number
    queued: number
    deliveredCost: number
    deliveryRate: string
  }> => {
    const [total, grouped, costRows] = await Promise.all([
      db.smsMessage.count(),
      db.smsMessage.groupBy({ by: ['status'], _count: true }),
      db.smsMessage.aggregate({ _sum: { cost: true }, where: { status: 'delivered' } }),
    ])

    const counts: Record<string, number> = {}
    for (const row of grouped as Array<{ status: string; _count: number }>) {
      counts[String(row.status)] = row._count
    }

    const delivered = counts.delivered ?? 0
    return {
      total,
      delivered,
      pending: counts.pending ?? 0,
      failed: counts.failed ?? 0,
      unknown: counts.unknown ?? 0,
      queued: counts.queued ?? 0,
      deliveredCost: Number((costRows as { _sum?: { cost?: number | null } })?._sum?.cost ?? 0),
      deliveryRate: total > 0 ? ((delivered / total) * 100).toFixed(1) : '0',
    }
  },

  /**
   * Replace the placeholder cost with what the provider actually charged.
   *
   * `cost` was hardcoded to 50 at creation and the real figure returned by the
   * provider was discarded, yet the dashboard sums this column and labels it
   * "Total Cost". Real cost varies by destination, by sender ID and by message
   * length (a long SMS is billed as multiple parts), so the placeholder was
   * wrong in every direction.
   *
   * Only overwrites a zero/placeholder value: a settled cost is not re-derived
   * from a later retry, which could double-count parts.
   */
  updateProviderCost: async (id: string, cost: number | null | undefined): Promise<boolean> => {
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return false
    const rounded = Math.round(cost)

    try {
      const result = await db.smsMessage.updateMany({
        where: { id, cost: SMS_COST_PLACEHOLDER },
        data: { cost: rounded },
      })
      return result.count > 0
    } catch {
      return false
    }
  },

  /**
   * Delivery-report lookup: O(1) on the provider message id index.
   * Replaces "fetch every SMS ever sent and scan in JS".
   */
  findByProviderMessageId: async (providerMessageId: string): Promise<SmsRequest | null> => {
    if (!providerMessageId) return null
    const rows = await db.smsMessage.findMany({ where: { providerMessageId }, take: 2 })
    // A non-unique provider ID is ambiguous; never guess the application.
    return rows.length === 1 ? toSms(rows[0]) : null
  },

}
