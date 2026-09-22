// Africa's Talking delivery reports (DLR).
//
// Two things changed here:
//
//  1. The 401 on this endpoint was previously permanent in production: it was
//     reached as /api/messaging/callback, which the middleware matcher did NOT
//     exclude, so every delivery report was rejected by the session gate before
//     this handler ever ran. The matcher now excludes both paths.
//  2. Message lookup is an indexed query by provider message id instead of
//     "load every SMS ever sent and scan in JS".

import { NextResponse } from 'next/server'
import { smsStore } from '@/lib/sms-store'
import { maskPhoneNumber } from '@/lib/redact'
import { safeCompare } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const secret = process.env.AFRICASTALKING_CALLBACK_SECRET
    if (process.env.NODE_ENV === 'production' && !secret) {
      console.error(
        "[Africa's Talking DLR] AFRICASTALKING_CALLBACK_SECRET must be configured in production (fail-closed)"
      )
      return new NextResponse('Unauthorized', { status: 401 })
    }

    if (secret) {
      const received = request.headers.get('x-callback-secret') || ''
      if (!safeCompare(secret, received)) {
        return new NextResponse('Unauthorized', { status: 401 })
      }
    }

    let payload: Record<string, any> = {}
    const contentType = request.headers.get('content-type') || ''

    if (contentType.includes('application/json')) {
      payload = await request.json()
    } else {
      // Form URL-encoded format is default for Africa's Talking callbacks
      const text = await request.text()
      const searchParams = new URLSearchParams(text)
      for (const [key, value] of searchParams.entries()) {
        payload[key] = value
      }
    }

    const { id, status, phoneNumber, failureReason, networkCode } = payload
    console.log(
      `[Africa's Talking DLR] Received callback for message ${id || 'unknown'}: status=${status}, phone=${maskPhoneNumber(phoneNumber || '')}, reason=${failureReason || 'none'}`
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
