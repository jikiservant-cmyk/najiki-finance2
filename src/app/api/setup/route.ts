import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import crypto from 'crypto'
import { z } from 'zod'
import { requireSuperAdmin } from '@/lib/auth'
import { validateSafeUrl } from '@/lib/safe-fetch'
import {
  getAvailableProviders,
  isProviderImplemented,
  providerDisplayName,
} from '@/lib/providers'
import { encrypt } from '@/lib/encryption'
import { generateApiKey, hashApiKey, apiKeyHint } from '@/lib/api-keys'

// Every write path is validated. These payloads previously went straight from
// `request.json()` into Prisma, so a typo in the dashboard (or a crafted
// request) could persist an application with an empty code or a non-http base
// URL that the SSRF guard would only reject much later, at delivery time.
const Id = z.string().min(1).max(64)
const Code = z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'code may only contain letters, numbers, dot, dash or underscore')

const ApplicationSchema = z.object({
  code: Code,
  name: z.string().min(1).max(200),
  baseUrl: z.string().url().max(500),
  webhookPath: z.string().min(1).max(300).default('/api/internal/payment-completed'),
  internalSecretRef: z.string().max(200).optional().default(''),
  isActive: z.boolean().optional().default(true),
})

const UpdateApplicationSchema = ApplicationSchema.partial({ code: true }).extend({ id: Id })

const ProviderSchema = z.object({
  code: Code,
  name: z.string().min(1).max(200),
  credentialsRef: z.string().max(200).optional().default(''),
  isActive: z.boolean().optional().default(true),
})

const TenantSchema = z.object({
  applicationId: Id,
  code: Code,
  name: z.string().min(1).max(200),
  defaultProviderId: z.string().max(64).optional().nullable(),
  isActive: z.boolean().optional().default(true),
})

const PaymentTypeSchema = z.object({
  applicationId: Id,
  code: z.string().min(1).max(64),
  description: z.string().max(300).optional(),
})

const TenantProviderConfigSchema = z.object({
  id: Id.optional(),
  tenantId: Id,
  providerId: Id,
  apiKey: z.string().max(500).optional().default(''),
  accountNo: z.string().max(200).optional().default(''),
  webhookSecret: z.string().max(500).optional().default(''),
  baseUrl: z.string().url().max(500).optional().default('https://livepay.me'),
  credentialsRef: z.string().max(200).optional().nullable(),
  isActive: z.boolean().optional().default(true),
})

const DeleteConfigSchema = z.object({ id: Id })
const ToggleConfigSchema = z.object({ id: Id, isActive: z.boolean() })

function validationError(error: z.ZodError) {
  const details = error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
  return NextResponse.json({ error: 'Validation failed', details }, { status: 400 })
}

/**
 * Mint an application key pair.
 *
 * The API key is returned to the operator exactly once and only its hash is
 * stored. The webhook secret is a separate credential, kept encrypted because
 * HMAC signing needs the plaintext back.
 */
function newApplicationCredentials() {
  const apiKey = generateApiKey()
  const webhookSecret = `njk_whsec_${crypto.randomBytes(32).toString('base64url')}`
  return {
    plaintextApiKey: apiKey,
    webhookSecret,
    data: {
      apiKeyHash: hashApiKey(apiKey),
      apiKeyHint: apiKeyHint(apiKey),
      webhookSecretEncrypted: encrypt(webhookSecret),
      apiKeyRotatedAt: new Date(),
    },
  }
}

