/**
 * Discovering the source addresses for `AFRICASTALKING_ALLOWED_IPS`.
 *
 * Africa's Talking does not publish a list of the addresses it posts delivery
 * reports from — they are handed out on request and changed at cloud
 * migrations — so an operator who wants an allow-list has exactly one way to
 * build one: watch what actually arrives. That only works if the endpoint
 * reports it, which is what these tests pin.
 *
 * The two halves matter for different reasons:
 *
 *  - On rejection the address is logged *unconditionally*. This is the state
 *    the operator is stuck in when the allow-list is wrong, and a bare
 *    "Rejected callback (ip-not-allowed)" names no address, so there is nothing
 *    to correct.
 *  - On acceptance it is logged only under `SMS_CALLBACK_DEBUG_IP`. Turning it
 *    on by default would write caller addresses into the logs of every existing
 *    deployment, which is a privacy decision nobody made.
 *
 * Node's built-in runner; no database, no network.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import ts from 'typescript'

const ROUTE = 'src/app/api/webhooks/africastalking/route.ts'

function load(file: string, stubs: Record<string, unknown>): any {
  const filename = path.resolve(file)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const loaded = new Module(filename)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  const realRequire = loaded.require.bind(loaded)
  loaded.require = (name: string) => (name in stubs ? stubs[name] : realRequire(name))
  loaded._compile(code, filename)
  return loaded.exports
}

const AT_ADDRESS = '41.90.64.12'

type Loaded = { POST: (request: Request) => Promise<Response> }

function loadRoute(options: {
  ok: boolean
  reason?: string
  ip?: string
}): Loaded {
  return load(ROUTE, {
    'next/server': { NextResponse: class extends Response {} },
    '@/lib/sms-store': {
      smsStore: {
        rememberDeliveryReport: async () => {},
        resolveDeliveryReport: async () => null,
      },
    },
    '@/lib/sms-queue': { deliverSmsNotification: async () => true },
    '@/lib/callback-auth': {
      authorizeCallback: () =>
        options.ok ? { ok: true, via: 'query' } : { ok: false, reason: options.reason ?? 'mismatch' },
    },
    '@/lib/client-ip': { resolveClientIp: () => options.ip ?? AT_ADDRESS },
    '@/lib/rate-limit': { checkRateLimit: async () => ({ ok: true }) },
    '@/lib/request-body': {
      readTextWithLimit: (request: Request) => request.text(),
      PayloadTooLargeError: class extends Error {},
    },
  })
}

function callbackRequest(): Request {
  return new Request('https://gateway.example/api/webhooks/africastalking?key=test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ATXid_1', status: 'Success', phoneNumber: '+256700000001' }),
  })
}

/** Run `fn` with console.warn / console.log captured. */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const originalWarn = console.warn
  const originalLog = console.log
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    return { result: await fn(), lines }
  } finally {
    console.warn = originalWarn
    console.log = originalLog
  }
}

test.afterEach(() => {
  delete process.env.SMS_CALLBACK_DEBUG_IP
})

test('a rejected callback names the address it came from', async () => {
  const env = { ...process.env }
  process.env.NODE_ENV = 'test'
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'secret'
  const { POST } = loadRoute({ ok: false, reason: 'ip-not-allowed' })

  const { result: response, lines } = await capture(() => POST(callbackRequest()))

  assert.equal(response.status, 401)
  const rejection = lines.find((line) => line.includes('Rejected callback'))
  assert.ok(rejection, `expected a rejection log, got: ${JSON.stringify(lines)}`)
  assert.match(rejection!, /ip-not-allowed/)
  assert.ok(rejection!.includes(AT_ADDRESS), `expected the address in: ${rejection}`)

  process.env = env
})

test('the address is not echoed back to the caller', async () => {
  const env = { ...process.env }
  process.env.NODE_ENV = 'test'
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'secret'
  const { POST } = loadRoute({ ok: false, reason: 'mismatch' })

  const { result: response } = await capture(() => POST(callbackRequest()))
  const body = await response.text()

  // Logs only. A 401 body that names the caller's address tells an attacker
  // which allow-list entry they landed on.
  assert.equal(body, 'Unauthorized')
  assert.equal(body.includes(AT_ADDRESS), false)

  process.env = env
})

test('an accepted callback logs nothing about the caller by default', async () => {
  const env = { ...process.env }
  process.env.NODE_ENV = 'test'
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'secret'
  delete process.env.SMS_CALLBACK_DEBUG_IP
  const { POST } = loadRoute({ ok: true })

  const { result: response, lines } = await capture(() => POST(callbackRequest()))

  assert.equal(response.status, 200)
  assert.equal(lines.some((line) => line.includes(AT_ADDRESS)), false)

  process.env = env
})

test('SMS_CALLBACK_DEBUG_IP=true logs the address and the channel it used', async () => {
  const env = { ...process.env }
  process.env.NODE_ENV = 'test'
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'secret'
  process.env.SMS_CALLBACK_DEBUG_IP = 'true'
  const { POST } = loadRoute({ ok: true })

  const { result: response, lines } = await capture(() => POST(callbackRequest()))

  assert.equal(response.status, 200)
  const accepted = lines.find((line) => line.includes('Accepted from'))
  assert.ok(accepted, `expected an accept log, got: ${JSON.stringify(lines)}`)
  assert.ok(accepted!.includes(AT_ADDRESS))
  // Which channel matched is diagnostic too: `via=query` proves the ?key= path.
  assert.match(accepted!, /via query/)

  process.env = env
})

test('SMS_CALLBACK_DEBUG_IP is opt-in by value, not by presence', async () => {
  const env = { ...process.env }
  process.env.NODE_ENV = 'test'
  process.env.AFRICASTALKING_CALLBACK_SECRET = 'secret'
  // A stray "1" or "yes" must not silently switch on address logging.
  process.env.SMS_CALLBACK_DEBUG_IP = '1'
  const { POST } = loadRoute({ ok: true })

  const { lines } = await capture(() => POST(callbackRequest()))

  assert.equal(lines.some((line) => line.includes(AT_ADDRESS)), false)

  process.env = env
})
