import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'

export async function POST(request: Request) {
  try {
    const { reference, status } = await request.json()

    if (!reference || !status) {
      return NextResponse.json({ error: 'Missing reference or status' }, { status: 400 })
    }

    const payment = await db.paymentIntent.findUnique({
      where: { reference },
      include: { provider: true },
    })

    if (!payment) {
      return NextResponse.json({ error: 'Payment intent not found' }, { status: 404 })
    }

    const providerCode = payment.provider.code.toLowerCase()

    if (providerCode === 'livepay') {
      // Simulate LivePay webhook
      const payload = {
        status: status === 'success' ? 'success' : 'failed',
        customer_reference: payment.reference,
        internal_reference: payment.providerPaymentId || `sim-${crypto.randomUUID()}`,
        amount: payment.amount.toString(),
        currency: payment.currency,
      }

      const timestamp = Math.floor(Date.now() / 1000).toString()
      const params: Record<string, string> = {
        status: payload.status,
        customer_reference: payload.customer_reference,
        internal_reference: payload.internal_reference,
      }

      const sortedKeys = Object.keys(params).sort()
      
      // Determine base URL dynamically
      const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:3000'
      const protocol = request.headers.get('x-forwarded-proto') || 'https'
      const webhookUrl = `${protocol}://${host}/api/webhooks/livepay`

      let stringToSign = `${webhookUrl}${timestamp}`
      for (const key of sortedKeys) {
        stringToSign += `${key}${params[key]}`
      }

      const webhookSecret = process.env.LIVEPAY_WEBHOOK_SECRET || ''
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(stringToSign)
        .digest('hex')

      const signatureHeader = `timestamp=${timestamp},signature=${expectedSignature}`

      // Fire local fetch to the real webhook handler
      const internalWebhookUrl = `http://localhost:3000/api/webhooks/livepay`
      const response = await fetch(internalWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-signature': signatureHeader,
        },
        body: JSON.stringify(payload),
      })

      const responseText = await response.text()
      let responseData
      try {
        responseData = JSON.parse(responseText)
      } catch {
        responseData = { raw: responseText }
      }

      return NextResponse.json({
        success: response.ok,
        status: response.status,
        data: responseData,
        simulatedPayload: payload,
        signatureHeader,
      })
    } else {
      // For other providers (like Pesapal or MTN), directly update status
      const normalizedStatus = status.toLowerCase()
      await db.$transaction(async (tx) => {
        await tx.paymentIntent.update({
          where: { id: payment.id },
          data: {
            status: normalizedStatus,
            completedAt: normalizedStatus === 'success' || normalizedStatus === 'failed' ? new Date() : null,
          },
        })

        await tx.paymentTransaction.create({
          data: {
            paymentIntentId: payment.id,
            status: normalizedStatus,
            rawProviderResponse: JSON.stringify({ simulated: true, status: normalizedStatus }),
            note: 'SIMULATED_UPDATE',
          },
        })
      })

      return NextResponse.json({
        success: true,
        message: `Directly updated payment reference ${reference} status to ${status}`,
      })
    }
  } catch (error) {
    console.error('Simulation error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 })
  }
}
