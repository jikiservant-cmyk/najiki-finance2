import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import crypto from 'crypto'
import { requireSuperAdmin } from '@/lib/auth'
import { validateSafeUrl } from '@/lib/safe-fetch'

function generateApiKey(): string {
  return `nk_${crypto.randomBytes(24).toString('hex')}`
}

export async function POST(request: Request) {
  try {
    await requireSuperAdmin()

    const { type, data } = await request.json()

    if (type === 'application' || type === 'updateApplication') {
      if (data?.baseUrl) {
        try {
          await validateSafeUrl(data.baseUrl)
        } catch (urlErr: any) {
          return NextResponse.json(
            { error: `Invalid application base URL: ${urlErr.message}` },
            { status: 400 }
          )
        }
      }
    }

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

      case 'updateApplication':
        result = await db.application.update({
          where: { id: data.id },
          data: {
            name: data.name,
            baseUrl: data.baseUrl,
            webhookPath: data.webhookPath,
            internalSecretRef: data.internalSecretRef,
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
  } catch (error: any) {
    console.error('Setup error:', error)
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (error.message === 'Forbidden: Super Admin required') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
