import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import ts from 'typescript'
import { isPlatformFeeType, resolvePartnerWebhookUrl } from '../src/lib/constants.ts'
import { parseTenantProviderCredentials } from '../src/lib/payment-security.ts'

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
