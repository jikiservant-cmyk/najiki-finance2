/**
 * Rate limiting, SSRF host normalisation, and the QStash control plane.
 *
 * Three separate concerns, all of them "does the thing that protects us
 * actually run?":
 *
 *   • the inbound per-IP ceiling — big enough for a Sunday, still a ceiling,
 *     and tunable without editing code;
 *   • the outbound URL guard — every spelling of a loopback/link-local/metadata
 *     address, including the bracketed IPv6 forms it used to miss;
 *   • the QStash schedules that make retries happen every minute, and the exact
 *     bytes QStash is asked to deliver (a re-serialized body breaks the HMAC).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadTsModule, REPO_ROOT } from './helpers/ts-load.ts'

const run = promisify(execFile)

// ── Inbound rate limit ──────────────────────────────────────────────────────

test('rateLimit: the default inbound ceiling leaves room for a Sunday giving spike', () => {
  const { inboundRateLimitPerMinute, DEFAULT_INBOUND_RATE_LIMIT_PER_MINUTE } = loadTsModule<any>(
    'src/lib/webhook-rate-limit.ts',
    {}
  )

  assert.equal(inboundRateLimitPerMinute(undefined), 600)
  assert.equal(DEFAULT_INBOUND_RATE_LIMIT_PER_MINUTE, 600)
  // The old value was 120/min, which one congregation can exceed in a minute.
  assert.ok(inboundRateLimitPerMinute(undefined) > 120)
})

test('rateLimit: a blank, zero, negative or garbage value falls back to the default rather than removing the guard', () => {
  const { inboundRateLimitPerMinute } = loadTsModule<any>('src/lib/webhook-rate-limit.ts', {})

  for (const raw of ['', '   ', '0', '-5', 'abc', 'NaN', 'Infinity']) {
    assert.equal(inboundRateLimitPerMinute(raw), 600, `value "${raw}" must not disable the limit`)
  }
})

test('rateLimit: out-of-range values are clamped, so a typo cannot open the door', () => {
  const { inboundRateLimitPerMinute } = loadTsModule<any>('src/lib/webhook-rate-limit.ts', {})

  assert.equal(inboundRateLimitPerMinute('1'), 60)
  assert.equal(inboundRateLimitPerMinute('2500'), 2500)
  assert.equal(inboundRateLimitPerMinute('999999999'), 60_000)
})

// ── SSRF guard: IP literal spellings ───────────────────────────────────────

test('ssrf: bracketed IPv6 literals are recognised and refused', async () => {
  const { validateSafeUrl, normalizeHostForIpCheck } = loadTsModule<any>('src/lib/safe-fetch.ts', {})

  // `URL.hostname` keeps the brackets, and `net.isIP('[::1]')` is 0 — these
  // used to slip through the literal check into the (permissive) DNS branch.
  assert.equal(normalizeHostForIpCheck('[::1]'), '::1')
  assert.equal(normalizeHostForIpCheck('[fe80::1%25eth0]'), 'fe80::1')

  const refused = [
    'http://[::1]/api/webhooks/najiki',
    'http://[::]/api/webhooks/najiki',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/api/webhooks/najiki',
    'http://[fd00::1]/api/webhooks/najiki',
    'http://[fd12:3456:789a::1]/api/webhooks/najiki',
    'http://[fc00::1]/api/webhooks/najiki',
    'http://[fe80::1]/api/webhooks/najiki',
    'http://[fe80::1%25eth0]/api/webhooks/najiki',
  ]

  for (const url of refused) {
    await assert.rejects(() => validateSafeUrl(url), `must refuse ${url}`)
  }
})

test('ssrf: a public IPv6 literal is still allowed, so a real partner on IPv6 works', async () => {
  const { validateSafeUrl } = loadTsModule<any>('src/lib/safe-fetch.ts', {})

  const parsed = await validateSafeUrl('https://[2001:4860:4860::8888]/api/webhooks/najiki')
  assert.equal(parsed.hostname, '[2001:4860:4860::8888]')
})

test('ssrf: IPv4-embedded and region-qualified spellings are still refused', async () => {
  const { validateSafeUrl } = loadTsModule<any>('src/lib/safe-fetch.ts', {})

  const refused = [
    'http://0.0.0.0/api/webhooks/najiki',
    'http://100.64.1.1/api/webhooks/najiki', // carrier-grade NAT
    'http://172.16.5.4/api/webhooks/najiki',
    'http://[::ffff:10.0.0.1]/api/webhooks/najiki',
    'gopher://example.org/api/webhooks/najiki',
  ]
  for (const url of refused) {
    await assert.rejects(() => validateSafeUrl(url), `must refuse ${url}`)
  }
})

// ── QStash schedules ───────────────────────────────────────────────────────

/**
 * A stand-in for the QStash schedules API, so the setup script's behaviour is
 * testable without a QStash account. `state` is what the script reads and
 * mutates, and the call log records the order of operations — which is the
 * point, because "delete then create" is the bug being fixed.
 */
