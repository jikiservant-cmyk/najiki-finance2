/**
 * Per-message SMS status for the partner that sent it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the only way an application could learn what happened to a message
 * was the `SMS_DELIVERY_UPDATE` webhook. That made delivery status unusable for
 * a broadcast: the webhook only fires for the two terminal states, and a row
 * that ages into `unknown` never notifies at all. A partner tracking 500
 * recipients therefore had no way to ask about one of them.
 *
 * This is a read-only lookup scoped to the calling application. It answers the
 * three questions that actually come up:
 *
 *   • did we reach the provider at all?      → providerMessageId
 *   • has the carrier told us anything?      → deliveryReport
 *   • did the partner endpoint acknowledge?  → notificationDeliveredAt
 *
 * AUTHENTICATION
 * --------------
 * Partner API key, resolved exactly like `POST /api/messaging/send`: the key
 * alone decides which application is asking, and the query is then scoped by
 * `applicationId`. Two consequences that are deliberate:
 *
 *   • a reference belonging to another application is a 404, not a 403 — the
 *     endpoint must not confirm that a reference exists elsewhere;
 *   • no session is required, which is why `api/messaging/sms/` is listed in the
 *     middleware matcher's machine-to-machine exclusions. Without that entry the
 *     Supabase session gate answers with an HTML redirect and the partner sees a
 *     login page instead of JSON — the same failure that hid the Africa's
 *     Talking delivery-report route for weeks.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { findApplicationByApiKey } from '@/lib/application-auth'
import { maskRecipient } from '@/lib/recipient-mask'
import { checkRateLimit } from '@/lib/rate-limit'

/** Higher than the send limit: polling status is cheap and read-only. */
const READ_TOKENS_PER_MINUTE = 240

function apiKeyFrom(request: Request): string {
  const authHeader = request.headers.get('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim()
  if (authHeader) return authHeader.trim()
  return (request.headers.get('x-api-key') || '').trim()
}

export async function GET(
  request: Request,
  context: { params: Promise<{ reference: string }> }
) {
  try {
    const apiKey = apiKeyFrom(request)
    if (!apiKey) {
      return NextResponse.json({ error: 'Invalid or missing API key' }, { status: 401 })
    }

    const decision = await checkRateLimit('sms-status', apiKey, {
      tokens: READ_TOKENS_PER_MINUTE,
      window: '1 m',
    })
    if (!decision.ok) {
      return NextResponse.json(
        { error: decision.message },
        {
          status: decision.status,
          headers: decision.retryAfter ? { 'Retry-After': decision.retryAfter } : {},
        }
      )
    }

    const auth = await findApplicationByApiKey(apiKey)
    const application = auth?.application ?? null
    if (!application) {
      return NextResponse.json({ error: 'Invalid or missing API key' }, { status: 401 })
    }

    const { reference } = await context.params
    const trimmed = String(reference ?? '').trim()
    if (!trimmed || trimmed.length > 255) {
      return NextResponse.json({ error: 'Invalid reference' }, { status: 400 })
    }

    // Scoped by application: a reference that exists under another application
    // is indistinguishable from one that does not exist.
    const row = await db.smsMessage.findFirst({
      where: { reference: trimmed, applicationId: application.id },
    })
    if (!row) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    // The carrier's delivery report, when one arrived. This is what separates
    // "the provider accepted it" from "a phone confirmed it".
    const report = row.providerMessageId
      ? await db.smsDeliveryReport.findUnique({
          where: { providerMessageId: row.providerMessageId },
        })
      : null

    return NextResponse.json(
      {
        reference: row.reference,
        status: row.status,
        // Masked: the caller already knows who they texted, and a status
        // endpoint is not a reason to emit a full MSISDN.
        recipient: maskRecipient(row.recipient),
        applicationCode: row.applicationCode,
        providerCode: row.providerCode,
        providerMessageId: row.providerMessageId ?? null,
        attemptCount: row.attemptCount ?? 0,
        failureReason: row.failureReason ?? null,
        cost: row.cost ?? 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deliveryReport: report
          ? { status: report.status, receivedAt: report.receivedAt, appliedAt: report.appliedAt ?? null }
          : null,
        notificationDeliveredAt: row.notificationDeliveredAt ?? null,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  } catch (error) {
    console.error('[Messaging API] SMS status lookup failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
