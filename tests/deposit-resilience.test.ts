import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import ts from 'typescript'
import { isPlatformFeeType, resolvePartnerWebhookUrl } from '../src/lib/constants.ts'
import { parseTenantProviderCredentials } from '../src/lib/payment-security.ts'
import { normalizePhone } from '../src/lib/phone.ts'

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
