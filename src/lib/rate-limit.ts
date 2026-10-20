/**
 * Shared rate limiter (Upstash Redis primary + bounded in-process sliding-window fallback).
 *
 * Every route that previously needed a limiter carried its own copy of the
 * `Redis.fromEnv()` + `Promise.race` dance (a silent divergence risk). This
 * module centralises it.
 *
 * Semantics:
 *  - Upstash Redis configured & reachable → distributed sliding-window rate limit across all instances.
 *  - Upstash Redis not configured or unreachable:
 *      • Default: falls back seamlessly to a bounded in-memory sliding-window limiter
 *        enforcing the exact same `tokens` / `window` per instance (returns 429 on abuse,
 *        never bricks real customer payments with 503 when Redis is unconfigured/cold).
 *      • `ENFORCE_REDIS_RATELIMIT=true` in production: fails closed with 503.
 */

import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { resolveClientIp } from './client-ip'

export type Duration = `${number} ${'s' | 'm' | 'h' | 'd'}`

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; status: number; message: string; retryAfter?: string }

const limiters = new Map<string, Ratelimit>()
const memoryBuckets = new Map<string, number[]>()
const MAX_MEMORY_BUCKETS = 10_000
let warnedMissingRedis = false

function cleanEnvValue(raw: string | undefined): string {
  if (!raw) return ''
  return raw.trim().replace(/^["']+|["']+$/g, '').trim()
}

export function parseWindowMs(window: Duration): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(window.trim())
  if (!match) return 60_000
  const amount = Number(match[1])
  const unit = match[2]
  switch (unit) {
    case 's':
      return amount * 1_000
    case 'm':
      return amount * 60_000
    case 'h':
      return amount * 3_600_000
    case 'd':
      return amount * 86_400_000
    default:
      return 60_000
  }
}

export function resetMemoryRateLimits(): void {
  memoryBuckets.clear()
}

function checkMemoryRateLimit(
  bucketKey: string,
  tokens: number,
  window: Duration,
  now: number = Date.now()
): RateLimitDecision {
  const windowMs = parseWindowMs(window)
  const cutoff = now - windowMs

  // Bound total in-memory buckets to prevent unbounded growth under spoofed identifiers
  if (!memoryBuckets.has(bucketKey) && memoryBuckets.size >= MAX_MEMORY_BUCKETS) {
    for (const [key, timestamps] of memoryBuckets) {
      const active = timestamps.filter((t) => t > cutoff)
      if (active.length === 0) {
        memoryBuckets.delete(key)
      } else {
        memoryBuckets.set(key, active)
      }
    }
    if (memoryBuckets.size >= MAX_MEMORY_BUCKETS) {
      const oldestKey = memoryBuckets.keys().next().value
      if (oldestKey !== undefined) memoryBuckets.delete(oldestKey)
    }
  }

  const existing = memoryBuckets.get(bucketKey) || []
  const recent = existing.filter((t) => t > cutoff)

  if (recent.length >= tokens) {
    memoryBuckets.set(bucketKey, recent)
    const oldest = recent[0] ?? now
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    return {
      ok: false,
      status: 429,
      message: 'Too many requests',
      retryAfter: String(retryAfterSec),
    }
  }

  recent.push(now)
  memoryBuckets.set(bucketKey, recent)
  return { ok: true }
}

export function isUpstashRateLimitConfigured(): boolean {
  const url = cleanEnvValue(process.env.UPSTASH_REDIS_REST_URL)
  const token = cleanEnvValue(process.env.UPSTASH_REDIS_REST_TOKEN)
  return Boolean(url && token && /^https?:\/\//i.test(url))
}

function getLimiter(name: string, tokens: number, window: Duration): Ratelimit | null {
  const url = cleanEnvValue(process.env.UPSTASH_REDIS_REST_URL)
  const token = cleanEnvValue(process.env.UPSTASH_REDIS_REST_TOKEN)
  if (!url || !token || !/^https?:\/\//i.test(url)) {
    if (!warnedMissingRedis) {
      console.warn(
        '[rate-limit] Valid UPSTASH_REDIS_REST_URL (https://...) / UPSTASH_REDIS_REST_TOKEN not configured — using per-instance sliding-window limiter'
      )
      warnedMissingRedis = true
    }
    return null
  }

  const cacheKey = `${url}:${name}:${tokens}:${window}`
  const cached = limiters.get(cacheKey)
  if (cached) return cached

  try {
    const limiter = new Ratelimit({
      redis: new Redis({
        url,
        token,
        retry: { retries: 1, backoff: () => 150 },
      }),
      limiter: Ratelimit.slidingWindow(tokens, window),
      // Disable background analytics writes so cold starts perform a single fast atomic pipeline
      analytics: false,
      prefix: `najiki:ratelimit:${name}`,
    })
    limiters.set(cacheKey, limiter)
    return limiter
  } catch (error) {
    console.error('[rate-limit] failed to initialise limiter:', error)
    return null
  }
}

/**
 * Consume one token for `identifier` in the `name` bucket.
 *
 * @param name       bucket name, e.g. 'payments-ip'
 * @param identifier usually the API key, session user id or client IP
 */
export async function checkRateLimit(
  name: string,
  identifier: string,
  opts: { tokens: number; window: Duration; timeoutMs?: number }
): Promise<RateLimitDecision> {
  const limiter = getLimiter(name, opts.tokens, opts.window)
  const strictRedis =
    process.env.NODE_ENV === 'production' &&
    cleanEnvValue(process.env.ENFORCE_REDIS_RATELIMIT).toLowerCase() === 'true'
  const bucketKey = `${name}:${identifier}`

  if (!limiter) {
    if (strictRedis) {
      return { ok: false, status: 503, message: 'Service temporarily unavailable' }
    }
    return checkMemoryRateLimit(bucketKey, opts.tokens, opts.window)
  }

  const timeoutMs = opts.timeoutMs ?? 3000

  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Rate limit check timed out')), timeoutMs)
    })

    try {
      const { success, reset } = await Promise.race([
        limiter.limit(bucketKey),
        timeout,
      ])

      if (success) return { ok: true }

      const retryAfter = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : undefined
      return {
        ok: false,
        status: 429,
        message: 'Too many requests',
        retryAfter: retryAfter ? String(retryAfter) : '60',
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (error) {
    console.error('[rate-limit] Upstash check failed, falling back cleanly:', error)
    if (strictRedis) {
      return { ok: false, status: 503, message: 'Service temporarily unavailable' }
    }
    return checkMemoryRateLimit(bucketKey, opts.tokens, opts.window)
  }
}

/**
 * Client identifier used to key IP-based limiter buckets.
 *
 * Takes the trustworthy end of `x-forwarded-for` — see src/lib/client-ip.ts for
 * why reading the first entry let a caller rotate their own bucket per request
 * and escape the limit entirely. Still never trusted for authentication.
 *
 * When no address is recoverable every such request shares one bucket, which
 * denies rather than allows. The reverse (a per-request unique key) would mean
 * no limit at all.
 */
export function clientIdentifier(request: Request): string {
  const resolved = resolveClientIp({
    forwardedFor: request.headers.get('x-forwarded-for'),
    realIp: request.headers.get('x-real-ip'),
    trustedProxyHops: process.env.TRUSTED_PROXY_HOPS,
    trustRealIp: process.env.TRUST_X_REAL_IP,
  })
  return resolved || 'unknown'
}
