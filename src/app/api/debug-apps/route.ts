import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  try {
    const apps = await db.application.findMany({
      where: { isActive: true },
      include: {
        tenants: { where: { isActive: true } },
        paymentTypes: true,
      },
    })

    const providers = await db.provider.findMany({
      where: { isActive: true },
    })

    return NextResponse.json({
      applications: apps.map(app => ({
        id: app.id,
        code: app.code,
        name: app.name,
        baseUrl: app.baseUrl,
        webhookPath: app.webhookPath,
        internalSecretRef: app.internalSecretRef,
        isActive: app.isActive,
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
        tenants: app.tenants,
        paymentTypes: app.paymentTypes,
      })),
      providers: providers,
    })
  } catch (error) {
    console.error('Debug apps error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
