/**
 * Configuring the Church app's webhooks from the dashboard.
 *
 * Until now the Setup page could create an application but never edit its
 * delivery endpoint, never showed the URL settlements are POSTed to, and had no
 * way to read the signing secret — so the values the partner needs lived only in
 * a terminal session. These tests drive the real `/api/setup` handler (with the
 * real AES-256-GCM encryption and the real signing-secret resolver) and the real
 * summary helper the page renders from.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './helpers/ts-load.ts'
import { createFakeDb, type Row } from './helpers/fake-db.ts'
import { loadTsModule, srcPath } from './helpers/ts-load.ts'

// The encryption key the API will actually use, so a secret encrypted here is
// the secret `webhookSecretFromRow` decrypts there — not a stub of it.
process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64)
process.env.NEXTAUTH_URL = 'https://gateway.najiki.test'

const { describeApplicationWebhook, inboundWebhookEndpoints } = loadTsModule<any>(
  'src/lib/application-webhook-status.ts',
  {}
)

const { encrypt } = loadTsModule<{ encrypt: (value: string) => string }>('src/lib/encryption.ts', {})
const { webhookSecretFromRow } = loadTsModule<any>('src/lib/application-auth.ts', {
  [srcPath('lib/db.ts')]: { db: {} },
})

const SIGNING_SECRET = 'njk_whsec_church_outbound_signing_secret'

// ── The summary the dashboard renders ───────────────────────────────────────

test('setup: the summary resolves the exact URL settlements are POSTed to', () => {
  const view = describeApplicationWebhook({
    code: 'church',
    baseUrl: 'https://church.najiki.test',
    webhookPath: '/api/webhooks/najiki',
    hasWebhookSecret: true,
  })

  assert.equal(view.webhookUrl, 'https://church.najiki.test/api/webhooks/najiki')
  assert.equal(view.webhookSecretSet, true)
  assert.equal(view.deliverable, true)
  assert.deepEqual(view.issues, [])
})

test('setup: a placeholder base URL is reported as undeliverable, not as a warning', () => {
  // This is the value scripts/seed.ts writes. The outbound guard refuses it and
  // marks the notification failed_exhausted, so "warning" would be a lie.
  const view = describeApplicationWebhook({
    code: 'church',
    baseUrl: 'https://church.yourdomain.com',
    webhookPath: '/api/internal/payment-completed',
    hasWebhookSecret: true,
  })

  assert.equal(view.deliverable, false)
  const placeholder = view.issues.find((issue: any) => issue.code === 'placeholder-base-url')
  assert.ok(placeholder)
  assert.equal(placeholder.level, 'error')
  assert.match(placeholder.message, /NO notification is ever delivered/)
})

test('setup: a missing signing secret is an error, because notifications would be unsigned', () => {
  const view = describeApplicationWebhook({
    code: 'church',
    baseUrl: 'https://church.najiki.test',
    webhookPath: '/api/webhooks/najiki',
    hasWebhookSecret: false,
  })

  assert.equal(view.deliverable, false)
  assert.equal(view.webhookSecretSet, false)
  assert.ok(view.issues.some((i: any) => i.code === 'missing-secret' && i.level === 'error'))
})

test('setup: a secret that will not decrypt is reported separately from a missing one', () => {
  const view = describeApplicationWebhook({
    code: 'church',
    baseUrl: 'https://church.najiki.test',
    webhookPath: '/api/webhooks/najiki',
    hasWebhookSecret: true,
    secretUndecryptable: true,
  })

  assert.equal(view.deliverable, false)
  assert.equal(view.webhookSecretSet, false, 'a secret we cannot read cannot sign anything')
  assert.ok(view.issues.some((i: any) => i.code === 'secret-undecryptable'))
})

test('setup: plain HTTP and the legacy path are warnings, not blockers', () => {
  const view = describeApplicationWebhook({
    code: 'church',
    baseUrl: 'http://church.najiki.test',
    webhookPath: '/api/internal/payment-completed',
    hasWebhookSecret: true,
  })

  assert.equal(view.deliverable, true)
  assert.ok(view.issues.some((i: any) => i.code === 'plain-http' && i.level === 'warning'))
  assert.ok(view.issues.some((i: any) => i.code === 'legacy-path' && i.level === 'warning'))
})

test('setup: an empty base URL never produces a malformed URL', () => {
  const view = describeApplicationWebhook({
    code: 'church',
    baseUrl: '',
    webhookPath: '/api/webhooks/najiki',
    hasWebhookSecret: true,
  })

  assert.equal(view.webhookUrl, '')
  assert.equal(view.deliverable, false)
  assert.ok(view.issues.some((i: any) => i.code === 'missing-base-url'))
})

test('setup: the inbound endpoints to copy into the provider portals are derived from the origin', () => {
  const endpoints = inboundWebhookEndpoints('https://gateway.najiki.test/')
  assert.equal(endpoints.livepay, 'https://gateway.najiki.test/api/webhooks/livepay')
  assert.equal(endpoints.africastalking, 'https://gateway.najiki.test/api/webhooks/africastalking')
  assert.equal(endpoints.origin, 'https://gateway.najiki.test')

  const missing = inboundWebhookEndpoints(null)
  assert.equal(missing.livepay, null, 'an unconfigured origin must not render a plausible-looking URL')
})

// ── The API ────────────────────────────────────────────────────────────────

function churchApplication(overrides: Row = {}): Row {
  return {
    id: 'app_church',
    code: 'church',
    name: 'Church App',
    baseUrl: 'https://church.yourdomain.com',
    webhookPath: '/api/internal/payment-completed',
    internalSecretRef: 'CHURCH_INTERNAL_SECRET',
    apiKey: null,
    apiKeyHash: 'sha256-of-the-app-key',
    apiKeyHint: 'abcd1234',
    webhookSecretEncrypted: encrypt(SIGNING_SECRET),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    tenants: [],
    paymentTypes: [],
    ...overrides,
  }
}

type SetupRoute = {
  GET: () => Promise<Response>
  POST: (request: Request) => Promise<Response>
}

function loadSetupRoute(seed: { application?: Row[] } = {}) {
  const db = createFakeDb({
    application: seed.application ?? [churchApplication()],
    provider: [{ id: 'prov_livepay', code: 'livepay', name: 'LivePay', isActive: true, credentialsRef: '' }],
    tenantProviderConfig: [],
    tenant: [],
  })

  const route = loadTsModule<SetupRoute>('src/app/api/setup/route.ts', {
    [srcPath('lib/db.ts')]: { db },
    '@/lib/auth': {
      requireSuperAdmin: async () => ({ id: 'admin_1', email: 'admin@najiki.test', role: 'super_admin' }),
    },
  })

  return { route, db }
}

function post(body: unknown): Request {
  return new Request('https://gateway.najiki.test/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('setup API: the list exposes the webhook URL and secret status but never the secret', async () => {
  const { route } = loadSetupRoute()
  const response = await route.GET()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0')

  const body: any = await response.json()
  const app = body.applications[0]

  assert.equal(app.webhookUrl, 'https://church.yourdomain.com/api/internal/payment-completed')
  assert.equal(app.webhookSecretSet, true)
  assert.equal(app.webhookDeliverable, false, 'the seeded placeholder host cannot deliver')
  assert.ok(app.webhookIssues.some((i: any) => i.code === 'placeholder-base-url'))

  // Nothing secret in the payload.
  const serialized = JSON.stringify(body)
  assert.equal(serialized.includes(SIGNING_SECRET), false, 'the secret must never be listed')
  assert.equal(serialized.includes('sha256-of-the-app-key'), false, 'the key hash must never be listed')
  assert.equal('webhookSecretEncrypted' in app, false)
  assert.equal('apiKeyHash' in app, false)

  // And the inbound half the operator has to give the providers.
  assert.equal(body.inbound.livepay, 'https://gateway.najiki.test/api/webhooks/livepay')
})

test('setup API: the endpoint can be edited from the dashboard and the save reports the new URL', async () => {
  const { route, db } = loadSetupRoute()

  const response = await route.POST(
    post({
      type: 'updateApplication',
      data: {
        id: 'app_church',
        name: 'Church App',
        baseUrl: 'https://church.najiki.app',
        webhookPath: '/api/webhooks/najiki',
        internalSecretRef: 'CHURCH_INTERNAL_SECRET',
        isActive: true,
      },
    })
  )

  assert.equal(response.status, 200)
  const saved: any = await response.json()

  assert.equal(saved.webhookUrl, 'https://church.najiki.app/api/webhooks/najiki')
  assert.equal(saved.webhookDeliverable, true, 'a real host with a secret is deliverable')
  assert.match(saved.message, /https:\/\/church\.najiki\.app\/api\/webhooks\/najiki/)

  // Persisted, not just echoed.
  const row = db.rows.application[0]
  assert.equal(row.baseUrl, 'https://church.najiki.app')
  assert.equal(row.webhookPath, '/api/webhooks/najiki')

  // And the response does not carry secrets.
  const serialized = JSON.stringify(saved)
  assert.equal(serialized.includes(SIGNING_SECRET), false)
  assert.equal(serialized.includes('sha256-of-the-app-key'), false)
})

test('setup API: a webhook path that is not a path is rejected instead of persisted', async () => {
  const { route, db } = loadSetupRoute()

  const response = await route.POST(
    post({
      type: 'updateApplication',
      data: {
        id: 'app_church',
        name: 'Church App',
        baseUrl: 'https://church.najiki.app',
        webhookPath: 'https://church.najiki.app/api/webhooks/najiki',
        isActive: true,
      },
    })
  )

  assert.equal(response.status, 400)
  // Would otherwise have produced "https://hosthttps://host/api/..." at send time.
  assert.equal(db.rows.application[0].webhookPath, '/api/internal/payment-completed')
})

test('setup API: the signing secret can be revealed on demand, and it is the one signing uses', async () => {
  const { route } = loadSetupRoute()

  const response = await route.POST(post({ type: 'revealWebhookSecret', data: { id: 'app_church' } }))
  assert.equal(response.status, 200)

  const body: any = await response.json()
  assert.equal(body.webhookSecret, SIGNING_SECRET)
  assert.equal(body.code, 'church')
  assert.match(body.note, /HMAC key/)

  // The value handed to the operator is exactly what the sender resolves for
  // signing, checked through the real resolver rather than by comparing strings.
  const resolved = webhookSecretFromRow({
    webhookSecretEncrypted: churchApplication().webhookSecretEncrypted,
  })
  assert.equal(body.webhookSecret, resolved)
})

test('setup API: revealing is refused when there is no usable secret, with the fix in the message', async () => {
  const { route } = loadSetupRoute({
    application: [churchApplication({ webhookSecretEncrypted: null, apiKey: null })],
  })

  const response = await route.POST(post({ type: 'revealWebhookSecret', data: { id: 'app_church' } }))
  assert.equal(response.status, 400)

  const body: any = await response.json()
  assert.match(body.error, /Rotate the webhook secret/)
})

test('setup API: revealing refuses a secret encrypted under a different key instead of returning garbage', async () => {
  // A blob from another deployment (or from before a key rotation).
  const foreignBlob = (() => {
    const key = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update('njk_whsec_other_env', 'utf8'), cipher.final()])
    return JSON.stringify({
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data: encrypted.toString('hex'),
    })
  })()

  const { route } = loadSetupRoute({
    application: [churchApplication({ webhookSecretEncrypted: foreignBlob })],
  })

  const response = await route.POST(post({ type: 'revealWebhookSecret', data: { id: 'app_church' } }))
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /cannot be decrypted|Rotate/)
})

test('setup API: a new application still returns its key and signing secret exactly once', async () => {
  const { route, db } = loadSetupRoute({ application: [] })

  const response = await route.POST(
    post({
      type: 'application',
      data: {
        code: 'church',
        name: 'Church App',
        baseUrl: 'https://church.najiki.app',
        webhookPath: '/api/webhooks/najiki',
        internalSecretRef: 'CHURCH_INTERNAL_SECRET',
        isActive: true,
      },
    })
  )

  assert.equal(response.status, 200)
  const created: any = await response.json()

  assert.match(created.apiKey, /^njk_/)
  assert.match(created.webhookSecret, /^njk_whsec_/)
  assert.equal('apiKeyHash' in created, false, 'the hash has no business in a browser')

  // The stored secret resolves to the value that was shown.
  assert.equal(webhookSecretFromRow(db.rows.application[0]), created.webhookSecret)
  // …and the default path is no longer the legacy one.
  assert.equal(db.rows.application[0].webhookPath, '/api/webhooks/najiki')
})

// ── Source-level guard ─────────────────────────────────────────────────────

test('setup UI: no form reads a value out of a Radix Switch', () => {
  // `Switch` renders a `<button role="switch">`, which never participates in
  // form submission — so `new FormData(form).get('isActive')` is always null and
  // `=== 'on'` is always false. Every application, provider and tenant created
  // from this page was therefore stored inactive: the church app would have
  // rejected every request until someone noticed the badge. The switches are
  // controlled state now, and this guard keeps them that way.
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/app/setup/page.tsx'), 'utf8')

  assert.equal(
    /formData\.get\(['"]isActive['"]\)/.test(source),
    false,
    'isActive must come from component state, not FormData — a Radix Switch submits nothing'
  )
  assert.equal(
    /<Switch\s+name=/.test(source),
    false,
    'a `name` on Switch does nothing; bind checked/onCheckedChange instead'
  )

  // And the values the handlers actually send are the controlled ones.
  for (const state of ['newAppIsActive', 'editAppIsActive', 'newProviderIsActive', 'newTenantIsActive']) {
    assert.match(source, new RegExp(`isActive: ${state}`), `${state} must be what is submitted`)
  }
})