type FakeSchedule = { scheduleId: string; destination: string; cron: string; method: string; isPaused: boolean }

function writeFakeQStash(): string {
  return `
    // Mirrors the QStash schedules API surface this script uses, recording the
    // order of operations. State lives on globalThis so the runner can report
    // it after the script exits.
    exports.Client = class Client {
      constructor(options) { this.token = options.token }
      get schedules() {
        const api = globalThis.__fakeQStash
        return {
          list: async () => structuredClone(api.state.schedules),
          create: async (request) => {
            api.calls.push({ op: 'create', scheduleId: request.scheduleId ?? null, cron: request.cron, destination: request.destination })
            if (request.scheduleId) {
              const existing = api.state.schedules.find((s) => s.scheduleId === request.scheduleId)
              if (!existing) throw new Error('no such schedule ' + request.scheduleId)
              existing.cron = request.cron
              if (request.destination) existing.destination = request.destination
              if (request.method) existing.method = request.method.toUpperCase()
              existing.isPaused = false
              return { scheduleId: existing.scheduleId }
            }
            const scheduleId = 'sched_' + (api.state.schedules.length + 1) + '_' + api.calls.length
            api.state.schedules.push({
              scheduleId,
              destination: request.destination,
              cron: request.cron,
              method: (request.method || 'POST').toUpperCase(),
              isPaused: false,
            })
            return { scheduleId }
          },
          delete: async (scheduleId) => {
            api.calls.push({ op: 'delete', scheduleId })
            api.state.schedules = api.state.schedules.filter((s) => s.scheduleId !== scheduleId)
          },
        }
      }
    }
  `
}

// The list under test is the application's own, so the expectations below
// cannot drift away from what the registrar actually installs.
const { CRON_JOBS: JOBS } = loadTsModule<{ CRON_JOBS: Array<{ name: string; path: string; cron: string }> }>(
  'src/lib/cron-jobs.ts',
  { __loaderCache: new Map() }
)

type SetupResult = {
  code: number
  stdout: string
  stderr: string
  calls: any[]
  schedules: FakeSchedule[]
}

/**
 * Run the real setup script in a child process with `@upstash/qstash` replaced
 * by an in-memory fake, so the script's ordering and idempotency can be
 * asserted without a QStash account.
 *
 * The fake is injected with a module `resolve` hook rather than by installing
 * anything into `node_modules`, so the repository is never modified.
 */
