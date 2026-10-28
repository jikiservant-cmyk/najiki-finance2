/**
 * Rotating an application's credentials from the dashboard.
 *
 * The reported failure was "I rotate the API key and I cannot copy it". There
 * were three causes, and only one of them was the clipboard:
 *
 *   1. the new key was rendered in a banner at the very top of the page, above
 *      the tabs, while the button that produced it sits at the bottom of a card
 *      — so it appeared off-screen and looked like nothing had happened;
 *   2. `copyToClipboard` was a bare `navigator.clipboard.writeText()` followed by
 *      an unconditional success message, so it reported success while copying
 *      nothing whenever the clipboard API was unavailable or refused;
 *   3. rotating the *signing secret* also rotated the API key, because the
 *      server treated `{ rotateWebhookSecret: true }` as "rotate both". Fixing a
 *      signature problem therefore silently broke the partner's authentication.
 *
 * (3) is a server bug and is driven for real below. (1) and (2) are rendering
 * behaviour that this runner cannot execute without a browser, so they are
 * guarded at the source level — the assertions are about the shapes that caused
 * the bug, not about prose.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeDb, type Row } from './helpers/fake-db.ts'
import { loadTsModule, srcPath, REPO_ROOT } from './helpers/ts-load.ts'

process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64)
process.env.NEXTAUTH_URL = 'https://gateway.najiki.test'

const { encrypt } = loadTsModule<{ encrypt: (value: string) => string }>('src/lib/encryption.ts', {})
const { webhookSecretFromRow } = loadTsModule<any>('src/lib/application-auth.ts', {
  [srcPath('lib/db.ts')]: { db: {} },
})
const { verifyApiKey } = loadTsModule<any>('src/lib/api-keys.ts', {})

const ORIGINAL_SECRET = 'njk_whsec_church_original_signing_secret'
const ORIGINAL_API_KEY = 'njk_live_church_original_api_key_123456'

function churchApplication(overrides: Row = {}): Row {
  // Seeded the way the create path stores it: hash only, cleartext nulled.
  return {
    id: 'app_church',
    code: 'church',
    name: 'Church App',
    baseUrl: 'https://church.najiki.app',
    webhookPath: '/api/webhooks/najiki',
    internalSecretRef: '',
    apiKey: null,
    apiKeyHash: loadTsModule<any>('src/lib/api-keys.ts', {}).hashApiKey(ORIGINAL_API_KEY),
    apiKeyHint: ORIGINAL_API_KEY.slice(-4),
    apiKeyRotatedAt: null,
    webhookSecretEncrypted: encrypt(ORIGINAL_SECRET),
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

function loadSetupRoute(seed: Row[] = [churchApplication()]) {
  const db = createFakeDb({
    application: seed,
    provider: [],
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

const storedSecret = (row: Row) => webhookSecretFromRow({ webhookSecretEncrypted: row.webhookSecretEncrypted })

// ── The server: the two rotations are independent ───────────────────────────

test('rotate: the signing secret can be replaced without touching the API key', async () => {
  // This is the bug: `{ rotateWebhookSecret: true }` used to issue a new API key
  // as well. The operator was fixing a partner's verification and broke its
  // authentication at the same moment — and the new key was displayed once.
  const original = churchApplication()
  const { route, db } = loadSetupRoute([original])

  const response = await route.POST(
    post({ type: 'rotateApplication', data: { id: 'app_church', rotateWebhookSecret: true } })
  )
  assert.equal(response.status, 200)

  const body: any = await response.json()
  const row = db.rows.application[0]

  // The secret changed…
  assert.match(body.webhookSecret, /^njk_whsec_/)
  assert.notEqual(body.webhookSecret, ORIGINAL_SECRET)
  assert.equal(storedSecret(row), body.webhookSecret)

  // …and the key did not.
  assert.equal(body.apiKey, undefined, 'no new API key may be issued by a secret rotation')
  assert.equal(body.apiKeyRotated, false)
  assert.equal(body.webhookSecretRotated, true)
  assert.equal(row.apiKeyHash, original.apiKeyHash, 'the key hash must be untouched')
  assert.equal(row.apiKeyHint, original.apiKeyHint)
  assert.equal(verifyApiKey(ORIGINAL_API_KEY, row.apiKeyHash), true, 'the partner key still authenticates')
})

test('rotate: the API key can be replaced without touching the signing secret', async () => {
  const original = churchApplication()
  const { route, db } = loadSetupRoute([original])

  const response = await route.POST(
    post({ type: 'rotateApplication', data: { id: 'app_church', rotateApiKey: true } })
  )
  assert.equal(response.status, 200)

  const body: any = await response.json()
  const row = db.rows.application[0]

  assert.match(body.apiKey, /^njk_/)
  assert.equal(body.apiKeyRotated, true)
  assert.equal(body.webhookSecretRotated, false)
  assert.equal(body.webhookSecret, undefined)

  // The partner's notifications must keep verifying with the secret it holds.
  assert.equal(storedSecret(row), ORIGINAL_SECRET)

  // And the old key is dead: neither the hash nor a cleartext fallback matches.
  assert.notEqual(row.apiKeyHash, original.apiKeyHash)
  assert.equal(verifyApiKey(ORIGINAL_API_KEY, row.apiKeyHash), false)
  assert.equal(row.apiKey, null, 'the legacy cleartext column must be emptied')
})

test('rotate: a bare { id } still means "new API key", and only that', async () => {
  // The original call shape, kept working — the dashboard is not the only
  // caller, and an operator following an old runbook must not lose a secret.
  const { route, db } = loadSetupRoute()

  const response = await route.POST(post({ type: 'rotateApplication', data: { id: 'app_church' } }))
  assert.equal(response.status, 200)

  const body: any = await response.json()
  assert.match(body.apiKey, /^njk_/)
  assert.equal(body.webhookSecret, undefined)
  assert.equal(storedSecret(db.rows.application[0]), ORIGINAL_SECRET)
})

test('rotate: both credentials can be rotated in one deliberate action', async () => {
  const { route, db } = loadSetupRoute()

  const response = await route.POST(
    post({
      type: 'rotateApplication',
      data: { id: 'app_church', rotateApiKey: true, rotateWebhookSecret: true },
    })
  )
  assert.equal(response.status, 200)

  const body: any = await response.json()
  assert.match(body.apiKey, /^njk_/)
  assert.match(body.webhookSecret, /^njk_whsec_/)
  assert.equal(body.apiKeyRotated, true)
  assert.equal(body.webhookSecretRotated, true)
  assert.equal(storedSecret(db.rows.application[0]), body.webhookSecret)
})

test('rotate: asking to rotate nothing is refused instead of reporting success', async () => {
  // A typo in the body must not return 200 having changed nothing: the operator
  // would then hand the partner a key that no longer exists.
  const original = churchApplication()
  const { route, db } = loadSetupRoute([original])

  const response = await route.POST(
    post({
      type: 'rotateApplication',
      data: { id: 'app_church', rotateApiKey: false, rotateWebhookSecret: false },
    })
  )

  assert.equal(response.status, 400)
  const body: any = await response.json()
  assert.match(JSON.stringify(body.details ?? body.error), /Nothing to rotate/)

  // Nothing changed.
  assert.equal(db.rows.application[0].apiKeyHash, original.apiKeyHash)
  assert.equal(storedSecret(db.rows.application[0]), ORIGINAL_SECRET)
})

// ── The page: the reporting bug was a UI one ────────────────────────────────

function pageSource(): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'src/app/setup/page.tsx'), 'utf8')
}

test('setup UI: a rotated key is rendered on the card that produced it, not only at the top', () => {
  const source = pageSource()

  // The key is bound to a per-application element with a scroll target, so it
  // cannot be pushed off-screen above the tabs the way the single banner was.
  assert.match(
    source,
    /id=\{`rotated-api-key-\$\{app\.id\}`\}/,
    'the new key must render inline, with a stable id to scroll to'
  )
  assert.match(source, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/)
  assert.match(source, /rotatedCreds\[app\.id\]\?\.apiKey/, 'the card must render the issued key')
  assert.match(source, /onClick=\{\(\) => copyToClipboard\(rotatedCreds\[app\.id\]\.apiKey!\)\}/)
})

test('setup UI: copying reports success only when the clipboard accepted it', () => {
  const source = pageSource()
  const start = source.indexOf('async function copyToClipboard')
  assert.ok(start > 0, 'copyToClipboard must exist')
  const body = source.slice(start, source.indexOf('\n  }', start))

  // The old shape was a bare, unawaited write whose failure went nowhere. Every
  // write must now be awaited, so a rejection reaches the fallback below.
  const writes = body.match(/[^\n]*navigator\.clipboard\.writeText\(text\)/g) ?? []
  assert.ok(writes.length > 0, 'the clipboard API is still the first choice')
  for (const line of writes) {
    assert.match(line, /await\s+navigator\.clipboard\.writeText\(text\)/, `unawaited copy: ${line.trim()}`)
  }
  assert.match(body, /document\.execCommand\('copy'\)/, 'a legacy copy path is required for non-secure contexts')
  assert.match(body, /blocked the clipboard[\s\S]*Ctrl\+C/, 'failure must tell the operator to copy by hand')
  // And it must only claim success inside the branches that worked.
  const successCount = (body.match(/text: 'Copied to clipboard!'/g) ?? []).length
  assert.equal(successCount, 2, 'one success message per path that actually copies')
})

test('setup UI: rotating a secret does not touch the API-key state', () => {
  const source = pageSource()
  const start = source.indexOf('async function handleRotateWebhookSecret')
  assert.ok(start > 0)
  const body = source.slice(start, source.indexOf('\n  }\n', start))

  assert.equal(
    /setNewApiKey/.test(body),
    false,
    'a secret rotation must not surface or replace an API key'
  )
  assert.match(body, /rotateApiKey: false/, 'the request must say the key is not being rotated')
  assert.match(body, /The API key is NOT affected/, 'and the confirmation must say so')
})

test('setup UI: the key is displayed with the prefix it actually has', () => {
  // The banner advertised `Bearer nk_...` while every key is `njk_...`, which is
  // exactly the kind of detail that gets typed into a partner's config by hand.
  assert.equal(/Bearer nk_\.\.\./.test(pageSource()), false, 'wrong key prefix in the banner')
  assert.match(pageSource(), /Bearer njk_\.\.\./)
})
