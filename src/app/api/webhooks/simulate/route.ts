/**
 * Simulate an inbound provider webhook.
 *
 * WHY THIS NEEDS GUARDRAILS
 * -------------------------
 * The Webhooks page has a "Simulate Webhook" button, so the endpoint has to
 * exist — but "mark an arbitrary pending payment as successful on request" is
 * the single most dangerous thing in this codebase if it is reachable in
 * production. It would let anyone who can reach the dashboard manufacture a
 * `success` payment, credit a tenant wallet and fire a partner webhook, with no
 * money behind any of it.
 *
 * So it is built with four locks, and it is *off* in production unless someone
 * deliberately turns it on:
 *
 *   1. `ALLOW_WEBHOOK_SIMULATION=true` must be set. Absent → 404, not 403.
 *      Production deployments do not get the feature by default, and a 404
 *      does not advertise that the endpoint exists.
 *   2. Super-admin session, same as every other dashboard action.
 *   3. The intent must be in a NON-TERMINAL state. An already-final payment
 *      cannot be flipped, so this can never alter a real settled transaction.
 *   4. Every run is written to `payment_transactions` with an unmistakable
 *      note, so a simulated success is never indistinguishable from a real one
 *      in the ledger or in support investigations.
 *
 * It reuses `completePayment()` — the same function the real webhook path uses —
 * rather than writing status directly, so a simulation exercises the real
 * idempotency guard, wallet credit and notification enqueue rather than a
 * parallel code path that could drift.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireSuperAdmin } from '@/lib/auth'
import { completePayment } from '@/lib/payments'

export const dynamic = 'force-dynamic'

const NON_TERMINAL_STATUSES = ['pending', 'processing']

const SimulateSchema = z.object({
  reference: z.string().min(1).max(128),
  status: z.enum(['success', 'failed']).default('success'),
  failureReason: z.string().max(500).optional(),
})

export async function POST(request: Request) {
  // ── Lock 1: the feature flag. Checked before auth so an unconfigured
  // deployment reveals nothing about the endpoint's existence.
  if (process.env.ALLOW_WEBHOOK_SIMULATION !== 'true') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    // ── Lock 2: super admin.
    const admin = await requireSuperAdmin()

    const rawBody = await request.json()
    const parsed = SimulateSchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
        },
        { status: 400 }
      )
    }

    const { reference, status, failureReason } = parsed.data

    const intent = await db.paymentIntent.findUnique({
      where: { reference },
      include: { application: true },
    })

    if (!intent) {
      return NextResponse.json({ error: `No payment found with reference ${reference}` }, { status: 404 })
    }

    // ── Lock 3: only a payment that has not settled can be simulated.
    if (!NON_TERMINAL_STATUSES.includes(intent.status)) {
      return NextResponse.json(
        {
          error:
            `Payment ${reference} is already "${intent.status}" and cannot be simulated. ` +
            'Simulation only applies to pending/processing payments.',
        },
        { status: 409 }
      )
    }

    // ── Lock 4: audit trail, written before the state change so a crash
    // mid-simulation still leaves evidence that one was attempted.
    await db.paymentTransaction.create({
      data: {
        paymentIntentId: intent.id,
        status: `simulated_${status}`,
        rawProviderResponse: JSON.stringify({
          simulatedBy: admin.email ?? admin.id,
          simulatedAt: new Date().toISOString(),
          requestedStatus: status,
        }),
        note: `SIMULATED_WEBHOOK by ${admin.email ?? admin.id} — no provider was contacted and no money moved`,
      },
    })

    const completion = await completePayment({
      paymentIntentId: intent.id,
      status,
      providerPaymentId: intent.providerPaymentId || `SIMULATED_${intent.reference}`,
      failureReason: status === 'failed' ? failureReason || 'Simulated failure' : undefined,
      amount: Number(intent.amount),
      currency: intent.currency,
      rawProviderResponse: JSON.stringify({
        simulated: true,
        by: admin.email ?? admin.id,
        status,
      }),
      note: 'SIMULATED_WEBHOOK',
    })

    console.warn(
      `[webhooks/simulate] ${admin.email ?? admin.id} marked ${reference} as ${status} ` +
        `(wallet credit: ${status === 'success' ? 'applied' : 'none'})`
    )

    return NextResponse.json({
      success: true,
      reference,
      status,
      alreadyProcessed: completion.wasAlreadyProcessed,
      simulated: true,
      warning:
        'This is simulated data. It moved no money. Do not use it to settle against a provider statement.',
    })
  } catch (error: any) {
    const message = error?.message || ''
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (message.includes('Forbidden') || message.includes('Super Admin')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    console.error('Webhook simulation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
