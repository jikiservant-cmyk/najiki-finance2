/**
 * "Is this signing secret actually working?" — asked in the browser, answered
 * by a real signed request to the Church app's real endpoint.
 *
 * WHY NOT JUST VERIFY THE HMAC LOCALLY
 * ------------------------------------
 * Signing a payload here and verifying it here with the same secret proves only
 * that our own signer and our own verifier agree. The thing that breaks a
 * go-live is different: the partner is holding a **different** secret (a typo, a
 * value copied before a rotation, a dashboard paste that lost a character), or
 * it is not checking the signature at all. Neither is visible from our side
 * except by sending a request and reading the answer.
 *
 * So this module sends two requests, and the pair is the test:
 *
 *   1. a correctly signed one — the endpoint should answer 2xx;
 *   2. one signed with a deliberately wrong key — a verifying endpoint must
 *      answer 401/403.
 *
 * The second request is what distinguishes "it works" from "it appears to work
 * because nobody looks". A 2xx to a bad signature is not a pass, it is the
 * finding: payments can be forged against that endpoint by anyone who knows the
 * URL.
 *
 * Nothing secret is written into the request. The signature header is an HMAC
 * over a payload that includes a fresh timestamp, so it is not a credential and
 * not replayable; the key itself never leaves the server. The payload is marked
 * `event: "webhook.test"` and `test: true` so a partner that routes on `event`
 * can ignore it, and so nothing gets credited.
 */

import crypto from 'crypto'
import {
  buildNotificationHeaders,
  verifyNotificationSignature,
  NOTIFICATION_SIGNATURE_HEADER,
  NOTIFICATION_TIMESTAMP_HEADER,
  NOTIFICATION_MARKER_HEADER,
} from './notification-signature'
import { safeFetch, validateSafeUrl } from './safe-fetch'

/** Marks a self-test delivery, so a partner can ignore it. */
export const SELF_TEST_EVENT = 'webhook.test'
/** Header carrying whether this delivery is a test. */
export const SELF_TEST_HEADER = 'X-Najiki-Test'

export type SelfTestMode = 'valid' | 'invalid'

export type SelfTestVerdict =
  /** Correctly signed, endpoint accepted it. */
  | 'accepted'
  /** Correctly signed, endpoint refused the signature. */
  | 'signature-rejected'
  /** The URL itself does not exist / does not accept POST. */
  | 'endpoint-missing'
  /** 408/429 — the endpoint is throttling us, not rejecting the secret. */
  | 'rate-limited'
  /** 5xx — the endpoint is broken, independently of the signature. */
  | 'endpoint-error'
  /** Never reached: DNS, TLS, refused, timeout. */
  | 'unreachable'
  /** Refused by our own SSRF/placeholder guard before a socket was opened. */
  | 'blocked'
  /** Wrong signature was accepted — the endpoint does not verify at all. */
  | 'signature-not-checked'
  /** Wrong signature was refused, exactly as it must be. */
  | 'rejected-as-expected'

export interface SelfTestResult {
  mode: SelfTestMode
  /** Did a request actually leave the server? */
  sent: boolean
  /** The test reached the conclusion it was supposed to reach. */
  ok: boolean
  verdict: SelfTestVerdict
  url: string
  statusCode: number
  latencyMs: number
  /** Signed-at timestamp in ms; the partner checks this is recent. */
  timestamp: number
  /** `t=<ms>,v=<hex>` — safe to show, it is not the key. */
  signature: string
  /**
   * Independent check of what we sent, using the documented verifier. In
   * `valid` mode this must be true and in `invalid` mode false; a mismatch
   * means the request was not the test it claims to be.
   */
  locallyValid: boolean
  responseSnippet: string
  /** Whether the partner echoed anything we can act on. */
  headline: string
  detail: string
  nextSteps: string[]
  /** Exact bytes and headers sent, for replaying with curl. */
  payload: string
  headers: Record<string, string>
}

export interface SelfTestInput {
  applicationCode: string
  webhookUrl: string
  /** The stored signing secret. Required: an unsigned test proves nothing. */
  secret: string | null | undefined
  mode?: SelfTestMode
  /** Injected for deterministic tests. */
  now?: number
  timeoutMs?: number
}

/** The body of a self-test delivery. Deliberately not payment-shaped. */
export function buildSelfTestPayload(applicationCode: string, now: number): string {
  return JSON.stringify({
    event: SELF_TEST_EVENT,
    test: true,
    applicationCode,
    deliveryId: `test_${crypto.randomBytes(8).toString('hex')}`,
    sentAt: new Date(now).toISOString(),
    signatureVersion: 'v1',
    note: 'Signed delivery self-test from the Najiki gateway. Not a payment — do not credit or settle anything.',
  })
}

/**
 * A key that is wrong but indistinguishable in shape, so the request we send in
 * `invalid` mode is a realistic forgery attempt rather than a malformed header.
 */
function wrongSecret(secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update('najiki-selftest-wrong-key')
    .digest('hex')
}

