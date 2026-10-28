import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import ts from 'typescript'
import { isPlatformFeeType, resolvePartnerWebhookUrl } from '../src/lib/constants.ts'
// Loaded through the shared helper (not a bare ESM import) because
// payment-security now imports ./provider-amount; see tests/helpers/ts-load.ts.
const { isConfirmedTerminalStatus, parseTenantProviderCredentials } = (await import('./helpers/ts-load.ts')).loadTsModule<{
  isConfirmedTerminalStatus: (result: any, expected?: any) => boolean
  parseTenantProviderCredentials: (raw: unknown) => any
}>('src/lib/payment-security.ts')
import { normalizePhone } from '../src/lib/phone.ts'
import { buildSignatureUrlCandidates } from '../src/lib/webhook-url.ts'
import { verifyNotificationSignature } from '../src/lib/notification-signature.ts'

function loadTsModule<T>(relPath: string, stubs: Record<string, unknown> = {}): T {
  const file = path.resolve(relPath)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const loaded = new Module(file)
  loaded.filename = file
  loaded.paths = Module._nodeModulePaths(path.dirname(file))
  const originalRequire = loaded.require.bind(loaded)
  loaded.require = (name: string) =>
    Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name] : originalRequire(name)
  loaded._compile(code, file)
  return loaded.exports as T
}

