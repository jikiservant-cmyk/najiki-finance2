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
 * The Redis list is still used as the work queue (see sms-queue.ts) — only the
 * message records moved.
 */

import { randomBytes } from 'crypto'
import { db } from './db'
import { normalizePhoneNumber } from './redact'

export type SmsStatus = 'queued' | 'pending' | 'delivered' | 'failed'

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
  createdAt: string
  updatedAt: string
}

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

function normalizeStatus(value: unknown): SmsStatus {
  const status = String(value || '').toLowerCase()
  if (status === 'pending' || status === 'delivered' || status === 'failed' || status === 'queued') {
    return status
  }
  return 'queued'
}

export const smsStore = {
  create: async (params: {
    recipient: string
    message: string
    applicationCode: string
    providerCode: string
    cost: number
    applicationId?: string | null
    senderId?: string | null
    idempotencyKey?: string | null
  }): Promise<SmsRequest> => {
    const row = await db.smsMessage.create({
      data: {
        id: newId(),
        reference: newReference(),
        recipient: params.recipient,
        message: params.message,
        status: 'queued',
        attemptCount: 0,
        applicationId: params.applicationId ?? null,
        applicationCode: params.applicationCode,
        providerCode: params.providerCode,
        cost: params.cost,
        senderId: params.senderId ?? null,
        idempotencyKey: params.idempotencyKey ?? null,
      },
    })
    return toSms(row)
  },

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
    applicationId?: string | null
    senderId?: string | null
    idempotencyKey?: string | null
  }): Promise<{ sms: SmsRequest; created: boolean }> => {
    const key = params.idempotencyKey?.trim() || null

    if (key && params.applicationId) {
      const existing = await db.smsMessage.findFirst({
        where: { applicationId: params.applicationId, idempotencyKey: key },
      })
      if (existing) return { sms: toSms(existing), created: false }
    }

    try {
      const sms = await smsStore.create({ ...params, idempotencyKey: key })
      return { sms, created: true }
    } catch (error: any) {
      // P2002: the unique constraint fired, so a concurrent retry won the race.
      if (error?.code !== 'P2002' || !key || !params.applicationId) throw error

      const winner = await db.smsMessage.findFirst({
        where: { applicationId: params.applicationId, idempotencyKey: key },
      })
      if (!winner) throw error
      return { sms: toSms(winner), created: false }
    }
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
      queued: counts.queued ?? 0,
      deliveredCost: Number((costRows as { _sum?: { cost?: number | null } })?._sum?.cost ?? 0),
      deliveryRate: total > 0 ? ((delivered / total) * 100).toFixed(1) : '0',
    }
  },

  updateStatus: async (
    id: string,
    status: SmsStatus,
    failureReason?: string,
    attemptCount?: number,
    providerMessageId?: string
  ): Promise<SmsRequest | null> => {
    const data: Record<string, unknown> = { status: normalizeStatus(status) }
    if (failureReason !== undefined) data.failureReason = failureReason
    if (typeof attemptCount === 'number') data.attemptCount = attemptCount
    if (providerMessageId) data.providerMessageId = providerMessageId

    try {
      const row = await db.smsMessage.update({ where: { id }, data })
      return toSms(row)
    } catch {
      // Row removed or never existed — callers treat null as "not found".
      return null
    }
  },

  /**
   * Delivery-report lookup: O(1) on the provider message id index.
   * Replaces "fetch every SMS ever sent and scan in JS".
   */
  findByProviderMessageId: async (providerMessageId: string): Promise<SmsRequest | null> => {
    if (!providerMessageId) return null
    const row = await db.smsMessage.findFirst({
      where: { providerMessageId },
      orderBy: { createdAt: 'desc' },
    })
    return row ? toSms(row) : null
  },

  /**
   * Fallback delivery-report lookup for providers that only echo the MSISDN.
   * Bounded to recent, still-unresolved messages and matched on normalised
   * digits (the stored value may be E.164 while the callback is local format).
   */
  findRecentUnresolvedByRecipient: async (
    recipient: string,
    withinHours = 48
  ): Promise<SmsRequest | null> => {
    const digits = normalizePhoneNumber(recipient)
    if (digits.length < 9) return null

    const since = new Date(Date.now() - withinHours * 60 * 60 * 1000)
    const candidates = await db.smsMessage.findMany({
      where: {
        createdAt: { gte: since },
        status: { in: ['queued', 'pending'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    for (const candidate of candidates as unknown[]) {
      const row = toSms(candidate)
      const stored = normalizePhoneNumber(row.recipient)
      if (stored === digits || stored.endsWith(digits) || digits.endsWith(stored)) {
        return row
      }
    }
    return null
  },

  /** Queue bookkeeping: when the worker should look at this message again. */
  setNextAttemptAt: async (id: string, at: Date | null): Promise<void> => {
    try {
      await db.smsMessage.update({ where: { id }, data: { nextAttemptAt: at } })
    } catch {
      // best effort — a missing row means the message was deleted
    }
  },
}
