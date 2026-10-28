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
import { encrypt, decrypt } from '@/lib/encryption'
import { generateApiKey, hashApiKey, apiKeyHint } from '@/lib/api-keys'
import { summarizeProviderConfig, shouldPreserveStoredSecret } from '@/lib/provider-config-summary'
import {
  cleanApiKeyValue,
  cleanBaseUrlValue,
  cleanCredentialValue,
  deriveTenantWebhookSecret,
  isLegacyAutoProvisionedRef,
} from '@/lib/tenant-credentials'
import { webhookSecretFromRow } from '@/lib/application-auth'
import {
  describeApplicationWebhook,
  inboundWebhookEndpoints,
} from '@/lib/application-webhook-status'
import { runWebhookSelfTest } from '@/lib/webhook-selftest'

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
  // A path, not a URL: resolvePartnerWebhookUrl() concatenates it onto baseUrl,
  // so "https://host/hook" here would produce "https://hosthttps://host/hook".
  webhookPath: z
    .string()
    .min(1)
    .max(300)
    .default('/api/webhooks/najiki')
    .refine((path) => path.trim().startsWith('/'), {
      message: 'webhookPath must start with "/" (it is appended to the base URL)',
    }),
  internalSecretRef: z.string().max(200).optional().default(''),
  isActive: z.boolean().optional().default(true),
})

const UpdateApplicationSchema = ApplicationSchema.partial({ code: true }).extend({ id: Id })

/**
 * Rotate an application's credentials.
 *
 * `rotateWebhookSecret` defaults to **false** deliberately: the webhook secret
 * is what a partner verifies our outbound notifications with, so rotating it
 * silently would make every delivery fail signature verification on their side
 * until they are told the new one. Rotating the API key alone is the common case
 * (a leaked or lost key) and has no partner-side effect.
 */
const RotateApplicationSchema = z.object({
  id: Id,
  rotateWebhookSecret: z.boolean().optional().default(false),
})

/**
 * Revealing the outbound signing secret.
 *
 * The API key is hashed and unrecoverable, but the webhook secret has to be
 * recoverable — it is the HMAC key a partner verifies with, so the server needs
 * it at send time and the operator needs it to configure the partner. It is
 * stored under AES-256-GCM and only decrypted for this explicit, super-admin
 * action, never included in the list payload.
 */
const RevealWebhookSecretSchema = z.object({ id: Id })

/**
 * Sending a test delivery to the partner.
 *
 * `mode: 'invalid'` signs with a key that is not this application's, to find
 * out whether the partner verifies at all. Both modes are diagnostic: a 2xx to
 * `invalid` is a finding, not a success.
 */
