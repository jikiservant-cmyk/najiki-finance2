import {
  PaymentProvider,
  ProviderCredentials,
  InitiatePaymentParams,
  InitiatePaymentResponse,
  PaymentStatusResponse,
  ParsedWebhook,
} from './types'
import crypto from 'crypto'
import { normalizePhone } from '@/lib/phone'

export class LivePayProvider implements PaymentProvider {
  code = 'livepay'
  name = 'LivePay'

  private apiKey: string
  private accountNo: string
  private webhookSecret: string
  private baseUrl: string

  constructor(config?: Partial<ProviderCredentials>) {
    const clean = (v?: string) => (v ? v.trim().replace(/^["']+|["']+$/g, '').trim() : '')
    const cleanKey = (v?: string) => clean(clean(v).replace(/^bearer\s+/i, ''))
    const cleanUrl = (v?: string) => clean(v).replace(/\/+$/, '') || 'https://livepay.me'

    // An explicit tenant config is never supplemented from the platform account.
    if (config) {
      this.apiKey = cleanKey(config.apiKey || config.api_key)
      this.accountNo = clean(config.accountNo || config.account_number || config.accountNumber)
      this.webhookSecret = clean(config.webhookSecret || config.webhook_secret)
      this.baseUrl = cleanUrl(config.baseUrl || config.base_url)
      if (!this.apiKey || !this.accountNo || this.webhookSecret.length < 16) {
        throw new Error('Incomplete tenant LivePay credentials')
      }
    } else {
      this.apiKey = cleanKey(process.env.LIVEPAY_API_KEY)
      this.accountNo = clean(process.env.LIVEPAY_ACCOUNT_NO || process.env.LIVEPAY_ACCOUNT_NUMBER)
      this.webhookSecret = clean(process.env.LIVEPAY_WEBHOOK_SECRET || process.env.LIVEPAY_SECRET_KEY)
      this.baseUrl = cleanUrl(process.env.LIVEPAY_BASE_URL)
    }
  }

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResponse> {
    // Normalize local mobile money formats (e.g. "0772123456" -> "256772123456",
    // "+256772123456" -> "256772123456") so member deposits match the exact
    // 12-digit country-prefixed MSISDN format that triggers LivePay PIN prompts.
    const rawPhone = String(params.phoneNumber || '').trim()
    const normalizedPhone = normalizePhone(rawPhone).replace(/[\s\-()]/g, '').replace(/^\+/, '')
    // For UGX, LivePay example uses 50000 (major units, zero-decimal). Ensure amount is integer.
    const normalizedAmount = params.currency?.toUpperCase() === 'UGX' ? Math.round(Number(params.amount)) : params.amount
    // Enforce reference constraints per docs: max 30, no spaces
    let safeReference = String(params.reference || '').trim().replace(/\s+/g, '-')
    if (safeReference.length > 30) safeReference = safeReference.slice(0, 30)
    const payload: Record<string, any> = {
      accountNumber: this.accountNo,
      phoneNumber: normalizedPhone,
      amount: normalizedAmount,
      currency: params.currency || 'UGX',
      reference: safeReference,
      description: params.description || 'Payment',
    }
    // Only add network for non-UGX per docs
    if (payload.currency.toUpperCase() !== 'UGX' && (params as any).network) {
      payload.network = (params as any).network
    }

    console.log(`[LivePay] collect-money → ${this.baseUrl}/api/collect-money phone=${normalizedPhone.slice(0,4)}****${normalizedPhone.slice(-2)} amount=${normalizedAmount} ${payload.currency} ref=${safeReference} account=${this.accountNo.slice(0,4)}****`)

    try {
      const response = await fetch(`${this.baseUrl}/api/collect-money`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })

      let data: any = null
      let bodyText = ''
      try {
        bodyText = await response.text()
        data = JSON.parse(bodyText)
      } catch {
        // LivePay returned non-JSON (e.g. HTML 500 on bad account) — treat as failed, not silent processing
        console.error(`[LivePay] Non-JSON response from collect-money: status=${response.status} body=${bodyText.slice(0,500)}`)
        return {
          success: false,
          status: 'failed',
          failureReason: `LivePay returned non-JSON (status ${response.status}): ${bodyText.slice(0,200)}`,
        }
      }

      console.log(`[LivePay] collect-money response status=${response.status} success=${data?.success} ref=${params.reference} data=${JSON.stringify(data).slice(0,500)}`)

      if (response.ok && data.success) {
        // LivePay accepted — PIN should be sent within seconds
        return {
          success: true,
          providerPaymentId: data.internal_reference || data.transactionId || data.reference,
          status: 'processing',
          metadata: data,
        }
      }

      // LivePay rejected — surface reason so gateway can return 400/failed not silent 200
      const livePayError = data?.error || data?.message || data?.error_description || JSON.stringify(data).slice(0,300)
      // Distinguish 5xx (retryable processing) vs 4xx/200+success:false (failed)
      const isRetryable = response.status >= 500 || response.status === 429 || data?.code === 'TIMEOUT'
      return {
        success: false,
        status: isRetryable ? 'processing' : 'failed',
        failureReason: livePayError || `LivePay rejected (HTTP ${response.status})`,
      }
    } catch (error: any) {
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || String(error?.message).includes('timeout')
      console.error(`[LivePay] collect-money fetch failed ref=${params.reference} timeout=${isTimeout} error=${error?.message} stack=${error?.stack?.slice(0,300)}`)
      return {
        success: false,
        // Only timeout is ambiguous (PIN may still arrive) — keep processing so webhook can confirm
        // Other network errors are failed so SACCO gets actionable error, not silent pending
        status: isTimeout ? 'processing' : 'failed',
        failureReason: isTimeout ? `LivePay timeout after 15s: ${error.message}` : `LivePay network error: ${error.message}`,
      }
    }
  }

  async checkPaymentStatus(reference: string, currency: string = 'UGX', providerPaymentId?: string): Promise<PaymentStatusResponse> {
    try {
      let safeReference = String(reference || '').trim().replace(/\s+/g, '-')
      if (safeReference.length > 30) safeReference = safeReference.slice(0, 30)
      const url = new URL(`${this.baseUrl}/api/transaction-status`)
      url.searchParams.append('accountNumber', this.accountNo)
      url.searchParams.append('currency', currency)
      url.searchParams.append('reference', safeReference)

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(10_000),
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
        status: 'pending',
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
    requestUrl?: string,
    additionalUrls?: string[]
  ): Promise<boolean> {
    try {
      // P0-1: FAIL CLOSED. If secret is missing or too short, reject immediately.
      // An empty secret must NEVER compute an empty-key HMAC.
      if (!this.webhookSecret || this.webhookSecret.trim().length < 16) {
        console.error('[LivePay] REJECTING webhook: webhookSecret is not configured or too short (fail-closed)')
        return false
      }

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

      // P1-6: Replay window check - ensure timestamp is within 5 minutes (300,000 ms)
      const timestampNum = Number(timestamp)
      if (isNaN(timestampNum) || timestampNum <= 0) {
        console.warn('[LivePay] Webhook signature verification failed: invalid timestamp value', timestamp)
        return false
      }
      const timestampMs = timestampNum < 1e11 ? timestampNum * 1000 : timestampNum
      const now = Date.now()
      const maxReplayDriftMs = 5 * 60 * 1000
      if (Math.abs(now - timestampMs) > maxReplayDriftMs) {
        console.error(`[LivePay] Webhook REJECTED: timestamp outside 5-minute replay window (received: ${timestampMs}, now: ${now})`)
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
      
      // Candidate webhook URLs. The URL is part of the signed string, so the
      // caller passes the canonical origin first and env-configured origins
      // after it. A caller-supplied host is deliberately NOT trusted here
      // outside development — see buildSignatureUrlCandidates() in the route.
      const possibleWebhookUrls: string[] = []

      const candidates = [requestUrl, ...(additionalUrls ?? [])].filter(
        (url): url is string => typeof url === 'string' && url.length > 0
      )

      for (const candidate of candidates) {
        possibleWebhookUrls.push(candidate)
        possibleWebhookUrls.push(candidate.endsWith('/') ? candidate.slice(0, -1) : `${candidate}/`)
      }

      const nextAuthUrl = process.env.NEXTAUTH_URL
      if (nextAuthUrl) {
        const fallbackUrl = `${nextAuthUrl.replace(/\/$/, '')}/api/webhooks/livepay`
        possibleWebhookUrls.push(fallbackUrl)
        possibleWebhookUrls.push(`${fallbackUrl}/`)
      }

      const vercelUrl = process.env.VERCEL_URL
      if (vercelUrl) {
        const fallbackVercel = `https://${vercelUrl.replace(/\/$/, '')}/api/webhooks/livepay`
        possibleWebhookUrls.push(fallbackVercel)
        possibleWebhookUrls.push(`${fallbackVercel}/`)
      }

      if (process.env.NODE_ENV !== 'production') {
        possibleWebhookUrls.push('http://localhost:3000/api/webhooks/livepay')
      }

      const uniqueUrls = Array.from(new Set(possibleWebhookUrls))
      if (uniqueUrls.length === 0) {
        console.error('[LivePay] No webhook base URL available for signature verification (fail-closed)')
        return false
      }

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
