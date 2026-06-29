// FIX: Add API key auth + rate limiting
// GET /api/dashboard was completely open — no auth, no throttle.
// Anyone with the URL could see all tenant revenue AND crash the server
// by hitting it repeatedly (each request runs heavy DB aggregates).
//
// Set DASHBOARD_API_KEY=<openssl rand -hex 32> in your .env

import { NextResponse } from 'next/server'
import { getDashboardData } from '@/lib/data'

// In-process rate limiter — fixed window per API key
// For multi-instance deploys swap this for Upstash Redis + @upstash/ratelimit
const windows = new Map<string, { count: number; reset: number }>()
const LIMIT = 10
const WINDOW_MS = 60_000

function isRateLimited(key: string): boolean {
  const now = Date.now()
  const w = windows.get(key)
  if (!w || now > w.reset) {
    windows.set(key, { count: 1, reset: now + WINDOW_MS })
    return false
  }
  if (w.count >= LIMIT) return true
  w.count++
  return false
}

export async function GET(request: Request) {
  // Auth
  const apiKey = request.headers.get('x-api-key')
  const expected = process.env.DASHBOARD_API_KEY

  if (!expected) {
    console.error('DASHBOARD_API_KEY not set — blocking all dashboard access')
    return NextResponse.json({ error: 'Service misconfigured' }, { status: 503 })
  }
  if (!apiKey || apiKey !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limit per key
  if (isRateLimited(apiKey)) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }

  try {
    const data = await getDashboardData()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
