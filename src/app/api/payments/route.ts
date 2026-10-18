// Payment intent creation.
// Ordering matters here and was previously wrong:
//   1. rate limit (cheap, before touching the DB)
//   2. authenticate the API key            ← MUST come before anything that
//   3. validate the body                      can reveal data or write rows
//   4. idempotency lookup, scoped to the authenticated application
//   5. create + initiate
//
// The idempotency lookup used to run *before* the API key was checked, so a
// caller with a guessed/reused key could read back another application's
// payment id, reference and status.

import { NextResponse } from 'next/server'
import { handleCreatePaymentIntent, paymentCorsHeaders } from '@/lib/payment-intent-handler'

export const dynamic = 'force-dynamic'

export function OPTIONS(request: Request) {
  return paymentCorsHeaders(request)
}

export async function POST(request: Request) {
  return handleCreatePaymentIntent(request)
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed. Use POST to create a payment intent.' }, { status: 405 })
}

export async function PUT() {
  return NextResponse.json({ error: 'Method not allowed. Use POST to create a payment intent.' }, { status: 405 })
}

export async function DELETE() {
  return NextResponse.json({ error: 'Method not allowed. Use POST to create a payment intent.' }, { status: 405 })
}

export async function PATCH() {
  return NextResponse.json({ error: 'Method not allowed. Use POST to create a payment intent.' }, { status: 405 })
}
