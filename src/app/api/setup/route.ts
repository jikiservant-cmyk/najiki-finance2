import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import crypto from 'crypto'

function generateApiKey(): string {
  return `nk_${crypto.randomBytes(24).toString('hex')}`
}

export async function POST(request: Request) {
  try {
    const { type, data } = await request.json()

    let result
    switch (type) {
      case 'application':
        result = await db.application.create({
          data: {
            code: data.code,
            name: data.name,
            baseUrl: data.baseUrl,
            webhookPath: data.webhookPath,
            internalSecretRef: data.internalSecretRef,
            apiKey: generateApiKey(),
            isActive: data.isActive,
          },
        })
        break

      case 'provider':
        result = await db.provider.create({
          data: {
            code: data.code,
            name: data.name,
            credentialsRef: data.credentialsRef,
            isActive: data.isActive,
          },
        })
        break

      case 'tenant':
        result = await db.tenant.create({
          data: {
            applicationId: data.applicationId,
            code: data.code,
            name: data.name,
            defaultProviderId: data.defaultProviderId || null,
            isActive: data.isActive,
          },
        })
        break

      case 'paymentType':
        result = await db.paymentType.create({
          data: {
            applicationId: data.applicationId,
            code: data.code,
            description: data.description,
          },
        })
        break

      default:
        return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Setup error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
