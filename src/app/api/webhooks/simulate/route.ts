import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'

export async function POST(req: NextRequest) {
  try {
    const { reference, status } = await req.json()

    if (!reference || !status) {
      return NextResponse.json({ error: 'Missing required fields: reference, status' }, { status: 400 })
    }

    const payment = await db.paymentIntent.findUnique({
      where: { reference },
      include: { provider: true }
    })

    if (!payment) {
      return NextResponse.json({ error: 'Payment intent not found' }, { status: 404 })
    }

    const normalizedStatus = status.toLowerCase() === 'success' ? 'Success' : 'Failed'

    const webhookPayload = {
      status: normalizedStatus,
      message: normalizedStatus === 'Success' ? 'Payment completed successfully' : 'Payment failed',
      customer_reference: payment.reference,
      internal_reference: payment.providerPaymentId || crypto.randomUUID(),
      msisdn: payment.phoneNumber || '+256777123456',
      amount: Number(payment.amount),
      currency: payment.currency || 'UGX',
      provider: 'MTN',
      charge: 1500,
      completed_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    }

    const timestamp = Math.floor(Date.now() / 1000).toString()
    const secret = process.env.LIVEPAY_WEBHOOK_SECRET || ''

    // Reconstruct the webhook URL matching the host context
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000'
    const protocol = req.headers.get('x-forwarded-proto') || 'https'
    const webhookUrl = `${protocol}://${host}/api/webhooks/livepay`

    const params = {
      status: webhookPayload.status,
      customer_reference: webhookPayload.customer_reference,
      internal_reference: webhookPayload.internal_reference,
    }

    const sortedKeys = Object.keys(params).sort() as Array<keyof typeof params>
    let stringToSign = webhookUrl + timestamp
    for (const key of sortedKeys) {
      stringToSign += key + params[key]
    }

    const hmac = crypto.createHmac('sha256', secret)
    hmac.update(stringToSign)
    const expectedSignature = hmac.digest('hex')
    const signatureHeader = `t=${timestamp},v=${expectedSignature}`

    // Post to local server endpoint with forwarded headers to preserve public URL context
    const response = await fetch(`http://localhost:3000/api/webhooks/livepay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signatureHeader,
        'Host': host,
        'X-Forwarded-Host': host,
        'X-Forwarded-Proto': protocol,
      },
      body: JSON.stringify(webhookPayload)
    })

    const responseText = await response.text()
    let responseData
    try {
      responseData = JSON.parse(responseText)
    } catch {
      responseData = responseText
    }

    if (!response.ok) {
      return NextResponse.json({
        success: false,
        error: `Webhook endpoint returned status ${response.status}`,
        data: responseData,
        simulatedPayload: JSON.stringify(webhookPayload, null, 2),
        signatureHeader,
      }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      status: normalizedStatus.toLowerCase(),
      simulatedPayload: JSON.stringify(webhookPayload, null, 2),
      signatureHeader,
      data: responseData,
    })

  } catch (error) {
    console.error('Webhook simulation error:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}