const SelfTestWebhookSchema = z.object({
  id: Id,
  mode: z.enum(['valid', 'invalid']).optional().default('valid'),
})

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
      // `webhookSecretEncrypted` is selected so the response can report whether
      // a signing secret exists (and whether it decrypts) — never its value.
      // `apiKey`/`apiKeyHash` stay out: an offline attack on a stored hash is
      // the one thing hashing cannot defend against.
      db.application
        .findMany({
          omit: {
            apiKey: true,
            apiKeyHash: true,
          },
          include: {
            tenants: true,
            paymentTypes: true,
          },
          orderBy: { createdAt: 'desc' },
        })
        .then((rows) =>
          rows.map((row) => {
            const { webhookSecretEncrypted, ...rest } = row
            const storedSecret = webhookSecretEncrypted ?? null
            let secretValue: string | null = null
            let secretUndecryptable = false
            if (storedSecret) {
              try {
                secretValue = webhookSecretFromRow({ webhookSecretEncrypted: storedSecret })
              } catch {
                secretUndecryptable = true
              }
              if (!secretValue && !secretUndecryptable) secretUndecryptable = true
            }

            const webhook = describeApplicationWebhook({
              code: rest.code,
              baseUrl: rest.baseUrl,
              webhookPath: rest.webhookPath,
              hasWebhookSecret: Boolean(secretValue),
              secretUndecryptable,
            })

            // The encrypted blob never leaves the server.
            return {
              ...rest,
              webhookUrl: webhook.webhookUrl,
              webhookSecretSet: webhook.webhookSecretSet,
              webhookDeliverable: webhook.deliverable,
              webhookIssues: webhook.issues,
            }
          })
        ),
      db.provider.findMany({
        orderBy: { createdAt: 'desc' },
      }),
      // `configJson` holds this tenant's provider credentials. It is NOT
      // returned: the dashboard only needs to know whether credentials exist and
      // what the non-secret fields are. Rows written before encryption was added
      // still hold { apiKey, webhookSecret } in the clear, and shipping those to
      // a browser is exactly what the Application `omit` above exists to prevent.
      db.tenantProviderConfig
        .findMany({
          include: {
            tenant: true,
            provider: true,
          },
          orderBy: { createdAt: 'desc' },
        })
        .then((configs) =>
          configs
            .filter((cfg) => {
              if (isLegacyAutoProvisionedRef(cfg.credentialsRef)) {
                db.tenantProviderConfig.delete({ where: { id: cfg.id } }).catch(() => {})
                return false
              }
              return true
            })
            .map(({ configJson, ...rest }) => {
              const record =
                configJson && typeof configJson === 'object' && !Array.isArray(configJson)
                  ? (configJson as Record<string, unknown>)
                  : {}
              if (typeof record._encrypted === 'string' && record._encrypted.length > 0) {
                try {
                  const decoded = JSON.parse(decrypt(record._encrypted))
                  const innerSummary = summarizeProviderConfig(decoded)
                  return {
                    ...rest,
                    configSummary: {
                      ...innerSummary,
                      encrypted: true,
                    },
                  }
                } catch {
                  return {
                    ...rest,
                    configSummary: summarizeProviderConfig(configJson),
                  }
                }
              }
              return {
                ...rest,
                configSummary: summarizeProviderConfig(configJson),
              }
            })
        ),
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
    // The inbound half — what the providers must be pointed at. Derived from
    // the configured public origin rather than from request headers, because it
    // has to match the origin the signature is computed against.
    const inbound = inboundWebhookEndpoints(
      process.env.NEXTAUTH_URL || process.env.PUBLIC_BASE_URL || null
    )

    return NextResponse.json(
      {
        applications,
        providers,
        tenantProviderConfigs,
        tenants,
        inbound,
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
        // Shown once. Neither is recoverable afterwards (the key by design, the
        // secret only through the explicit reveal action). The hash is stripped:
        // it has no business in a browser.
        const { apiKeyHash: _omitHash, ...created } = result as Record<string, unknown>
        result = {
          ...created,
          apiKey: credentials.plaintextApiKey,
          webhookSecret: credentials.webhookSecret,
        }
        break
      }

      case 'updateApplication': {
        const parsed = UpdateApplicationSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)

        // `omit` is not cosmetic here: without it this branch echoed the stored
        // `apiKey` and the `webhookSecretEncrypted` blob back to the browser on
        // every edit.
        const updated = await db.application.update({
          where: { id: parsed.data.id },
          data: {
            name: parsed.data.name,
            baseUrl: parsed.data.baseUrl,
            webhookPath: parsed.data.webhookPath,
            internalSecretRef: parsed.data.internalSecretRef,
            isActive: parsed.data.isActive,
          },
          omit: { apiKey: true, apiKeyHash: true },
        })

        // The saved URL and any remaining problem, so the form can confirm what
        // it actually stored rather than what it sent.
        const { webhookSecretEncrypted, ...row } = updated
        const secretValue = webhookSecretFromRow({ webhookSecretEncrypted: webhookSecretEncrypted ?? null })
        const webhook = describeApplicationWebhook({
          code: row.code,
          baseUrl: row.baseUrl,
          webhookPath: row.webhookPath,
          hasWebhookSecret: Boolean(secretValue),
        })
        result = {
          ...row,
          webhookUrl: webhook.webhookUrl,
          webhookSecretSet: webhook.webhookSecretSet,
          webhookDeliverable: webhook.deliverable,
          webhookIssues: webhook.issues,
          message: `Saved. Notifications will be sent to ${webhook.webhookUrl}`,
        }
        break
      }

      case 'revealWebhookSecret': {
        // The partner needs this value to configure its verifier, and it is the
        // only way to hand it over after the create response was missed. It is
        // read on demand, for this one action, and never included in a list.
        const parsed = RevealWebhookSecretSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)

        const application = await db.application.findUnique({
          where: { id: parsed.data.id },
          select: {
            id: true,
            code: true,
            name: true,
            apiKey: true,
            webhookSecretEncrypted: true,
          },
        })
        if (!application) {
          return NextResponse.json({ error: 'Application not found' }, { status: 404 })
        }

        const webhookSecret = webhookSecretFromRow(application)
        if (!webhookSecret) {
          return NextResponse.json(
            {
              error:
                `No usable signing secret for ${application.code}: none is stored, or it cannot be ` +
                'decrypted with APP_ENCRYPTION_KEY. Rotate the webhook secret to create one.',
            },
            { status: 400 }
          )
        }

        console.warn(
          `[setup] webhook signing secret revealed for application ${application.code}`
        )
        result = {
          id: application.id,
          code: application.code,
          webhookSecret,
          note:
            'This is the HMAC key for verifying inbound notifications. Do not put it in a client-side bundle.',
        }
        break
      }

      case 'sendTestWebhook': {
        // "Do the secrets actually work?" cannot be answered by inspecting the
        // stored value: what breaks a go-live is the partner holding a
        // different one, or not checking at all. So this sends a real signed
        // request to the real endpoint and reports what came back.
        const parsed = SelfTestWebhookSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)

        const application = await db.application.findUnique({
          where: { id: parsed.data.id },
          select: {
            id: true,
            code: true,
            name: true,
            baseUrl: true,
            webhookPath: true,
            webhookSecretEncrypted: true,
          },
        })
        if (!application) {
          return NextResponse.json({ error: 'Application not found' }, { status: 404 })
        }

        let secret: string | null = null
        try {
          secret = webhookSecretFromRow(application)
        } catch {
          secret = null
        }
        if (!secret) {
          return NextResponse.json(
            {
              error:
                `No usable signing secret for ${application.code}, so there is nothing to sign the ` +
                'test with. Rotate the webhook secret to create one, then run the test again.',
            },
            { status: 400 }
          )
        }

        const view = describeApplicationWebhook({
          code: application.code,
          baseUrl: application.baseUrl,
          webhookPath: application.webhookPath,
          hasWebhookSecret: true,
        })
        if (!view.webhookUrl) {
          return NextResponse.json(
            { error: 'No webhook URL is configured for this application. Set the base URL first.' },
            { status: 400 }
          )
        }

        const test = await runWebhookSelfTest({
          applicationCode: application.code,
          webhookUrl: view.webhookUrl,
          secret,
          mode: parsed.data.mode,
        })

        console.warn(
          `[setup] webhook self-test (${test.mode}) for ${application.code}: ${test.verdict}` +
            `${test.statusCode ? ` HTTP ${test.statusCode}` : ''}`
        )

        result = { id: application.id, code: application.code, ...test }
        break
      }

      case 'rotateApplication': {
        // There was no rotation path at all, while the dashboard told operators
        // to "rotate it" when a key was lost. The only recovery from a leaked
        // partner key was deleting the application — which cannot be done once
        // it has payment history, and is not what you want during an incident.
        const parsed = RotateApplicationSchema.safeParse(data)
        if (!parsed.success) return validationError(parsed.error)

        const credentials = newApplicationCredentials()
        const rotateWebhookSecret = parsed.data.rotateWebhookSecret === true

        const updated = await db.application.update({
          where: { id: parsed.data.id },
          data: {
            apiKeyHash: credentials.data.apiKeyHash,
            apiKeyHint: credentials.data.apiKeyHint,
            apiKeyRotatedAt: credentials.data.apiKeyRotatedAt,
            // Destroying the old cleartext is what makes this a real
            // revocation rather than a second working key. `findApplicationByApiKey`
            // consults the cleartext column only for rows with no hash, so once
            // this row has the new hash the superseded key is dead.
            apiKey: null,
            ...(rotateWebhookSecret
              ? { webhookSecretEncrypted: credentials.data.webhookSecretEncrypted }
              : {}),
          },
          omit: { apiKey: true, apiKeyHash: true, webhookSecretEncrypted: true },
        })

        // Returned exactly once. Neither value is recoverable afterwards.
        result = {
          ...updated,
          apiKey: credentials.plaintextApiKey,
          webhookSecretRotated: rotateWebhookSecret,
          ...(rotateWebhookSecret ? { webhookSecret: credentials.webhookSecret } : {}),
        }
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

        // Editing must not erase a credential it was never shown. The form
        // cannot prefill the API key (the server will not send it), so a blank
        // value here means "unchanged", not "delete" — read the stored blob and
        // carry the existing secret forward.
        let preserved: Record<string, string> = {}
        if (config.id) {
          const current = await db.tenantProviderConfig.findUnique({ where: { id: config.id } })
          const stored = current?.configJson as Record<string, unknown> | undefined
          if (stored && typeof stored === 'object') {
            if (typeof stored._encrypted === 'string') {
              try {
                const decoded = JSON.parse(decrypt(stored._encrypted))
                if (decoded && typeof decoded === 'object') preserved = decoded
              } catch (decryptErr) {
                console.error(
                  `[setup] Could not decrypt the stored provider config for ${config.id}; ` +
                    'refusing to guess at its credentials.',
                  decryptErr
                )
                return NextResponse.json(
                  {
                    error:
                      'The stored credentials for this configuration could not be read, so ' +
                      'saving would have overwritten them. Re-enter the API key to replace them.',
                  },
                  { status: 409 }
                )
              }
            } else {
              // Legacy plaintext blob.
              preserved = stored as Record<string, string>
            }
          }
        }

        const effectiveApiKey = shouldPreserveStoredSecret(config.apiKey)
          ? cleanApiKeyValue(preserved.apiKey)
          : cleanApiKeyValue(config.apiKey)
        const effectiveAccountNo =
          cleanCredentialValue(config.accountNo) || cleanCredentialValue(preserved.accountNo)
        const submittedWebhookSecret = shouldPreserveStoredSecret(config.webhookSecret)
          ? cleanCredentialValue(preserved.webhookSecret)
          : cleanCredentialValue(config.webhookSecret)
        const effectiveWebhookSecret =
          submittedWebhookSecret.length >= 16
            ? submittedWebhookSecret
            : effectiveApiKey && effectiveAccountNo
              ? deriveTenantWebhookSecret(effectiveApiKey, config.tenantId, effectiveAccountNo)
              : submittedWebhookSecret
        const effectiveBaseUrl = cleanBaseUrlValue(config.baseUrl || preserved.baseUrl)

        const rawCreds = {
          apiKey: effectiveApiKey,
          accountNo: effectiveAccountNo,
          webhookSecret: effectiveWebhookSecret,
          baseUrl: effectiveBaseUrl,
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
