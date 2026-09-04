import {
  PaymentProvider,
  ProviderCredentials,
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

  constructor(config?: Partial<ProviderCredentials>) {
    this.apiKey = config?.apiKey || config?.api_key || process.env.LIVEPAY_API_KEY || ''
    this.accountNo = config?.accountNo || config?.account_number || config?.accountNumber || process.env.LIVEPAY_ACCOUNT_NO || ''
    this.webhookSecret = config?.webhookSecret || config?.webhook_secret || process.env.LIVEPAY_WEBHOOK_SECRET || ''
    this.baseUrl = config?.baseUrl || config?.base_url || process.env.LIVEPAY_BASE_URL || 'https://livepay.me'
  }

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResponse> {
    try {
      const payload = {
        accountNumber: this.accountNo,
        phoneNumber: params.phoneNumber.replace(/[\s\-\(\)\+]/g, "").startsWith("0") ? "256" + params.phoneNumber.replace(/[\s\-\(\)\+]/g, "").slice(1) : params.phoneNumber.replace(/[\s\-\(\)\+]/g, ""),
        amount: params.amount,
        currency: params.currency || 'UGX',
        reference: params.reference,
        description: params.description || 'Payment',
        webhookUrl: params.webhookUrl || `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/webhooks/livepay`,
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

  async checkPaymentStatus(reference: string, currency: string = 'UGX', providerPaymentId?: string): Promise<PaymentStatusResponse> {
    try {
      const url = new URL(`${this.baseUrl}/api/transaction-status`)
      url.searchParams.append('accountNumber', this.accountNo)
      url.searchParams.append('currency', currency)
      url.searchParams.append('reference', reference)

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
      })

      const data = await response.json()

      if (response.ok && data.success) {
        const statusString = String(data.status || '').toLowerCase()
        let status: PaymentStatusResponse['status'] = 'pending'

        if (statusString === 'success' || statusString === 'completed') {
          status = 'success'
        } else if (statusString === 'failed' || statusString === 'failure') {
          status = 'failed'
        }

        return {
          success: true,
          status,
          amount: data.amount,
          currency: data.currency || currency,
          providerPaymentId: data.internal_reference || providerPaymentId,
        }
      }

      return {
        success: false,
        status: 'failed',
        failureReason: data.message || 'Status check failed',
      }
    } catch (error) {
      console.error('[LivePay] Error checking payment status:', error)
      return {
        success: false,
        status: 'pending',
        failureReason: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async validateWebhookSignature(
    payload: string,
    signatureHeader: string,
    headers?: Record<string, string>,
    requestUrl?: string
  ): Promise<boolean> {
    try {
      let sigValue = signatureHeader
      if (!sigValue && headers) {
        // Fallback to checking headers case-insensitively
        const keys = Object.keys(headers)
        const foundKey = keys.find(k => k.toLowerCase() === 'x-webhook-signature' || k.toLowerCase() === 'signature')
        if (foundKey) {
          sigValue = headers[foundKey]
        }
      }

      if (!sigValue) {
        console.warn('[LivePay] Webhook signature verification skipped: signature is missing')
        return false
      }

      const parts = sigValue.split(',')
      const timestampPart = parts.find(p => p.trim().startsWith('t='))
      const signaturePart = parts.find(p => p.trim().startsWith('v='))

      if (!timestampPart || !signaturePart) {
        console.warn('[LivePay] Webhook signature verification failed: invalid signature format', sigValue)
        return false
      }

      const timestamp = timestampPart.split('=')[1]?.trim()
      const receivedSignature = signaturePart.split('=')[1]?.trim()

      if (!timestamp || !receivedSignature) {
        console.warn('[LivePay] Webhook signature verification failed: missing timestamp or signature value')
        return false
      }

      const webhookPayload = JSON.parse(payload)
      const params = {
        amount: String(webhookPayload.amount || ''),
        currency: webhookPayload.currency || '',
        customer_reference: webhookPayload.customer_reference || '',
        internal_reference: webhookPayload.internal_reference || '',
        status: webhookPayload.status || '',
      }
      const sortedKeys = Object.keys(params).sort() as Array<keyof typeof params>
      
      // Determine possible webhook URLs to support dynamic local, preview, and production environments
      const possibleWebhookUrls: string[] = []
      
      if (requestUrl) {
        possibleWebhookUrls.push(requestUrl)
        if (requestUrl.endsWith('/')) {
          possibleWebhookUrls.push(requestUrl.slice(0, -1))
        } else {
          possibleWebhookUrls.push(requestUrl + '/')
        }
      }
      
      const nextAuthUrl = process.env.NEXTAUTH_URL
      if (nextAuthUrl) {
        const fallbackUrl = `${nextAuthUrl.replace(/\/$/, '')}/api/webhooks/livepay`
        possibleWebhookUrls.push(fallbackUrl)
        possibleWebhookUrls.push(`${fallbackUrl}/`)
      }
      
      possibleWebhookUrls.push('https://ais-dev-euerua7hv3ffzjninpghye-159837012533.europe-west3.run.app/api/webhooks/livepay')
      possibleWebhookUrls.push('https://ais-pre-euerua7hv3ffzjninpghye-159837012533.europe-west3.run.app/api/webhooks/livepay')
      possibleWebhookUrls.push('http://localhost:3000/api/webhooks/livepay')

      const uniqueUrls = Array.from(new Set(possibleWebhookUrls))

      for (const webhookUrl of uniqueUrls) {
        let stringToSign = `${webhookUrl}${timestamp}`
        for (const key of sortedKeys) {
          stringToSign += `${key}${params[key]}`
        }

        const expectedSignature = crypto
          .createHmac('sha256', this.webhookSecret || '')
          .update(stringToSign)
          .digest('hex')

        const receivedBuffer = Buffer.from(receivedSignature)
        const expectedBuffer = Buffer.from(expectedSignature)
        
        if (receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
          return true
        }
      }

      console.error(
        `[LivePay] Webhook signature verification failed. Tried URLs:`, uniqueUrls,
        `Payload:`, payload,
        `Expected signature with secret length ${this.webhookSecret?.length || 0} did not match received ${receivedSignature}`
      )
      return false
    } catch (err) {
      console.error('[LivePay] Webhook signature verification failed with error:', err)
      return false
    }
  }

  async parseWebhookPayload(payload: any): Promise<ParsedWebhook> {
    const statusString = String(payload.status || '').toLowerCase()
    
    let status: ParsedWebhook['status'] = 'pending'
    if (statusString === 'success' || statusString === 'successful') {
      status = 'success'
    } else if (statusString === 'failed' || statusString === 'failure') {
      status = 'failed'
    }

    return {
      reference: payload.customer_reference,
      providerPaymentId: payload.internal_reference,
      status,
      amount: payload.amount,
      currency: payload.currency,
      metadata: payload,
      failureReason: status === 'failed' ? 'Payment failed' : undefined,
    }
  }
}
