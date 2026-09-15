import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireSuperAdmin } from '@/lib/auth'

export async function GET() {
  try {
    await requireSuperAdmin()

    const [applications, providers, tenantProviderConfigs, tenants] = await Promise.all([
      db.application.findMany({
        include: {
          tenants: true,
          paymentTypes: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.provider.findMany({
        orderBy: { createdAt: 'desc' },
      }),
      db.tenantProviderConfig.findMany({
        include: {
          tenant: true,
          provider: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.tenant.findMany({
        include: {
          application: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    return NextResponse.json({
      applications,
      providers,
      tenantProviderConfigs,
      tenants,
    })
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (error.message === 'Forbidden: Super Admin required') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
