import {
  PaymentProvider,
  InitiatePaymentParams,
  InitiatePaymentResponse,
  PaymentStatusResponse,
  ParsedWebhook,
} from './types'
import crypto from 'crypto'

export class LivePayProvider implements PaymentProvider {
  code = 'livepay'
  name = 'LivePay'

  private apiKey: string
  private accountNo: string
  private webhookSecret: string
  private baseUrl: string

  constructor() {
    this.apiKey = process.env.LIVEPAY_API_KEY || ''
    this.accountNo = process.env.LIVEPAY_ACCOUNT_NO || ''
    this.webhookSecret = process.env.LIVEPAY_WEBHOOK_SECRET || ''
    this.baseUrl = process.env.LIVEPAY_BASE_URL || 'https://livepay.me'
  }

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResponse> {
    try {
      const payload = {
        accountNumber: this.accountNo,
        phoneNumber: params.phoneNumber,
        amount: params.amount,
        currency: params.currency || 'UGX',
        reference: params.reference,
        description: params.description || 'Payment',
      }

      const response = await fetch(`${this.baseUrl}/api/collect-money`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      })

      const data = await response.json()

      if (response.ok && data.success) {
        return {
          success: true,
          providerPaymentId: data.internal_reference,
          status: 'processing',
          metadata: data,
        }
      }

      return {
        success: false,
        status: 'failed',
        failureReason: data.error || 'Failed to initiate payment',
      }
    } catch (error) {
      return {
        success: false,
        status: 'failed',
        failureReason: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async checkPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResponse> {
    // LivePay doesn't have a documented status check endpoint, so we'll rely on webhooks
    return {
      success: true,
      status: 'pending',
      amount: 0,
      currency: 'UGX',
      providerPaymentId,
    }
  }

  async validateWebhookSignature(
    payload: string,
    signatureHeader: string,
    headers?: Record<string, string>
  ): Promise<boolean> {
    try {
      if (!headers || !headers['x-webhook-signature']) {
        return false
      }

      const signatureHeaderValue = headers['x-webhook-signature']
      const [timestampPart, signaturePart] = signatureHeaderValue.split(',')
      const timestamp = timestampPart.split('=')[1]
      const receivedSignature = signaturePart.split('=')[1]

      const webhookPayload = JSON.parse(payload)
      const params = {
        status: webhookPayload.status,
        customer_reference: webhookPayload.customer_reference,
        internal_reference: webhookPayload.internal_reference,
      }

      const sortedKeys = Object.keys(params).sort()
      const webhookUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'
      let stringToSign = `${webhookUrl}/api/webhooks/livepay${timestamp}`

      for (const key of sortedKeys) {
        stringToSign += `${key}${params[key]}`
      }

      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(stringToSign)
        .digest('hex')

      return receivedSignature === expectedSignature
    } catch {
      return false
    }
  }

  async parseWebhookPayload(payload: any): Promise<ParsedWebhook> {
    const statusMap: Record<string, any> = {
      'Success': 'success',
      'Failed': 'failed',
    }

    return {
      reference: payload.customer_reference,
      providerPaymentId: payload.internal_reference,
      status: statusMap[payload.status] || 'pending',
      amount: payload.amount,
      currency: payload.currency,
      metadata: payload,
      failureReason: payload.status === 'Failed' ? 'Payment failed' : undefined,
    }
  }
}
