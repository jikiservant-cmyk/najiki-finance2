import { NextResponse } from 'next/server'
import { getDashboardData } from '@/lib/data'
import { requireSuperAdmin } from '@/lib/auth'

export async function GET(request: Request) {
  try {
    await requireSuperAdmin()
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || '14d';
    const data = await getDashboardData(period)
    return NextResponse.json(data)
  } catch (error) {
    console.error('Dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
