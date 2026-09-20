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
  } catch (error: any) {
    console.error('Dashboard error:', error)
    if (error?.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (error?.message?.includes('Forbidden') || error?.message?.includes('Super Admin')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
