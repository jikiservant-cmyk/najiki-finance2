import { Redis } from '@upstash/redis'

// Simple in-memory fallback for local development if Upstash keys are missing
class MockRedis {
  private store: Record<string, string[]> = {}
  private hashStore: Record<string, Record<string, string>> = {}
  private setStore: Record<string, Set<string>> = {}

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (!this.setStore[key]) this.setStore[key] = new Set()
    let added = 0
    for (const member of members) {
      if (!this.setStore[key].has(member)) {
        this.setStore[key].add(member)
        added++
      }
    }
    return added
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.setStore[key]
    if (!set) return 0
    let removed = 0
    for (const member of members) {
      if (set.delete(member)) removed++
    }
    return removed
  }

  async scard(key: string): Promise<number> {
    return this.setStore[key]?.size ?? 0
  }

  async lpush(key: string, ...elements: string[]): Promise<number> {
    if (!this.store[key]) {
      this.store[key] = []
    }
    this.store[key].unshift(...elements)
    return this.store[key].length
  }

  async rpop<T = string>(key: string): Promise<T | null> {
    if (!this.store[key] || this.store[key].length === 0) {
      return null
    }
    return this.store[key].pop() as unknown as T
  }

  async hset(key: string, fieldAndValues: Record<string, any>): Promise<number> {
    if (!this.hashStore[key]) {
      this.hashStore[key] = {}
    }
    let count = 0
    for (const [f, v] of Object.entries(fieldAndValues)) {
      this.hashStore[key][f] = JSON.stringify(v)
      count++
    }
    return count
  }

  async hget<T>(key: string, field: string): Promise<T | null> {
    if (!this.hashStore[key] || !this.hashStore[key][field]) return null
    return JSON.parse(this.hashStore[key][field])
  }

  async hvals<T>(key: string): Promise<T[]> {
    if (!this.hashStore[key]) return []
    return Object.values(this.hashStore[key]).map(v => JSON.parse(v))
  }
}

let _redisInstance: any = null

export function getRedis(): Redis {
  if (_redisInstance) return _redisInstance

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redisInstance = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
    return _redisInstance
  }

  // In production the rate-limiter already fails closed with 503 JSON
  // (see src/lib/rate-limit.ts returning `Service temporarily unavailable`
  // when the limiter is not configured). Throwing here crashes the whole
  // process and makes EVERY API route return HTML 500 (Next.js error page)
  // instead of that JSON 503 — which is what SACCO saw as
  // `NaJiki gateway error (Status 500) Response: <!DOCTYPE html>...`.
  // Log loudly but keep the process alive; the caller (rate-limit, health)
  // decides how to degrade.
  if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
    console.error(
      '[redis] UPSTASH_REDIS_* not configured in production — falling back to in-memory MockRedis. ' +
        'State will be lost on cold start. Rate-limiting will return 503 JSON until Redis is configured.'
    )
  } else {
    console.warn('WARN: Using in-memory MockRedis. This should only be used in local development.')
  }

  _redisInstance = new MockRedis() as any as Redis
  return _redisInstance
}

export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    const instance = getRedis() as any
    const val = instance[prop]
    if (typeof val === 'function') {
      return val.bind(instance)
    }
    return val
  }
})

