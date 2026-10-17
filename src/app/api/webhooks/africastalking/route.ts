// Africa's Talking delivery reports (DLR).
//
// Three things have been wrong here at different times, all now fixed:
//
//  1. The 401 was permanent in production. It was reached as
//     /api/messaging/callback, which the middleware matcher did NOT exclude, so
//     every delivery report was rejected by the session gate before this handler
//     ran. The matcher now excludes both paths.
//
//  2. Message lookup is an indexed query by provider message id instead of
//     "load every SMS ever sent and scan in JS".
//
//  3. The secret was required in a HEADER, which Africa's Talking never sends.
//     `env.ts` requires the secret at boot in production, so the check always
//     ran and every real delivery report got 401 — messages were marked
//     `delivered` when the carrier *accepted* them and nothing could ever
//     correct that to `failed`. The secret is now also accepted from the
//     callback URL's query string (the established AT pattern) and from a body
//     field, with an optional IP allow-list as a second factor.
//     See src/lib/callback-auth.ts for the reasoning and the trade-offs.

import { NextResponse } from 'next/server'
import { smsStore } from '@/lib/sms-store'
import { deliverSmsNotification } from '@/lib/sms-queue'
import { authorizeCallback } from '@/lib/callback-auth'
import { resolveClientIp } from '@/lib/client-ip'
import { checkRateLimit } from '@/lib/rate-limit'
import { readTextWithLimit, PayloadTooLargeError } from '@/lib/request-body'

/**
 * Client IP as seen through the platform proxy.
 *
 * Uses the shared resolver: the trusted entries are at the RIGHT of
 * `x-forwarded-for`, because our own proxy appends to it last. Reading the first
 * entry (which this used to do) reads a value the caller chose, so an attacker
 * could name any address they liked. See src/lib/client-ip.ts.
 */
function clientIpFrom(request: Request): string {
  return resolveClientIp({
    forwardedFor: request.headers.get('x-forwarded-for'),
    realIp: request.headers.get('x-real-ip'),
    trustedProxyHops: process.env.TRUSTED_PROXY_HOPS,
    trustRealIp: process.env.TRUST_X_REAL_IP,
  })
}

/** A delivery report is tiny; cap streaming bodies before authentication/parsing. */
const MAX_CALLBACK_BYTES = 16 * 1024

async function readCallbackBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') || ''
  const text = await readTextWithLimit(request, MAX_CALLBACK_BYTES)
  if (contentType.includes('application/json')) {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid callback JSON')
    return parsed as Record<string, unknown>
  }
  return Object.fromEntries(new URLSearchParams(text))
}

export async function POST(request: Request) {
  try {
    const configuredSecret = process.env.AFRICASTALKING_CALLBACK_SECRET
    const configuredIps = process.env.AFRICASTALKING_ALLOWED_IPS
    const isProduction = process.env.NODE_ENV === 'production'

    if (isProduction && !configuredSecret && !configuredIps) {
      console.error(
        "[Africa's Talking DLR] Neither AFRICASTALKING_CALLBACK_SECRET nor " +
          'AFRICASTALKING_ALLOWED_IPS is configured — refusing to accept an ' +
          'unauthenticated callback (fail-closed)'
      )
      return new NextResponse('Unauthorized', { status: 401 })
    }

    const ipDecision = await checkRateLimit('sms-callback-ip', clientIpFrom(request) || 'unknown', {
      tokens: 120,
      window: '1 m',
    })
    if (!ipDecision.ok) {
      return new NextResponse(ipDecision.message, { status: ipDecision.status,
        headers: ipDecision.retryAfter ? { 'Retry-After': ipDecision.retryAfter } : {} })
    }

    // Form callbacks can carry a secret in the body, so read it with a byte cap
    // before authenticating. A chunked request cannot bypass this limit.
    let payload: Record<string, unknown>
    try {
      payload = await readCallbackBody(request)
    } catch (error) {
      return new NextResponse(error instanceof PayloadTooLargeError ? 'Payload too large' : 'Invalid callback body', {
        status: error instanceof PayloadTooLargeError ? 413 : 400,
      })
    }

    const auth = authorizeCallback({
      configuredSecret,
      configuredIps,
      headerSecret: request.headers.get('x-callback-secret'),
      requestUrl: request.url,
      body: payload,
      clientIp: clientIpFrom(request),
      requireAllowedIp: process.env.AFRICASTALKING_REQUIRE_ALLOWED_IP === 'true',
    })

    if (!auth.ok) {
      console.warn(
        `[Africa's Talking DLR] Rejected callback (${auth.reason}). ` +
          'Configure the callback URL with ?key=<AFRICASTALKING_CALLBACK_SECRET>. ' +
          'AFRICASTALKING_ALLOWED_IPS cannot authorise on its own while a secret is set.'
      )
      return new NextResponse('Unauthorized', { status: 401 })
    }

    const id = payload.id == null ? '' : String(payload.id)
    const status = payload.status == null ? '' : String(payload.status)
    // Only terminal reports can change state; "buffered"/"submitted" are
    // acceptance events, not proof of delivery. No recipient-only fallback.
    const normalized = status.toLowerCase()
    const finalStatus = ['success', 'delivered'].includes(normalized) ? 'delivered'
      : ['failed', 'rejected', 'expired', 'undeliverable'].includes(normalized) ? 'failed'
      : null
    if (id && finalStatus) {
      const match = await smsStore.findByProviderMessageId(id)
      if (match) {
        const changed = await smsStore.applyDeliveryReport(match.id, id, finalStatus)
        if (changed) {
          const updated = await smsStore.get(match.id)
          if (updated) await deliverSmsNotification(updated)
        }
      } else {
        // Unknown/duplicate provider IDs are not associated with a recipient;
        // acknowledge but do not mutate another app's row.
        console.warn("[Africa's Talking DLR] Unmatched provider ID; no SMS updated")
      }
    }

    // Africa's Talking expects a 200 OK response
    return new NextResponse('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  } catch {
    console.error("[Africa's Talking DLR] Callback handling error; retry requested")
    // 500 and not 200: a retried delivery report is cheap, a silently dropped
    // one leaves the message stuck in "pending" forever.
    return new NextResponse('Internal Error', { status: 500 })
  }
}

export async function GET() {
  return new NextResponse("Africa's Talking Webhook Active", {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })
}
