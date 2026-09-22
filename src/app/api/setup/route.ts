import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import crypto from 'crypto'
import { requireSuperAdmin } from '@/lib/auth'
import { validateSafeUrl } from '@/lib/safe-fetch'
import { encrypt } from '@/lib/encryption'

function generateApiKey(): string {
  return `nk_${crypto.randomBytes(24).toString('hex')}`
}

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

    // This payload contains application API keys and provider credential
    // references — never let it be cached by a browser or intermediary.
    return NextResponse.json(
      {
        applications,
        providers,
        tenantProviderConfigs,
        tenants,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  } catch (error: any) {
    console.error('Setup GET error:', error)
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (error.message === 'Forbidden: Super Admin required') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
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

      case 'tenantProviderConfig': {
        const rawCreds = {
          apiKey: data.apiKey?.trim() || '',
          accountNo: data.accountNo?.trim() || '',
          webhookSecret: data.webhookSecret?.trim() || '',
          baseUrl: data.baseUrl?.trim() || 'https://livepay.me',
        }
        
        const configJson = {
          _encrypted: encrypt(JSON.stringify(rawCreds))
        }

        if (data.id) {
          result = await db.tenantProviderConfig.update({
            where: { id: data.id },
            data: {
              tenantId: data.tenantId,
              providerId: data.providerId,
              configJson,
              credentialsRef: data.credentialsRef || null,
              isActive: data.isActive ?? true,
            },
          })
        } else {
          // Check if an existing configuration exists for this tenant & provider
          const existing = await db.tenantProviderConfig.findFirst({
            where: {
              tenantId: data.tenantId,
              providerId: data.providerId,
            },
          })

          if (existing) {
            result = await db.tenantProviderConfig.update({
              where: { id: existing.id },
              data: {
                configJson,
                credentialsRef: data.credentialsRef || null,
                isActive: data.isActive ?? true,
              },
            })
          } else {
            result = await db.tenantProviderConfig.create({
              data: {
                tenantId: data.tenantId,
                providerId: data.providerId,
                configJson,
                credentialsRef: data.credentialsRef || null,
                isActive: data.isActive ?? true,
              },
            })
          }
        }
        break
      }

      case 'deleteTenantProviderConfig': {
        result = await db.tenantProviderConfig.delete({
          where: { id: data.id },
        })
        break
      }

      case 'toggleTenantProviderConfig': {
        result = await db.tenantProviderConfig.update({
          where: { id: data.id },
          data: { isActive: data.isActive },
        })
        break
      }

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