/** HTTP status → verdict, split out so it can be tested without a socket. */
export function classifySelfTestStatus(
  mode: SelfTestMode,
  statusCode: number
): { verdict: SelfTestVerdict; ok: boolean } {
  const isRejection = statusCode === 401 || statusCode === 403
  const is2xx = statusCode >= 200 && statusCode < 300

  if (mode === 'invalid') {
    // The point of this request is to be refused.
    if (isRejection) return { verdict: 'rejected-as-expected', ok: true }
    if (is2xx) return { verdict: 'signature-not-checked', ok: false }
  } else {
    if (is2xx) return { verdict: 'accepted', ok: true }
    if (isRejection) return { verdict: 'signature-rejected', ok: false }
  }

  if (statusCode === 404 || statusCode === 405) return { verdict: 'endpoint-missing', ok: false }
  if (statusCode === 408 || statusCode === 429) return { verdict: 'rate-limited', ok: false }
  if (statusCode >= 500) return { verdict: 'endpoint-error', ok: false }
  return { verdict: 'endpoint-error', ok: false }
}

function explain(result: {
  verdict: SelfTestVerdict
  statusCode?: number
  /** Overrides the stock text, for network failures where the message matters. */
  detail?: string
}): Pick<SelfTestResult, 'headline' | 'detail' | 'nextSteps'> {
  switch (result.verdict) {
    case 'accepted':
      return {
        headline: 'Accepted — a correctly signed notification reached the Church app',
        detail: `The endpoint answered ${result.statusCode}. It accepted a signature made with the secret stored here, so the secret and the endpoint path are both correct.`,
        nextSteps: [
          'Send the bad-signature test too: if that is also accepted, the endpoint is not verifying and anyone can post forged payments to it.',
          'The Church app should ignore deliveries whose body has event="webhook.test" — these are not payments.',
        ],
      }
    case 'rejected-as-expected':
      return {
        headline: 'Correctly refused — the endpoint verifies the signature',
        detail: `A deliberately wrong key was answered ${result.statusCode}. The verifier is live and it is comparing the HMAC, so the accepted case above is real verification and not a rubber stamp.`,
        nextSteps: ['Nothing to fix. This is the result you want from the bad-signature test.'],
      }
    case 'signature-rejected':
      return {
        headline: 'The signature was refused — the Church app has a different secret',
        detail: `The endpoint answered ${result.statusCode} even though the request was signed with this application's stored secret. The Church app is verifying with a different secret: either the value configured there differs (a typo, an old copy, a rotation they were never told about), or its verifier is comparing against a different string, e.g. its NAJIKI_API_KEY.`,
        nextSteps: [
          'Reveal the secret here, copy it, and paste it into the Church app as NAJIKI_WEBHOOK_SECRET.',
          'If the Church app has not set NAJIKI_WEBHOOK_SECRET and falls back to the API key, rotate the API key and give them that value instead.',
          'Check that the verifier signs `${timestamp}.${rawBody}` — the dot, the timestamp first, the exact bytes received.',
        ],
      }
    case 'signature-not-checked':
      return {
        headline: 'The bad signature was ACCEPTED — the endpoint is not verifying',
        detail: `A request signed with a key that is not this application\'s secret was answered ${result.statusCode}. The endpoint is reachable but it is not comparing the HMAC, so anyone who learns its URL can post a fake success notification and have a payment credited that never happened.`,
        nextSteps: [
          'Do not go live on this endpoint until the verifier rejects bad signatures.',
          'In the Church app, verify X-Najiki-Signature against HMAC-SHA256(secret, `${timestamp}.${body}`) and reject anything that does not match.',
          'Also check the timestamp is within a few minutes, so a captured delivery cannot be replayed.',
        ],
      }
    case 'endpoint-missing':
      return {
        headline: `Nothing is listening at that path (HTTP ${result.statusCode})`,
        detail:
          'The host answered, but the path is wrong or does not accept POST. This is not a secret problem: no verifier was reached.',
        nextSteps: [
          'Set the webhook path to /api/webhooks/najiki unless the Church app exposes something else.',
          'Do not rely on the legacy /api/internal/payment-completed auto-heal: it only triggers on 404/405 from that exact path.',
        ],
      }
    case 'rate-limited':
      return {
        headline: `The endpoint is throttling us (HTTP ${result.statusCode})`,
        detail:
          'This is not a signature failure. The endpoint asked us to slow down or timed out; the secret may well be correct.',
        nextSteps: ['Re-run the test in a minute.', 'Raise the rate limit on the Church app endpoint for the gateway IP.'],
      }
    case 'endpoint-error':
      return {
        headline: `The endpoint returned an error (HTTP ${result.statusCode})`,
        detail:
          'The secret and the path cannot be judged from a 5xx. The Church app itself is failing while handling the request — likely its own verifier threw, or a dependency is down.',
        nextSteps: ['Check the Church app logs for this delivery id.', 'The response body below is what it returned.'],
      }
    case 'unreachable':
      return {
        headline: 'The endpoint could not be reached at all',
        detail: result.detail ?? 'No HTTP response was received.',
        nextSteps: [
          'Check the base URL is the public origin and that it resolves from outside.',
          'Check the host allows POST and is not behind a proxy that drops the gateway IP.',
        ],
      }
    case 'blocked':
      return {
        headline: 'The URL was refused before any request was sent',
        detail: result.detail ?? 'The outbound URL guard refused this endpoint.',
        nextSteps: [
          'A placeholder domain (e.g. church.yourdomain.com) or a private/loopback address is never delivered to. Set the real public host.',
        ],
      }
  }
}

