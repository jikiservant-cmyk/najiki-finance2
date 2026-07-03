import { NextResponse } from 'next/server'
import { getDashboardData } from '@/lib/data'

export async function GET(request: Request) {
  try {
    const data = await getDashboardData()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
