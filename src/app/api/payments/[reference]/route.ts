import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getPaymentProvider } from '@/lib/providers'

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

    let currentStatus = paymentIntent.status
    let currentFailureReason = paymentIntent.failureReason
    let completedAt = paymentIntent.completedAt

    // If still processing, see if we should poll the provider (max once every 15s)
    if (paymentIntent.status === 'processing' && paymentIntent.provider?.code) {
      const secondsSinceUpdate = (Date.now() - paymentIntent.updatedAt.getTime()) / 1000
      
      if (secondsSinceUpdate > 15) {
        try {
          const providerClient = getPaymentProvider(paymentIntent.provider.code)
          if (providerClient.checkPaymentStatus) {
            const statusResult = await providerClient.checkPaymentStatus(
              paymentIntent.reference,
              paymentIntent.currency,
              paymentIntent.providerPaymentId || undefined
            )

            // If status changed to success or failed, update the DB
            if (statusResult.status !== 'pending' && statusResult.status !== 'processing') {
              const updatedIntent = await db.paymentIntent.update({
                where: { id: paymentIntent.id },
                data: {
                  status: statusResult.status,
                  failureReason: statusResult.failureReason || null,
                  completedAt: statusResult.status === 'success' ? new Date() : null,
                }
              })
              
              await db.paymentTransaction.create({
                data: {
                  paymentIntentId: paymentIntent.id,
                  status: statusResult.status,
                  rawProviderResponse: JSON.stringify(statusResult),
                  note: 'STATUS_SYNC_FROM_API',
                }
              })

              await db.internalNotification.create({
                data: {
                  paymentIntentId: paymentIntent.id,
                  applicationId: application.id,
                  url: `${application.baseUrl}${application.webhookPath}`,
                  payload: JSON.stringify({
                    paymentIntentId: paymentIntent.id,
                    reference: paymentIntent.reference,
                    status: statusResult.status,
                    amount: paymentIntent.amount,
                    currency: paymentIntent.currency,
                    providerPaymentId: statusResult.providerPaymentId || paymentIntent.providerPaymentId,
                    failureReason: statusResult.failureReason,
                    externalEntityId: paymentIntent.externalEntityId,
                    metadata: paymentIntent.metadata ? JSON.parse(JSON.stringify(paymentIntent.metadata)) : {},
                  }),
                  status: 'pending',
                  attemptCount: 0,
                  maxAttempts: 5,
                  nextRetryAt: new Date(),
                },
              })

              currentStatus = updatedIntent.status
              currentFailureReason = updatedIntent.failureReason
              completedAt = updatedIntent.completedAt
            } else {
               // Just touch updatedAt to reset the 15s throttle
               await db.paymentIntent.update({
                 where: { id: paymentIntent.id },
                 data: { updatedAt: new Date() }
               })
            }
          }
        } catch (pollError) {
          console.error('[Payment API] Error polling provider status:', pollError)
        }
      }
    }

    return NextResponse.json({
      id:               paymentIntent.id,
      reference:        paymentIntent.reference,
      status:           currentStatus,
      amount:           Number(paymentIntent.amount), // Decimal → number for JSON
      currency:         paymentIntent.currency,
      phoneNumber:      paymentIntent.phoneNumber,
      externalEntityId: paymentIntent.externalEntityId,
      provider:         paymentIntent.provider,
      providerPaymentId: paymentIntent.providerPaymentId,
      application:      paymentIntent.application,
      tenant:           paymentIntent.tenant,
      paymentType:      paymentIntent.paymentType,
      failureReason:    currentFailureReason,
      createdAt:        paymentIntent.createdAt,
      updatedAt:        paymentIntent.updatedAt,
      completedAt:      completedAt,
    })
  } catch (error) {
    console.error('Get payment error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