/**
 * Send the test delivery and report what the partner did with it.
 *
 * Never throws: every failure mode is a verdict, because the caller is a button
 * in a dashboard and an exception there is indistinguishable from a broken page.
 */
export async function runWebhookSelfTest(input: SelfTestInput): Promise<SelfTestResult> {
  const mode: SelfTestMode = input.mode === 'invalid' ? 'invalid' : 'valid'
  const now = input.now ?? Date.now()
  const url = String(input.webhookUrl ?? '').trim()
  const payload = buildSelfTestPayload(input.applicationCode, now)

  const base: Omit<SelfTestResult, 'headline' | 'detail' | 'nextSteps'> = {
    mode,
    sent: false,
    ok: false,
    verdict: 'unreachable',
    url,
    statusCode: 0,
    latencyMs: 0,
    timestamp: now,
    signature: '',
    locallyValid: false,
    responseSnippet: '',
    payload,
    headers: {},
  }

  if (!input.secret) {
    const detail =
      'No signing secret is stored for this application, so a signed test cannot be sent and notifications would go out unsigned.'
    return {
      ...base,
      ...explain({ verdict: 'blocked', detail }),
      verdict: 'blocked',
      detail,
      nextSteps: ['Rotate the webhook secret to create one, then run the test again.'],
    }
  }

  if (!url) {
    const detail = 'No base URL or webhook path is configured, so there is nowhere to send the test.'
    return {
      ...base,
      ...explain({ verdict: 'blocked', detail }),
      verdict: 'blocked',
      detail,
      nextSteps: ['Set the base URL and webhook path, save, then run the test again.'],
    }
  }

  try {
    await validateSafeUrl(url)
  } catch (error: any) {
    const detail = `Refused by the outbound URL guard: ${error?.message ?? 'unsafe URL'}.`
    return {
      ...base,
      ...explain({ verdict: 'blocked', detail }),
      verdict: 'blocked',
      detail,
    }
  }

  const signingKey = mode === 'invalid' ? wrongSecret(input.secret) : input.secret

  // Reuse the exact header builder the payment and SMS paths use. A test that
  // signs differently from production would pass while production failed.
  const headers = {
    ...buildNotificationHeaders(signingKey, payload, now),
    [SELF_TEST_HEADER]: 'true',
  }

  const signature = headers[NOTIFICATION_SIGNATURE_HEADER] ?? ''
  // Independent check of the bytes we are about to send.
  const locallyValid = verifyNotificationSignature({
    secret: input.secret,
    payloadString: payload,
    timestamp: headers[NOTIFICATION_TIMESTAMP_HEADER],
    signature,
    now,
  })

  const startedAt = Date.now()
  let statusCode = 0
  let responseSnippet = ''

  try {
    const response = await safeFetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    })
    statusCode = response.status
    const text = await response.text().catch(() => '')
    responseSnippet = String(text ?? '').slice(0, 500)
  } catch (error: any) {
    const latencyMs = Date.now() - startedAt
    const detail = `No HTTP response: ${error?.message ?? 'unknown network error'}.`
    return {
      ...base,
      sent: true,
      verdict: 'unreachable',
      latencyMs,
      signature,
      headers,
      locallyValid,
      ...explain({ verdict: 'unreachable', detail }),
      detail,
    }
  }

  const latencyMs = Date.now() - startedAt
  const { verdict, ok } = classifySelfTestStatus(mode, statusCode)
  const result = {
    ...base,
    sent: true,
    ok,
    verdict,
    statusCode,
    latencyMs,
    signature,
    headers,
    locallyValid,
    responseSnippet,
  }

  return { ...result, ...explain({ verdict, statusCode }) }
}

/** A curl command the operator can paste anywhere to replay the same request. */
export function selfTestCurl(result: Pick<SelfTestResult, 'url' | 'headers' | 'payload'>): string {
  const headerArgs = Object.entries(result.headers)
    .filter(([name]) => name !== 'Content-Type')
    .map(([name, value]) => `-H '${name}: ${value}'`)
    .join(' \\\n  ')

  return `curl -i -X POST '${result.url}' \\\n  -H 'Content-Type: application/json' \\\n  ${headerArgs} \\\n  --data '${result.payload}'`
}

/** The header names a partner verifier must read. Re-exported for the UI. */
export const SELF_TEST_HEADERS = {
  timestamp: NOTIFICATION_TIMESTAMP_HEADER,
  signature: NOTIFICATION_SIGNATURE_HEADER,
  marker: NOTIFICATION_MARKER_HEADER,
  test: SELF_TEST_HEADER,
}
