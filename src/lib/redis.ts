import { Redis } from '@upstash/redis'

// Simple in-memory fallback for local development if Upstash keys are missing
class MockRedis {
  private store: Record<string, string[]> = {}

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
}

export const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : (new MockRedis() as any as Redis)
