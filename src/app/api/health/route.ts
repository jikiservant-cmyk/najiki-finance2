/**
 * Liveness / readiness probe.
 *
 * Deliberately public (the middleware exempts it) and deliberately boring: it
 * returns only booleans, counters and the deploy commit — never configuration
 * values, keys or customer data.
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
    return { ok: false, detail: error instanceof Error ? error.message : 'unknown error' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const deep = url.searchParams.get('deep') === '1'

  const startedAt = Date.now()

  const [database, cache] = await Promise.all([
    withTimeout('database', db.$queryRawUnsafe('SELECT 1')),
    withTimeout('redis', redis.ping?.() ?? Promise.resolve('PONG')),
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
