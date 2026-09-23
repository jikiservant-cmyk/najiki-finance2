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
import { maskPhoneNumber } from '@/lib/redact'
import { authorizeCallback } from '@/lib/callback-auth'
import { resolveClientIp } from '@/lib/client-ip'

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

/** Parse either a JSON or an `application/x-www-form-urlencoded` body. */
async function readCallbackBody(request: Request): Promise<Record<string, any>> {
  const contentType = request.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return await request.json()
  }

  // Form URL-encoded is the default for Africa's Talking callbacks.
  const text = await request.text()
  const payload: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(text).entries()) {
    payload[key] = value
  }
  return payload
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

    // The body is read before authorisation so a secret posted as a form field
    // can be considered. It carries no writes of its own, and the size of a
    // delivery report is bounded by the platform body limit.
    let payload: Record<string, any> = {}
    try {
      payload = await readCallbackBody(request)
    } catch (parseError) {
      console.warn("[Africa's Talking DLR] Could not parse callback body:", parseError)
      payload = {}
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

    const { id, status, phoneNumber, failureReason, networkCode } = payload
    console.log(
      `[Africa's Talking DLR] Received callback for message ${id || 'unknown'}: status=${status}, phone=${maskPhoneNumber(phoneNumber || '')}, reason=${failureReason || 'none'} (auth: ${auth.via})`
    )

    const normalizedStatus = String(status || '').toLowerCase()
    const isSuccess = normalizedStatus === 'success' || normalizedStatus === 'delivered'
    const newStatus = isSuccess ? 'delivered' : normalizedStatus === 'buffered' ? 'pending' : 'failed'
    const note = failureReason
      ? `${status}: ${failureReason} (network: ${networkCode || 'N/A'})`
      : undefined

    if (id) {
      // O(1) on the provider_message_id index.
      const byProviderId = await smsStore.findByProviderMessageId(String(id))

      // Some campaigns only echo the MSISDN — fall back to a bounded recent
      // lookup, matched on normalised digits.
      const match =
        byProviderId ||
        (phoneNumber ? await smsStore.findRecentUnresolvedByRecipient(String(phoneNumber)) : null)

      if (!match) {
        // Nothing to update (e.g. a message from before this store existed).
        // Acknowledge so Africa's Talking does not retry forever.
        console.warn(`[Africa's Talking DLR] No SMS record found for provider id ${id} — acknowledging`)
        return new NextResponse('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } })
      }

      const updated = await smsStore.updateStatus(match.id, newStatus, note, undefined, String(id))
      if (!updated) {
        // Persistence failed (DB error) — let Africa's Talking retry.
        console.error(`[Africa's Talking DLR] Failed to persist status for SMS ${match.id}`)
        return new NextResponse('Retry', { status: 500, headers: { 'Content-Type': 'text/plain' } })
      }

      console.log(`[Africa's Talking DLR] Updated SMS ${match.id} status to ${newStatus}`)
    }

    // Africa's Talking expects a 200 OK response
    return new NextResponse('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  } catch (error: any) {
    console.error("[Africa's Talking DLR] Callback handling error:", error)
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