export async function GET() {
  try {
    await requireSuperAdmin()

    const [applications, providers, tenantProviderConfigs, tenants] = await Promise.all([
      db.application.findMany({
        // `omit` is load-bearing, not tidiness. Selecting a whole Application
        // would ship `apiKeyHash` and `webhookSecretEncrypted` to the browser,
        // and an offline attack on a stored hash is the one thing hashing
        // cannot defend against. The plaintext `apiKey` is omitted for the same
        // reason — it is only ever returned once, from the create branch below.
        omit: {
          apiKey: true,
          apiKeyHash: true,
          webhookSecretEncrypted: true,
        },
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
          application: {
            omit: { apiKey: true, apiKeyHash: true, webhookSecretEncrypted: true },
          },
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

    const body = await request.json()
    const type = body?.type
    const data = body?.data

    if (type === 'application' || type === 'updateApplication') {
      if (typeof data?.baseUrl === 'string' && data.baseUrl) {
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
      case 'application': {
        const parsed = ApplicationSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)
        const credentials = newApplicationCredentials()
        result = await db.application.create({
          data: {
            code: parsed.data.code,
            name: parsed.data.name,
            baseUrl: parsed.data.baseUrl,
            webhookPath: parsed.data.webhookPath,
            internalSecretRef: parsed.data.internalSecretRef,
            ...credentials.data,
            isActive: parsed.data.isActive,
          },
        })
        // Shown once. It is not stored in plaintext and cannot be shown again.
        result = { ...result, apiKey: credentials.plaintextApiKey, webhookSecret: credentials.webhookSecret }
        break
      }

      case 'updateApplication': {
        const parsed = UpdateApplicationSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)
        result = await db.application.update({
          where: { id: parsed.data.id },
          data: {
            name: parsed.data.name,
            baseUrl: parsed.data.baseUrl,
            webhookPath: parsed.data.webhookPath,
            internalSecretRef: parsed.data.internalSecretRef,
            isActive: parsed.data.isActive,
          },
        })
        break
      }

      case 'provider': {
        const parsed = ProviderSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)

        // Activating a provider with no adapter is the other half of the same
        // landmine: it becomes eligible for "first active provider" selection
        // and then throws on the first payment.
        if (parsed.data.isActive && !isProviderImplemented(parsed.data.code)) {
          return NextResponse.json(
            {
              error:
                `${providerDisplayName(parsed.data.code)} has no working payment adapter yet. ` +
                'Create it inactive, or leave it out until the adapter ships.',
              availableProviders: getAvailableProviders(),
            },
            { status: 400 }
          )
        }

        result = await db.provider.create({
          data: {
            code: parsed.data.code,
            name: parsed.data.name,
            credentialsRef: parsed.data.credentialsRef,
            isActive: parsed.data.isActive,
          },
        })
        break
      }

      case 'tenant': {
        const parsed = TenantSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)

        // A tenant pointed at a provider with no working adapter means every
        // payment for that tenant fails. Refuse the configuration rather than
        // storing a landmine — /api/payments also refuses at request time, but
        // catching it here tells the operator which dropdown value is wrong.
        if (parsed.data.defaultProviderId) {
          const selected = await db.provider.findUnique({
            where: { id: parsed.data.defaultProviderId },
            select: { code: true, isActive: true },
          })
          if (!selected) {
            return NextResponse.json({ error: 'Selected provider does not exist' }, { status: 400 })
          }
          if (!isProviderImplemented(selected.code)) {
            return NextResponse.json(
              {
                error:
                  `${providerDisplayName(selected.code)} has no working payment adapter yet, so it ` +
                  'cannot be a tenant default. Leave the default empty to use the platform default.',
                availableProviders: getAvailableProviders(),
              },
              { status: 400 }
            )
          }
          if (!selected.isActive) {
            return NextResponse.json(
              { error: `${providerDisplayName(selected.code)} is inactive. Activate it first.` },
              { status: 400 }
            )
          }
        }

        result = await db.tenant.create({
          data: {
            applicationId: parsed.data.applicationId,
            code: parsed.data.code,
            name: parsed.data.name,
            defaultProviderId: parsed.data.defaultProviderId || null,
            isActive: parsed.data.isActive,
          },
        })
        break
      }

      case 'paymentType': {
        const parsed = PaymentTypeSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)
        result = await db.paymentType.create({
          data: {
            applicationId: parsed.data.applicationId,
            code: parsed.data.code,
            description: parsed.data.description,
          },
        })
        break
      }

      case 'tenantProviderConfig': {
        const parsed = TenantProviderConfigSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)
        const config = parsed.data

        // The per-tenant provider endpoint is an outbound target too — run the
        // same SSRF checks as the application base URL before storing it.
        try {
          await validateSafeUrl(config.baseUrl)
        } catch (urlErr: any) {
          return NextResponse.json(
            { error: `Invalid provider base URL: ${urlErr.message}` },
            { status: 400 }
          )
        }

        const rawCreds = {
          apiKey: config.apiKey?.trim() || '',
          accountNo: config.accountNo?.trim() || '',
          webhookSecret: config.webhookSecret?.trim() || '',
          baseUrl: config.baseUrl?.trim() || 'https://livepay.me',
        }
        
        const configJson = {
          _encrypted: encrypt(JSON.stringify(rawCreds))
        }

        if (config.id) {
          result = await db.tenantProviderConfig.update({
            where: { id: config.id },
            data: {
              tenantId: config.tenantId,
              providerId: config.providerId,
              configJson,
              credentialsRef: config.credentialsRef || null,
              isActive: config.isActive ?? true,
            },
          })
        } else {
          // Check if an existing configuration exists for this tenant & provider
          const existing = await db.tenantProviderConfig.findFirst({
            where: {
              tenantId: config.tenantId,
              providerId: config.providerId,
            },
          })

          if (existing) {
            result = await db.tenantProviderConfig.update({
              where: { id: existing.id },
              data: {
                configJson,
                credentialsRef: config.credentialsRef || null,
                isActive: config.isActive ?? true,
              },
            })
          } else {
            result = await db.tenantProviderConfig.create({
              data: {
                tenantId: config.tenantId,
                providerId: config.providerId,
                configJson,
                credentialsRef: config.credentialsRef || null,
                isActive: config.isActive ?? true,
              },
            })
          }
        }
        break
      }

      case 'deleteTenantProviderConfig': {
        const parsed = DeleteConfigSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)
        result = await db.tenantProviderConfig.delete({
          where: { id: parsed.data.id },
        })
        break
      }

      case 'toggleTenantProviderConfig': {
        const parsed = ToggleConfigSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)
        result = await db.tenantProviderConfig.update({
          where: { id: parsed.data.id },
          data: { isActive: parsed.data.isActive },
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