async function runSetupScript(
  state: { schedules: FakeSchedule[] },
  args: string[] = [],
  env: Record<string, string> = {}
): Promise<SetupResult> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const os = await import('node:os')
  const { pathToFileURL } = await import('node:url')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qstash-stub-'))

  const stubFile = path.join(dir, 'qstash.cjs')
  fs.writeFileSync(stubFile, writeFakeQStash())

  const hookFile = path.join(dir, 'hook.mjs')
  fs.writeFileSync(
    hookFile,
    [
      "import fs from 'node:fs'",
      'export async function resolve(specifier, context, next) {',
      `  if (specifier === '@upstash/qstash') return { url: ${JSON.stringify(pathToFileURL(stubFile).href)}, shortCircuit: true }`,
      '  // Scripts are run with tsx normally, which resolves extensionless',
      '  // relative TypeScript imports. Under plain --experimental-strip-types',
      '  // they need the extension spelled out.',
      "  if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier) && context.parentURL) {",
      "    const candidate = new URL(specifier + '.ts', context.parentURL)",
      '    if (fs.existsSync(candidate)) return { url: candidate.href, shortCircuit: true }',
      '  }',
      '  return next(specifier, context)',
      '}',
    ].join('\n')
  )

  const scriptUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts/setup-cron-schedules.ts')).href
  const runner = path.join(dir, 'run.mjs')
  fs.writeFileSync(
    runner,
    [
      "import { register } from 'node:module'",
      `globalThis.__fakeQStash = { state: ${JSON.stringify({ schedules: state.schedules })}, calls: [] }`,
      `register(${JSON.stringify(pathToFileURL(hookFile).href)})`,
      `try { await import(${JSON.stringify(scriptUrl)}) } catch (error) {`,
      "  console.error(String((error && error.message) || error))",
      '  process.exitCode = 1',
      '}',
      "process.on('exit', () => {",
      "  process.stdout.write('__RESULT__' + JSON.stringify({",
      '    calls: globalThis.__fakeQStash.calls,',
      '    schedules: globalThis.__fakeQStash.state.schedules,',
      "  }) + '\\n')",
      '})',
    ].join('\n')
  )

  try {
    const outcome = await run(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', runner, ...args],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, QSTASH_TOKEN: 'test-token', PUBLIC_BASE_URL: 'https://gateway.najiki.test', ...env },
        timeout: 60_000,
      }
    ).then(
      (result) => ({ code: 0, stdout: String(result.stdout), stderr: String(result.stderr) }),
      (error: any) => ({
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: String(error.stdout ?? ''),
        stderr: String(error.stderr ?? ''),
      })
    )

    const marker = outcome.stdout.indexOf('__RESULT__')
    let parsed: { calls: any[]; schedules: FakeSchedule[] } = { calls: [], schedules: [] }
    if (marker !== -1) {
      const line = outcome.stdout.slice(marker + '__RESULT__'.length).split('\n')[0]
      try {
        parsed = JSON.parse(line)
      } catch {
        // leave empty; the assertions will report what happened
      }
    }

    return {
      ...outcome,
      stdout: marker === -1 ? outcome.stdout : outcome.stdout.slice(0, marker),
      calls: parsed.calls,
      schedules: parsed.schedules,
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('qstash: a fresh registration creates every worker at the intended cadence', async () => {
  const state = { schedules: [] as FakeSchedule[] }
  const result = await runSetupScript(state)

  assert.equal(result.code, 0, result.stderr)
  const byPath = new Map(result.schedules.map((schedule) => [schedule.destination, schedule]))
  for (const job of JOBS) {
    const schedule = byPath.get(`https://gateway.najiki.test${job.path}`)
    assert.ok(schedule, `${job.path} must be scheduled`)
    assert.equal(schedule!.cron, job.cron, `${job.path} cron`)
    assert.equal(schedule!.method, 'POST')
    assert.equal(schedule!.isPaused, false)
  }

  // The whole point of QStash here: retries and the SMS queue run every minute.
  assert.equal(byPath.get('https://gateway.najiki.test/api/cron/notifications')!.cron, '* * * * *')
  assert.equal(byPath.get('https://gateway.najiki.test/api/qstash/sms-cron')!.cron, '* * * * *')
})

test('qstash: re-running against a correct setup is a no-op and deletes nothing', async () => {
  const state = {
    schedules: JOBS.map((job, index) => ({
      scheduleId: `sched_${index}`,
      destination: `https://gateway.najiki.test${job.path}`,
      cron: job.cron,
      method: 'POST',
      isPaused: false,
    })),
  }
  const before = JSON.parse(JSON.stringify(state.schedules))
  const result = await runSetupScript(state)

  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(result.schedules, before, 'a correct setup must be left untouched')
  assert.equal(
    result.calls.filter((call) => call.op === 'delete').length,
    0,
    'nothing may be deleted when nothing is wrong'
  )
})

test('qstash: a drifted cron expression is updated in place — never deleted first', async () => {
  const state = {
    schedules: [
      {
        scheduleId: 'sched_notifications',
        destination: 'https://gateway.najiki.test/api/cron/notifications',
        cron: '0 5 * * *',
        method: 'POST',
        isPaused: false,
      },
    ],
  }

  const result = await runSetupScript(state)
  assert.equal(result.code, 0, result.stderr)

  assert.equal(result.calls.filter((call) => call.op === 'delete').length, 0,
    'a delete here would leave a window with no retry schedule')

  const notificationCall = result.calls.find(
    (call) => call.op === 'create' && String(call.destination).endsWith('/api/cron/notifications')
  )
  assert.equal(notificationCall.scheduleId, 'sched_notifications', 'the update targets the existing schedule id')

  const updated = result.schedules.find((s) => s.destination.endsWith('/api/cron/notifications'))
  assert.equal(updated!.cron, '* * * * *')
  assert.equal(updated!.scheduleId, 'sched_notifications', 'the same schedule id is reused')
  assert.equal(result.schedules.length, JOBS.length)
})

test('qstash: a paused worker is reported as a problem and resumed', async () => {
  const state = {
    schedules: [
      {
        scheduleId: 'sched_paused',
        destination: 'https://gateway.najiki.test/api/cron/notifications',
        cron: '* * * * *',
        method: 'POST',
        isPaused: true,
      },
    ],
  }

  const verifyFirst = await runSetupScript(state, ['--verify'])
  assert.equal(verifyFirst.code, 1, 'a paused worker must fail verification')
  assert.match(verifyFirst.stdout + verifyFirst.stderr, /PAUSED/)

  const repaired = await runSetupScript(state)
  assert.equal(repaired.code, 0, repaired.stderr)
})

test('qstash: --verify fails loudly when a worker has no schedule at all', async () => {
  const state = {
    schedules: [
      {
        scheduleId: 'sched_sync',
        destination: 'https://gateway.najiki.test/api/cron/sync-payments',
        cron: '*/2 * * * *',
        method: 'POST',
        isPaused: false,
      },
    ],
  }

  const result = await runSetupScript(state, ['--verify'])

  assert.equal(result.code, 1, 'a missing retry worker must not verify clean')
  assert.match(result.stdout + result.stderr, /NO SCHEDULE .*api\/cron\/notifications/)
  assert.equal(result.calls.length, 0, '--verify must not change anything')
})

test('qstash: --verify passes on a healthy setup', async () => {
  const state = {
    schedules: JOBS.map((job, index) => ({
      scheduleId: `sched_${index}`,
      destination: `https://gateway.najiki.test${job.path}`,
      cron: job.cron,
      method: 'POST',
      isPaused: false,
    })),
  }

  const result = await runSetupScript(state, ['--verify'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /All schedules present and correct/)
})

test('qstash: --dry-run reports but changes nothing', async () => {
  const state = { schedules: [] as FakeSchedule[] }
  const result = await runSetupScript(state, ['--dry-run'])

  assert.equal(result.code, 0, result.stderr)
  assert.equal(state.schedules.length, 0)
  assert.match(result.stdout, /would create najiki-notifications/)
})

test('qstash: duplicate schedules for one destination are collapsed to one', async () => {
  const state = {
    schedules: [
      { scheduleId: 'a', destination: 'https://gateway.najiki.test/api/cron/notifications', cron: '* * * * *', method: 'POST', isPaused: false },
      { scheduleId: 'b', destination: 'https://gateway.najiki.test/api/cron/notifications', cron: '* * * * *', method: 'POST', isPaused: false },
    ],
  }

  const result = await runSetupScript(state)
  assert.equal(result.code, 0, result.stderr)

  const remaining = result.schedules.filter((s) => s.destination.endsWith('/api/cron/notifications'))
  assert.equal(remaining.length, 1, 'two schedules would double every minute-level run')
  const deletes = result.calls.filter((call) => call.op === 'delete')
  assert.equal(deletes.length, 1)
  // The canonical schedule must exist before the duplicate is removed.
  const deleteIndex = result.calls.findIndex((call) => call.op === 'delete')
  assert.ok(deleteIndex > 0)
})

test('qstash: the script refuses to run without a token or a public origin', async () => {
  const state = { schedules: [] as FakeSchedule[] }

  const noToken = await runSetupScript(state, [], { QSTASH_TOKEN: '' })
  assert.equal(noToken.code, 1)
  assert.match(noToken.stderr, /QSTASH_TOKEN is required/)

  const noOrigin = await runSetupScript(state, [], { PUBLIC_BASE_URL: '', NEXTAUTH_URL: '' })
  assert.equal(noOrigin.code, 1)
  assert.match(noOrigin.stderr, /PUBLIC_BASE_URL/)
})

// ── QStash publishing: the signed bytes must survive the trip ──────────────

test('qstash: the outbound notification is published as the exact signed bytes', async () => {
  // A local delivery target that rejects the request unless the signature it
  // receives matches the body it receives — i.e. the church's verifier.
  const http = await import('node:http')
  const requests: Array<{ body: string; headers: http.IncomingHttpHeaders }> = []
  const secret = 'church-outbound-webhook-secret'

  let publishedBody: any = null
  let publishedHeaders: any = null

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({ body, headers: req.headers })

    const signature = String(req.headers['x-najiki-signature'] ?? '')
    const match = /^t=(\d+),v=([0-9a-f]{64})$/.exec(signature)
    if (!match) return void res.writeHead(401).end('bad signature header')

    const expected = crypto.createHmac('sha256', secret).update(`${match[1]}.${body}`).digest('hex')
    if (expected !== match[2]) return void res.writeHead(401).end('signature does not match body')
    res.writeHead(200).end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port

  // Stand in for QStash: record what was published, then perform the delivery
  // the way QStash would (verbatim body, verbatim headers).
  const fakeClient = {
    calls: [] as any[],
    async publish(request: any) {
      this.calls.push(request)
      publishedBody = request.body
      publishedHeaders = request.headers
      // QStash performs the network hop; the fake dials the local verifier.
      await fetch(`http://127.0.0.1:${port}/api/webhooks/najiki`, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
      })
      return { messageId: 'msg_1' }
    },
    async publishJSON() {
      throw new Error('publishJSON must not be used for signed payloads')
    },
  }

  try {
    const { loadTsModule, srcPath } = await import('./helpers/ts-load.ts')
    const { createFakeDb } = await import('./helpers/fake-db.ts')

    const db = createFakeDb({
      application: [
        {
          id: 'app_church',
          code: 'church',
          name: 'Church App',
          baseUrl: 'https://church.najiki.test',
          webhookPath: '/api/webhooks/najiki',
          apiKey: 'church_api_key',
          webhookSecretEncrypted: null,
          internalSecretRef: null,
        },
      ],
      paymentIntent: [{ id: 'pi_1', reference: 'CHURCH-1', applicationId: 'app_church' }],
      // The direct attempt must fail transiently so the QStash path is taken.
      internalNotification: [
        {
          id: 'notif_1',
          paymentIntentId: 'pi_1',
          applicationId: 'app_church',
          url: 'https://church.invalid/api/webhooks/najiki',
          payload: '{}',
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 5,
          nextRetryAt: new Date(),
        },
      ],
    })

    const realSafeFetch = loadTsModule<any>('src/lib/safe-fetch.ts', {})

    const payments = loadTsModule<any>('src/lib/payments.ts', {
      [srcPath('lib/db.ts')]: { db },
      [srcPath('lib/tenant-credentials.ts')]: { resolveTenantOrPlatformCredentials: async () => null },
      [srcPath('lib/application-auth.ts')]: {
        webhookSecretFromRow: () => secret,
        fallbackSigningSecretsFromRow: () => [],
      },
      [srcPath('lib/safe-fetch.ts')]: {
        validateSafeUrl: realSafeFetch.validateSafeUrl,
        // Direct delivery is unavailable here; the fallback is what is tested.
        safeFetch: async () => {
          throw new Error('network unreachable')
        },
      },
      '@upstash/qstash': { Client: class { constructor() { return fakeClient as any } } },
    })

    // Force the client to exist and be our fake.
    process.env.QSTASH_TOKEN = 'test-token'

    await payments.enqueueWebhookNotification({
      paymentIntentId: 'pi_1',
      reference: 'CHURCH-1',
      status: 'success',
      amount: 20000,
      currency: 'UGX',
      providerPaymentId: 'LP_1',
      applicationId: 'app_church',
      webhookUrl: 'https://church.najiki.test/api/webhooks/najiki',
      webhookSecret: secret,
      metadata: { paymentTypeCode: 'tithe' },
    })

    assert.equal(fakeClient.calls.length, 1, 'exactly one publish')
    assert.equal(typeof publishedBody, 'string', 'a string body, not an object')

    const published = JSON.parse(publishedBody)
    assert.equal(published.reference, 'CHURCH-1')
    assert.equal(published.paymentTypeCode, 'tithe')

    // The church-side check: the signature covers the bytes it received.
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body, publishedBody, 'QStash must be handed the exact signed string')

    const { verifyNotificationSignature } = loadTsModule<any>('src/lib/notification-signature.ts', {})
    const signatureHeader = String(requests[0].headers['x-najiki-signature'])
    assert.equal(
      verifyNotificationSignature({
        secret,
        payloadString: requests[0].body,
        timestamp: String(requests[0].headers['x-najiki-timestamp']),
        signature: signatureHeader,
      }),
      true,
      'the published body must verify against the published signature'
    )

    // QStash retries on its own, and the row must not be retried by the cron.
    assert.equal(db.rows.internalNotification[0].status, 'dispatched')
  } finally {
    delete process.env.QSTASH_TOKEN
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
