import { Redis } from '@upstash/redis'

// Simple in-memory fallback for local development if Upstash keys are missing
class MockRedis {
  private store: Record<string, string[]> = {}
  private hashStore: Record<string, Record<string, string>> = {}

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

export const redis = (() => {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRITICAL: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are missing in production. Rate limiting and SMS queue will silently fail.');
  }

  console.warn('WARN: Using in-memory MockRedis. This should only be used in local development.');
  return new MockRedis() as any as Redis;
})();