test('normalizePrismaDatabaseUrl appends pgbouncer=true for Supabase port 6543 and strips quotes', () => {
  let capturedOptions: any = null
  const previousDbUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = '"postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"'
  const prevGlobalPrisma = (globalThis as any).prisma
  ;(globalThis as any).prisma = undefined
  try {
    const { normalizePrismaDatabaseUrl } = loadTsModule<{
      normalizePrismaDatabaseUrl: (rawUrl: string | undefined | null) => string | undefined
    }>('src/lib/db.ts', {
      '@prisma/client': {
        PrismaClient: class StubPrismaClient {
          paymentIntent = {}
          constructor(opts: any) {
            capturedOptions = opts
          }
        },
      },
    })

    assert.equal(
      capturedOptions?.datasources?.db?.url,
      'postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true'
    )
    assert.equal(normalizePrismaDatabaseUrl(undefined), undefined)
    assert.equal(normalizePrismaDatabaseUrl('   '), undefined)
    assert.equal(
      normalizePrismaDatabaseUrl('"postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"'),
      'postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true'
    )
    assert.equal(
      normalizePrismaDatabaseUrl('postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?connection_limit=5'),
      'postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?connection_limit=5&pgbouncer=true'
    )
    assert.equal(
      normalizePrismaDatabaseUrl('postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true'),
      'postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true'
    )
    assert.equal(
      normalizePrismaDatabaseUrl('postgresql://postgres:pw@db.ref.supabase.co:5432/postgres'),
      'postgresql://postgres:pw@db.ref.supabase.co:5432/postgres'
    )
  } finally {
    ;(globalThis as any).prisma = prevGlobalPrisma
    if (previousDbUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDbUrl
  }
})

test('checkRateLimit falls back to in-memory sliding window when Upstash network request fails', async () => {
  const rateLimit = loadTsModule<{
    checkRateLimit: (
      name: string,
      identifier: string,
      opts: { tokens: number; window: `${number} ${'s' | 'm' | 'h' | 'd'}`; timeoutMs?: number }
    ) => Promise<{ ok: true } | { ok: false; status: number; message: string; retryAfter?: string }>
    resetMemoryRateLimits: () => void
    parseWindowMs: (window: `${number} ${'s' | 'm' | 'h' | 'd'}`) => number
  }>('src/lib/rate-limit.ts', {
    './client-ip': { resolveClientIp: () => '203.0.113.10' },
  })

  assert.equal(rateLimit.parseWindowMs('10 s'), 10_000)
  assert.equal(rateLimit.parseWindowMs('1 m'), 60_000)
  assert.equal(rateLimit.parseWindowMs('2 h'), 7_200_000)
  assert.equal(rateLimit.parseWindowMs('1 d'), 86_400_000)

  const previous = {
    nodeEnv: process.env.NODE_ENV,
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    enforce: process.env.ENFORCE_REDIS_RATELIMIT,
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('fetch failed: upstream ECONNRESET')
  }
  try {
    process.env.NODE_ENV = 'production'
    process.env.UPSTASH_REDIS_REST_URL = '"https://unreachable-upstash-unit-test.upstash.io"'
    process.env.UPSTASH_REDIS_REST_TOKEN = '"test-token"'
    delete process.env.ENFORCE_REDIS_RATELIMIT
    rateLimit.resetMemoryRateLimits()

    const r1 = await rateLimit.checkRateLimit('deposit-fallback-test', 'member-1', {
      tokens: 2,
      window: '1 m',
      timeoutMs: 250,
    })
    const r2 = await rateLimit.checkRateLimit('deposit-fallback-test', 'member-1', {
      tokens: 2,
      window: '1 m',
      timeoutMs: 250,
    })
    const r3 = await rateLimit.checkRateLimit('deposit-fallback-test', 'member-1', {
      tokens: 2,
      window: '1 m',
      timeoutMs: 250,
    })

    assert.deepEqual(r1, { ok: true })
    assert.deepEqual(r2, { ok: true })
    assert.equal(r3.ok, false)
    if (!r3.ok) {
      assert.equal(r3.status, 429)
      assert.ok(Number(r3.retryAfter) >= 1)
    }
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of [
      ['NODE_ENV', previous.nodeEnv],
      ['UPSTASH_REDIS_REST_URL', previous.url],
      ['UPSTASH_REDIS_REST_TOKEN', previous.token],
      ['ENFORCE_REDIS_RATELIMIT', previous.enforce],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('resolveTenantOrPlatformCredentials survives missing APP_ENCRYPTION_KEY and short webhook secret', async () => {
  const tenantCredsMod = loadTsModule<{
    loadTenantProviderCredentials: (tenantId: string, providerId: string) => Promise<any>
    resolveTenantOrPlatformCredentials: (
      tenantId: string,
      providerId: string,
      tenantCode?: string | null
    ) => Promise<{ source: string; credentials: any } | null>
  }>('src/lib/tenant-credentials.ts', {
    './db': {
      db: {
        tenantProviderConfig: {
          findFirst: async () => ({ configJson: { _encrypted: 'corrupted-ciphertext' } }),
          upsert: async () => ({}),
        },
      },
    },
    './encryption': {
      decrypt: () => {
        throw new Error('CRITICAL: APP_ENCRYPTION_KEY must be a 64-character hex string in production!')
      },
      encrypt: () => {
        throw new Error('CRITICAL: APP_ENCRYPTION_KEY must be a 64-character hex string in production!')
      },
    },
    './payment-security': { parseTenantProviderCredentials },
  })

  const prev = {
    apiKey: process.env.LIVEPAY_API_KEY,
    accountNo: process.env.LIVEPAY_ACCOUNT_NO,
    webhookSecret: process.env.LIVEPAY_WEBHOOK_SECRET,
  }
  try {
    // Corrupted/un-decryptable DB row returns null cleanly rather than throwing 500
    assert.equal(await tenantCredsMod.loadTenantProviderCredentials('t1', 'p1'), null)

    // Complete platform env succeeds in memory even if encrypt() throws
    process.env.LIVEPAY_API_KEY = '"lp_live_key"'
    process.env.LIVEPAY_ACCOUNT_NO = '"LP260001"'
    process.env.LIVEPAY_WEBHOOK_SECRET = '"whsec_1234567890abcdef"'
    const fromPlatform = await tenantCredsMod.resolveTenantOrPlatformCredentials('t1', 'p1', 'kun-sac')
    assert.equal(fromPlatform?.source, 'platform')
    assert.equal(fromPlatform?.credentials?.apiKey, 'lp_live_key')
    assert.equal(fromPlatform?.credentials?.accountNo, 'LP260001')

    // Missing/short webhook secret still allows initiation via platform-env instead of 503
    delete process.env.LIVEPAY_WEBHOOK_SECRET
    const fromPlatformEnv = await tenantCredsMod.resolveTenantOrPlatformCredentials('t1', 'p1', 'kun-sac')
    assert.deepEqual(fromPlatformEnv, { source: 'platform-env', credentials: undefined })
  } finally {
    for (const [k, v] of [
      ['LIVEPAY_API_KEY', prev.apiKey],
      ['LIVEPAY_ACCOUNT_NO', prev.accountNo],
      ['LIVEPAY_WEBHOOK_SECRET', prev.webhookSecret],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('isPlatformFeeType distinguishes platform fees from tenant collections', () => {
  assert.equal(isPlatformFeeType('BUY_SMS'), true)
  assert.equal(isPlatformFeeType('buy_sms'), true)
  assert.equal(isPlatformFeeType('account_activation'), true)
  assert.equal(isPlatformFeeType('deposit'), false)
  assert.equal(isPlatformFeeType('loan_repayment'), false)
  assert.equal(isPlatformFeeType(null), false)
})

test('resolvePartnerWebhookUrl self-heals legacy sacco webhook path while preserving custom paths', () => {
  assert.equal(
    resolvePartnerWebhookUrl({
      code: 'sacco',
      baseUrl: 'https://kunitydev.netlify.app/',
      webhookPath: '/api/internal/payment-completed',
    }),
    'https://kunitydev.netlify.app/api/webhooks/najiki'
  )
  assert.equal(
    resolvePartnerWebhookUrl({
      code: 'sacco',
      baseUrl: 'https://kunitydev.netlify.app',
      webhookPath: '/api/webhooks/najiki',
    }),
    'https://kunitydev.netlify.app/api/webhooks/najiki'
  )
  assert.equal(
    resolvePartnerWebhookUrl({
      code: 'church',
      baseUrl: 'https://church.example.org/',
      webhookPath: '/api/internal/payment-completed',
    }),
    'https://church.example.org/api/internal/payment-completed'
  )
})

test('SACCO credentials saved without optional webhookSecret load directly and never overwrite tenant_provider_configs', async () => {
  let deleteCalledWith: any = null
  const tenantCredsMod = loadTsModule<{
    loadTenantProviderCredentials: (tenantId: string, providerId: string) => Promise<any>
    resolveTenantOrPlatformCredentials: (
      tenantId: string,
      providerId: string,
      tenantCode?: string | null
    ) => Promise<{ source: string; credentials: any } | null>
  }>('src/lib/tenant-credentials.ts', {
    './db': {
      db: {
        tenantProviderConfig: {
          findFirst: async () => ({
            id: 'auto-row-1',
            credentialsRef: 'LIVEPAY_AUTO_OLD',
            configJson: {
              apiKey: 'stale-auto-key',
              accountNo: 'STALE_ACC',
              webhookSecret: 'stale-webhook-secret-1234',
            },
          }),
          findMany: async () => [
            {
              id: 'sacco-row-real',
              credentialsRef: null,
              configJson: {
                _encrypted: JSON.stringify({
                  apiKey: 'Bearer "lp_live_sacco_real_key"',
                  accountNo: ' "SACCO_ACC_999" ',
                  webhookSecret: '', // left blank in Setup UI ("Webhook Secret (Optional)")
                  baseUrl: 'https://livepay.me/',
                }),
              },
            },
          ],
          delete: async (args: any) => {
            deleteCalledWith = args
            return {}
          },
        },
      },
    },
    './encryption': {
      decrypt: (s: string) => s,
    },
    './payment-security': { parseTenantProviderCredentials },
  })

  const resolved = await tenantCredsMod.resolveTenantOrPlatformCredentials('tenant-1', 'prov-1', 'k-unity-sacco')
  assert.equal(resolved?.source, 'tenant')
  assert.equal(resolved?.credentials?.apiKey, 'lp_live_sacco_real_key')
  assert.equal(resolved?.credentials?.accountNo, 'SACCO_ACC_999')
  assert.equal(resolved?.credentials?.baseUrl, 'https://livepay.me')
  assert.equal(resolved?.credentials?.webhookSecret.length >= 16, true)
  assert.deepEqual(deleteCalledWith, { where: { id: 'auto-row-1' } })
})

test('LivePayProvider normalizes member 07XXXXXXXX deposit phone numbers to 2567XXXXXXXX like BUY_SMS', async () => {
  const { LivePayProvider } = loadTsModule<{ LivePayProvider: any }>('src/lib/providers/livepay.ts', {
    '@/lib/phone': { normalizePhone },
  })

  let capturedBody: any = null
  let capturedAuthHeader: string | null = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url: any, init: any) => {
    capturedAuthHeader = init?.headers?.Authorization ?? null
    capturedBody = JSON.parse(init.body)
    return new Response(
      JSON.stringify({ success: true, internal_reference: 'LP-TX-001' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  try {
    const provider = new LivePayProvider({
      apiKey: 'Bearer lp_live_sacco_key',
      accountNo: 'SACCO_ACC_999',
      webhookSecret: 'lpwhsec_0123456789abcdef',
      baseUrl: 'https://livepay.me/',
    })

    const res = await provider.initiatePayment({
      amount: 5000,
      currency: 'UGX',
      phoneNumber: '0772123456',
      reference: 'SACCO-DEP-TEST-001',
      description: 'Member deposit',
    })

    assert.equal(res.success, true)
    assert.equal(res.status, 'processing')
    assert.equal(capturedAuthHeader, 'Bearer lp_live_sacco_key')
    assert.equal(capturedBody.accountNumber, 'SACCO_ACC_999')
    assert.equal(capturedBody.phoneNumber, '256772123456')
    assert.equal(capturedBody.amount, 5000)
    assert.equal(capturedBody.currency, 'UGX')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('matchTenantCandidate and isAuthorizedTenantPoll handle exact codes, slugs, and single-SACCO UUID bridges without cross-tenant leaks', () => {
  const resolution = loadTsModule<{
    matchTenantCandidate: (tenants: any[], code?: string | null) => any
    isAuthorizedTenantPoll: (params: any) => boolean
  }>('src/lib/tenant-resolution.ts', {
    './db': { db: {} },
  })

  const singleTenant = [
    { id: 'cm_tenant_1', code: 'k-unity-sacco', name: 'K-Unity SACCO', defaultProviderId: null },
  ]
  const multiTenants = [
    ...singleTenant,
    { id: 'cm_tenant_2', code: 'st-jude-sacco', name: 'St Jude SACCO', defaultProviderId: null },
  ]

  // Single-tenant SACCO: bridges Kunity organization UUID and slug variations
  assert.equal(
    resolution.matchTenantCandidate(singleTenant, '550e8400-e29b-41d4-a716-446655440000')?.matchedBy,
    'single-tenant-org-uuid'
  )
  assert.equal(
    resolution.matchTenantCandidate(singleTenant, 'k_unity_sacco')?.tenant.id,
    'cm_tenant_1'
  )

  // Multi-tenant SACCO: matches slug/id accurately, refuses unknown UUID cross-tenant fallback
  assert.equal(
    resolution.matchTenantCandidate(multiTenants, 'st_jude_sacco')?.tenant.id,
    'cm_tenant_2'
  )
  assert.equal(
    resolution.matchTenantCandidate(multiTenants, '550e8400-e29b-41d4-a716-446655440000'),
    null
  )

  // Poll authorization mirrors creation rules while blocking cross-tenant snooping
  assert.equal(
    resolution.isAuthorizedTenantPoll({
      intentTenant: singleTenant[0],
      requestedTenantCode: '550e8400-e29b-41d4-a716-446655440000',
      activeTenantCount: 1,
    }),
    true
  )
  assert.equal(
    resolution.isAuthorizedTenantPoll({
      intentTenant: multiTenants[0],
      requestedTenantCode: 'st-jude-sacco',
      activeTenantCount: 2,
    }),
    false
  )
})

test('LivePayProvider checkPaymentStatus handles "Successful", nested data envelopes, and avoids reference collision', async () => {
  const { LivePayProvider } = loadTsModule<{ LivePayProvider: any }>('src/lib/providers/livepay.ts', {
    '@/lib/phone': { normalizePhone },
  })

  const originalFetch = globalThis.fetch
  try {
    const provider = new LivePayProvider({
      apiKey: 'lp_live_key_test',
      accountNo: 'LP999888',
      webhookSecret: 'lpwhsec_0123456789abcdef',
      baseUrl: 'https://livepay.me',
    })

    // 1. initiatePayment when LivePay echoes customer `reference` without `internal_reference` yet
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ success: true, reference: 'SACCO-DEP-LEGACY-01', status: 'Pending' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )

    const init = await provider.initiatePayment({
      amount: 10000,
      currency: 'UGX',
      phoneNumber: '0744827730',
      reference: 'SACCO-DEP-LEGACY-01',
      description: 'Savings deposit',
    })
    assert.equal(init.success, true)
    assert.equal(init.status, 'processing')
    assert.equal(init.providerPaymentId, undefined)

    // 2. checkPaymentStatus when LivePay returns nested `{ success: true, data: { status: "Successful", internal_reference: "LP-777" } }`
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            status: 'Successful',
            amount: '10000',
            currency: 'UGX',
            internal_reference: 'LP-777',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )

    const polled = await provider.checkPaymentStatus('SACCO-DEP-LEGACY-01', 'UGX')
    assert.equal(polled.success, true)
    assert.equal(polled.status, 'success')
    assert.equal(polled.amount, 10000)
    assert.equal(polled.providerPaymentId, 'LP-777')

    // Confirm both freshly created intents AND existing stuck DB rows where `providerPaymentId === reference` settle cleanly
    assert.equal(
      isConfirmedTerminalStatus(polled, {
        amount: 10000,
        currency: 'UGX',
        providerPaymentId: undefined,
        reference: 'SACCO-DEP-LEGACY-01',
      }),
      true
    )
    assert.equal(
      isConfirmedTerminalStatus(polled, {
        amount: 10000,
        currency: 'UGX',
        providerPaymentId: 'SACCO-DEP-LEGACY-01',
        reference: 'SACCO-DEP-LEGACY-01',
      }),
      true
    )
    // Genuine provider ID mismatch is still strictly rejected
    assert.equal(
      isConfirmedTerminalStatus(polled, {
        amount: 10000,
        currency: 'UGX',
        providerPaymentId: 'LP-OTHER-999',
        reference: 'SACCO-DEP-LEGACY-01',
      }),
      false
    )

    // 3. Declined / Cancelled statuses map to terminal 'failed'
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          transaction: { status: 'Cancelled', amount: 10000, currency: 'UGX', message: 'User cancelled PIN prompt' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    const declined = await provider.checkPaymentStatus('SACCO-DEP-LEGACY-02', 'UGX')
    assert.equal(declined.status, 'failed')
    assert.equal(declined.failureReason, 'User cancelled PIN prompt')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('tenant config using platform LivePay credentials inherits LIVEPAY_WEBHOOK_SECRET and Netlify URL is in signature candidates', async () => {
  const prev = {
    nodeEnv: process.env.NODE_ENV,
    nextAuthUrl: process.env.NEXTAUTH_URL,
    netlifyUrl: process.env.URL,
    apiKey: process.env.LIVEPAY_API_KEY,
    accountNo: process.env.LIVEPAY_ACCOUNT_NO,
    webhookSecret: process.env.LIVEPAY_WEBHOOK_SECRET,
  }
  try {
    process.env.NODE_ENV = 'production'
    delete process.env.NEXTAUTH_URL
    process.env.URL = 'https://najiki.netlify.app/'
    process.env.LIVEPAY_API_KEY = 'platform_live_api_key'
    process.env.LIVEPAY_ACCOUNT_NO = 'PLATFORM_ACC_001'
    process.env.LIVEPAY_WEBHOOK_SECRET = 'real_platform_webhook_secret_123456'

    const candidates = buildSignatureUrlCandidates(
      new Request('https://najiki.netlify.app/api/webhooks/livepay', { method: 'POST' })
    )
    assert.deepEqual(candidates, ['https://najiki.netlify.app/api/webhooks/livepay'])

    const tenantCredsMod = loadTsModule<{
      resolveTenantOrPlatformCredentials: (
        tenantId: string,
        providerId: string,
        tenantCode?: string | null
      ) => Promise<{ source: string; credentials: any } | null>
    }>('src/lib/tenant-credentials.ts', {
      './db': {
        db: {
          tenantProviderConfig: {
            findFirst: async () => ({
              id: 'kun-sac-cfg',
              credentialsRef: null,
              configJson: {
                _encrypted: JSON.stringify({
                  apiKey: 'platform_live_api_key',
                  accountNo: 'PLATFORM_ACC_001',
                  webhookSecret: '',
                  baseUrl: 'https://livepay.me',
                }),
              },
            }),
          },
        },
      },
      './encryption': { decrypt: (s: string) => s },
      './payment-security': { parseTenantProviderCredentials },
    })

    const resolved = await tenantCredsMod.resolveTenantOrPlatformCredentials('t-kunsac', 'prov-lp', 'kun-sac')
    assert.equal(resolved?.source, 'tenant')
    assert.equal(resolved?.credentials?.webhookSecret, 'real_platform_webhook_secret_123456')
  } finally {
    for (const [k, v] of [
      ['NODE_ENV', prev.nodeEnv],
      ['NEXTAUTH_URL', prev.nextAuthUrl],
      ['URL', prev.netlifyUrl],
      ['LIVEPAY_API_KEY', prev.apiKey],
      ['LIVEPAY_ACCOUNT_NO', prev.accountNo],
      ['LIVEPAY_WEBHOOK_SECRET', prev.webhookSecret],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('enqueueWebhookNotification delivers synchronously with exact HMAC, retries fallback API key on 401, and self-heals legacy 404 path', async () => {
  const deliveries: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  let deliveredCount = 0

  const paymentsMod = loadTsModule<{
    enqueueWebhookNotification: (data: any) => Promise<void>
  }>('src/lib/payments.ts', {
    './db': {
      db: {
        internalNotification: {
          updateMany: async () => {
            deliveredCount++
            return { count: 1 }
          },
          findMany: async () => [],
        },
      },
    },
    './providers': { getPaymentProvider: () => ({}) },
    './tenant-credentials': { resolveTenantOrPlatformCredentials: async () => null },
    './constants': { isPlatformFeeType, resolvePartnerWebhookUrl, appRequiresTenantCredentials: () => false },
    './money': { toMinorUnits: (a: number) => BigInt(a) },
    './application-auth': { webhookSecretFromRow: () => 'primary_whsec_unused_by_partner_env' },
    './json': { safeJsonObject: (v: any) => v || {} },
    '@upstash/qstash': {
      Client: class FakeQStash {
        async publishJSON() {
          throw new Error('QStash must NOT be called before synchronous direct delivery attempts')
        }
      },
    },
    './safe-fetch': {
      validateSafeUrl: async () => {},
      safeFetch: async (url: string, init: any) => {
        deliveries.push({ url, headers: init.headers, body: init.body })
        // Simulate ChurchOS returning 404 on legacy /api/internal/payment-completed
        if (url.endsWith('/api/internal/payment-completed')) {
          return new Response('Not Found', { status: 404 })
        }
        // Simulate partner verifying with NAJIKI_API_KEY because NAJIKI_WEBHOOK_SECRET was unset
        const ok = verifyNotificationSignature({
          secret: 'njk_live_partner_api_key_fallback',
          payloadString: init.body,
          timestamp: init.headers['X-Najiki-Timestamp'],
          signature: init.headers['X-Najiki-Signature'],
        })
        return ok
          ? new Response(JSON.stringify({ success: true }), { status: 200 })
          : new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 })
      },
    },
    './notification-signature': loadTsModule('src/lib/notification-signature.ts'),
    './backoff': loadTsModule('src/lib/backoff.ts'),
  })

  const prevQstash = process.env.QSTASH_TOKEN
  process.env.QSTASH_TOKEN = 'qstash_present_in_env'
  try {
    await paymentsMod.enqueueWebhookNotification({
      paymentIntentId: 'pi_test_1',
      reference: 'SACCO-DEP-LIVE-01',
      status: 'success',
      amount: 5000,
      currency: 'UGX',
      providerPaymentId: 'LP-LIVE-01',
      applicationId: 'app_sacco',
      webhookUrl: 'https://partner.example.org/api/internal/payment-completed',
      webhookSecret: 'primary_whsec_not_copied_to_partner',
      fallbackWebhookSecret: 'njk_live_partner_api_key_fallback',
      externalEntityId: '0345696a-004c-4aca-9ab9-f8d1a589877f',
      tenantId: 't_kunsac',
      tenantCode: 'kun-sac',
      paymentTypeCode: 'deposit',
      metadata: { memberId: '0345696a-004c-4aca-9ab9-f8d1a589877f', paymentTypeCode: 'deposit' },
    })

    assert.equal(deliveredCount, 1)
    assert.equal(deliveries.length, 3)
    assert.equal(deliveries[0].url, 'https://partner.example.org/api/internal/payment-completed')
    assert.equal(deliveries[1].url, 'https://partner.example.org/api/webhooks/najiki')
    assert.equal(deliveries[2].url, 'https://partner.example.org/api/webhooks/najiki')
    const sentPayload = JSON.parse(deliveries[2].body)
    assert.equal(sentPayload.paymentType, 'deposit')
    assert.equal(sentPayload.paymentTypeCode, 'deposit')
    assert.equal(sentPayload.status, 'success')
  } finally {
    if (prevQstash === undefined) delete process.env.QSTASH_TOKEN
    else process.env.QSTASH_TOKEN = prevQstash
  }
})

test('LivePayProvider tunnels outbound requests through LIVEPAY_PROXY_URL HTTP CONNECT static-IP proxy', async () => {
  const http = await import('node:http')
  const net = await import('node:net')
  const { LivePayProvider } = loadTsModule<{ LivePayProvider: any }>('src/lib/providers/livepay.ts', {
    '@/lib/phone': { normalizePhone },
  })

  // 1. Mock LivePay HTTP origin server
  let originSawAuth = ''
  const originServer = http.createServer((req, res) => {
    originSawAuth = String(req.headers.authorization || '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        success: true,
        internal_reference: 'LP-STATIC-IP-001',
        status: 'Successful',
        amount: 2500,
        currency: 'UGX',
      })
    )
  })
  await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()))
  const originPort = (originServer.address() as any).port

  // 2. Local HTTP CONNECT static-IP tunnel proxy requiring Basic credentials
  let proxyConnects = 0
  let proxyAuthHeader = ''
  const proxyServer = http.createServer()
  proxyServer.on('connect', (req, clientSocket, head) => {
    proxyConnects++
    proxyAuthHeader = String(req.headers['proxy-authorization'] || '')
    const [host, portStr] = String(req.url || '').split(':')
    const upstream = net.connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
  })
  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', () => resolve()))
  const proxyPort = (proxyServer.address() as any).port

  const prevProxy = process.env.LIVEPAY_PROXY_URL
  process.env.LIVEPAY_PROXY_URL = `"http://staticuser:staticpass@127.0.0.1:${proxyPort}"`
  try {
    const provider = new LivePayProvider({
      apiKey: 'lp_live_static_key',
      accountNo: 'LP260099',
      webhookSecret: 'lpwhsec_0123456789abcdef',
      baseUrl: `http://127.0.0.1:${originPort}`,
    })

    const init = await provider.initiatePayment({
      amount: 2500,
      currency: 'UGX',
      phoneNumber: '0744827730',
      reference: 'SACCO-DEP-STATIC-1',
    })
    assert.equal(init.success, true)
    assert.equal(init.providerPaymentId, 'LP-STATIC-IP-001')

    const polled = await provider.checkPaymentStatus('SACCO-DEP-STATIC-1', 'UGX')
    assert.equal(polled.status, 'success')
    assert.equal(proxyConnects, 2)
    assert.equal(
      proxyAuthHeader,
      `Basic ${Buffer.from('staticuser:staticpass').toString('base64')}`
    )
    assert.equal(originSawAuth, 'Bearer lp_live_static_key')
  } finally {
    if (prevProxy === undefined) delete process.env.LIVEPAY_PROXY_URL
    else process.env.LIVEPAY_PROXY_URL = prevProxy
    proxyServer.close()
    originServer.close()
  }
})

test('LivePay official 3-field HMAC webhook signature + flat /api/transaction-status payload verify and settle cleanly', async () => {
  const nodeCrypto = await import('node:crypto')
  const { LivePayProvider } = loadTsModule<{ LivePayProvider: any }>('src/lib/providers/livepay.ts', {
    '@/lib/phone': { normalizePhone },
  })

  const secret = 'dpal_webhook_secret_oct21_2026_real'
  const webhookUrl = 'https://najiki.netlify.app/api/webhooks/livepay'
  const provider = new LivePayProvider({
    apiKey: 'lp_live_dpal_key',
    accountNo: 'LP26000001',
    webhookSecret: secret,
    baseUrl: 'https://livepay.me',
  })

  // Official docs.livepay.me flat webhook payload + 3-param HMAC (customer_reference, internal_reference, status)
  const payloadObj = {
    status: 'Success',
    message: 'Collection successful',
    customer_reference: 'SACCO-DEP-5EE72A17-76A9CC3E9C',
    internal_reference: 'LP26998877',
    provider_transaction_id: 'MTN-998877',
    msisdn: '+256744827730',
    amount: 5000,
    currency: 'UGX',
    provider: 'MTN',
    charge: 150,
    completed_at: '2026-10-21T14:40:00Z',
  }
  const rawBody = JSON.stringify(payloadObj)
  const tsNow = String(Math.floor(Date.now() / 1000))
  const officialStringToSign =
    `${webhookUrl}${tsNow}` +
    `customer_reference${payloadObj.customer_reference}` +
    `internal_reference${payloadObj.internal_reference}` +
    `status${payloadObj.status}`
  const sigHex = nodeCrypto.createHmac('sha256', secret).update(officialStringToSign, 'utf8').digest('hex')

  const valid = await provider.validateWebhookSignature(
    rawBody,
    `t=${tsNow},v=${sigHex}`,
    { 'x-webhook-signature': `t=${tsNow},v=${sigHex}` },
    webhookUrl
  )
  assert.equal(valid, true)

  // Tampered status must fail closed
  const tamperedValid = await provider.validateWebhookSignature(
    JSON.stringify({ ...payloadObj, customer_reference: 'SACCO-DEP-OTHER' }),
    `t=${tsNow},v=${sigHex}`,
    { 'x-webhook-signature': `t=${tsNow},v=${sigHex}` },
    webhookUrl
  )
  assert.equal(tamperedValid, false)

  // Parsed webhook preserves exact reference, internal_reference, amount, currency, and normalized status
  const parsed = await provider.parseWebhookPayload(payloadObj)
  assert.equal(parsed.status, 'success')
  assert.equal(parsed.reference, 'SACCO-DEP-5EE72A17-76A9CC3E9C')
  assert.equal(parsed.providerPaymentId, 'LP26998877')
  assert.equal(parsed.amount, 5000)
  assert.equal(parsed.currency, 'UGX')

  // Flat HTTP 200 `/api/transaction-status` WITHOUT `success: true` AND internal_reference fallback both work
  const originalFetch = globalThis.fetch
  try {
    let calls = 0
    globalThis.fetch = async (input: any) => {
      calls++
      const u = new URL(String(input))
      const queriedRef = u.searchParams.get('reference')
      if (queriedRef === 'SACCO-DEP-5EE72A17-76A9CC3E9C') {
        return new Response(JSON.stringify({ message: 'Not found by customer reference' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      assert.equal(queriedRef, 'LP26998877')
      return new Response(JSON.stringify(payloadObj), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const statusRes = await provider.checkPaymentStatus(
      'SACCO-DEP-5EE72A17-76A9CC3E9C',
      'UGX',
      'LP26998877'
    )
    assert.equal(calls, 2)
    assert.equal(statusRes.success, true)
    assert.equal(statusRes.status, 'success')
    assert.equal(statusRes.amount, 5000)
    assert.equal(statusRes.currency, 'UGX')
    assert.equal(statusRes.providerPaymentId, 'LP26998877')
    assert.equal(
      isConfirmedTerminalStatus(statusRes, {
        amount: 5000,
        currency: 'UGX',
        providerPaymentId: 'LP26998877',
        reference: 'SACCO-DEP-5EE72A17-76A9CC3E9C',
      }),
      true
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})



