/**
 * Shared Upstash rate limiter.
 *
 * Every route that previously needed a limiter carried its own copy of the
 * `Redis.fromEnv()` + `Promise.race` dance (a silent divergence risk). This
 * module centralises it.
 *
 * Semantics:
 *  - Redis not configured  → allowed (development), warned once.
 *  - Limiter errors/timeouts in production → 503, never "allow" (fail closed).
 *  - Limiter errors in development → allowed, warned.
 */

import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { resolveClientIp } from './client-ip'

export type Duration = `${number} ${'s' | 'm' | 'h' | 'd'}`

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; status: number; message: string; retryAfter?: string }

const limiters = new Map<string, Ratelimit>()
let warnedMissingRedis = false

function getLimiter(name: string, tokens: number, window: Duration): Ratelimit | null {
  const cacheKey = `${name}:${tokens}:${window}`
  const cached = limiters.get(cacheKey)
  if (cached) return cached

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    if (!warnedMissingRedis) {
      console.warn('[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not configured — rate limiting is disabled')
      warnedMissingRedis = true
    }
    return null
  }

  try {
    const limiter = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(tokens, window),
      analytics: true,
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
 * @param name       bucket name, e.g. 'payments-create'
 * @param identifier usually the API key, session user id or client IP
 */
export async function checkRateLimit(
  name: string,
  identifier: string,
  opts: { tokens: number; window: Duration; timeoutMs?: number }
): Promise<RateLimitDecision> {
  const limiter = getLimiter(name, opts.tokens, opts.window)
  if (!limiter) return { ok: true } // not configured → dev/no-op

  const isProduction = process.env.NODE_ENV === 'production'
  const timeoutMs = opts.timeoutMs ?? 1000

  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Rate limit check timed out')), timeoutMs)
    })

    try {
      const { success, reset } = await Promise.race([
        limiter.limit(`${name}:${identifier}`),
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
    console.error('[rate-limit] check failed:', error)
    if (isProduction) {
      // Fail closed: without the limiter we cannot protect the endpoint.
      return { ok: false, status: 503, message: 'Service temporarily unavailable' }
    }
    return { ok: true }
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
