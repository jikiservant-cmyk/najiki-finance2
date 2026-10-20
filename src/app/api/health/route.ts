/**
 * Liveness / readiness probe.
 *
 * Deliberately public (the middleware exempts it) and deliberately boring: it
 * returns only booleans, counters and the deploy commit — never configuration
 * values, keys, customer data, or raw dependency error text (which can carry the
 * database host and user).
 *
 *   200 — every dependency answered
 *   503 — at least one dependency is down (load balancers should stop routing)
 *
 * `?deep=1` additionally counts stuck payments. That is a read-heavy query, so
 * it is opt-in for the alerting worker rather than on every liveness hit.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { redis } from '@/lib/redis'
import { isUpstashRateLimitConfigured } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const DEPENDENCY_TIMEOUT_MS = 3_000

async function withTimeout<T>(label: string, work: Promise<T>): Promise<{ ok: boolean; detail?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), DEPENDENCY_TIMEOUT_MS)
      }),
    ])
    return { ok: true }
  } catch (error) {
    // Log the real error, return a label. This endpoint is unauthenticated and
    // the message from a Prisma/Postgres connection failure routinely contains
    // the host, port and user from the connection string, which is exactly the
    // internal detail a probe should not hand to an anonymous caller.
    console.error(`[health] ${label} check failed:`, error)
    return { ok: false, detail: `${label} unavailable` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const deep = url.searchParams.get('deep') === '1'

  const startedAt = Date.now()

  const strictRedis =
    process.env.NODE_ENV === 'production' &&
    String(process.env.ENFORCE_REDIS_RATELIMIT || '').trim().toLowerCase() === 'true'

  const redisPing = (async () => {
    if (!isUpstashRateLimitConfigured()) {
      if (strictRedis) {
        throw new Error('Upstash Redis required by ENFORCE_REDIS_RATELIMIT=true')
      }
      return 'IN_MEMORY_FALLBACK'
    }
    try {
      const res = await (redis as any).ping?.()
      return res ?? 'PONG'
    } catch (e) {
      if (strictRedis) throw e
      console.warn('[health] Upstash Redis ping failed; falling back to in-memory limiter:', e)
      return 'IN_MEMORY_FALLBACK'
    }
  })()

  const [database, cache] = await Promise.all([
    withTimeout('database', db.$queryRawUnsafe('SELECT 1') as Promise<unknown>),
    withTimeout('redis', redisPing),
  ])

  const checks: Record<string, { ok: boolean; detail?: string }> = { database, cache }
  let stuckPayments: number | null = null

  if (deep && database.ok) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    try {
      // Payments left in a non-terminal state for over an hour are the signal
      // that a provider callback or poll never resolved.
      stuckPayments = await db.paymentIntent.count({
        where: {
          status: { in: ['pending', 'processing'] },
          createdAt: { lte: oneHourAgo, gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      })
    } catch {
      stuckPayments = null
    }
  }

  const healthy = Object.values(checks).every((check) => check.ok)

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || process.env.GIT_COMMIT?.slice(0, 7) || 'unknown',
      checks,
      ...(deep ? { stuckPayments } : {}),
      latencyMs: Date.now() - startedAt,
    },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store, max-age=0' } }
  )
}
