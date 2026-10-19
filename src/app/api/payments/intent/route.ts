// Alias for POST /api/payments
// The SACCO integration documents POST /api/payments/intent, but the gateway
// only exposed POST /api/payments. A direct POST to the intent path was routed
// to the dynamic [reference] handler which only implements GET, causing the
// platform to return its default HTML 500 page. The SACCO client surfaced that
// as "NaJiki gateway error (Status 500). Response: <!DOCTYPE html>…".
// This module re-uses the exact same handler so both paths are first-class.

import { NextResponse } from 'next/server'
import { handleCreatePaymentIntent, paymentCorsHeaders } from '@/lib/payment-intent-handler'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

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
