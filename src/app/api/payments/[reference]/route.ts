import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Missing or invalid authorization header' }, { status: 401 })
    }
    const apiKey = authHeader.slice(7) // Remove 'Bearer ' prefix

    const application = await db.application.findFirst({
      where: { apiKey, isActive: true }
    })

    if (!application) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
    }

    const { reference } = await params

    const paymentIntent = await db.paymentIntent.findUnique({
      where: { reference },
      include: {
        application: { select: { id: true, code: true, name: true } },
        tenant:      { select: { id: true, code: true, name: true } },
        provider:    { select: { id: true, code: true, name: true } },
        paymentType: { select: { id: true, code: true, description: true } },
      },
    })

    if (!paymentIntent) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    // Check that the payment intent belongs to the authenticated application
    if (paymentIntent.applicationId !== application.id) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    return NextResponse.json({
      id:               paymentIntent.id,
      reference:        paymentIntent.reference,
      status:           paymentIntent.status,
      amount:           Number(paymentIntent.amount), // Decimal → number for JSON
      currency:         paymentIntent.currency,
      phoneNumber:      paymentIntent.phoneNumber,
      externalEntityId: paymentIntent.externalEntityId,
      provider:         paymentIntent.provider,
      providerPaymentId: paymentIntent.providerPaymentId,
      application:      paymentIntent.application,
      tenant:           paymentIntent.tenant,
      paymentType:      paymentIntent.paymentType,
      failureReason:    paymentIntent.failureReason,
      createdAt:        paymentIntent.createdAt,
      updatedAt:        paymentIntent.updatedAt,
      completedAt:      paymentIntent.completedAt,
    })
  } catch (error) {
    console.error('Get payment error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
