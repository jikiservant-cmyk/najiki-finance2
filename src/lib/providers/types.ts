// Payment Provider Interface
// All payment providers (LivePay, MTN, Airtel, Pesapal) must implement this

export interface ProviderCredentials {
  apiKey?: string
  accountNo?: string
  webhookSecret?: string
  baseUrl?: string
  [key: string]: any
}

export interface PaymentProvider {
  code: string
  name: string

  // Initiate a payment request
  initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResponse>

  // Check payment status (optional, but some providers require it)
  checkPaymentStatus?(reference: string, currency?: string, providerPaymentId?: string): Promise<PaymentStatusResponse>

  /**
   * Validate an inbound webhook signature.
   *
   * @param payload        exact raw request body (never a re-serialized copy)
   * @param signature      signature header value
   * @param headers        all request headers, lower-cased keys
   * @param requestUrl     canonical public URL the webhook was delivered to
   * @param additionalUrls other acceptable base URLs (env-configured origins),
   *                       tried only after `requestUrl`
   */
  validateWebhookSignature(
    payload: string,
    signature: string,
    headers?: Record<string, string>,
    requestUrl?: string,
    additionalUrls?: string[]
  ): Promise<boolean>

  // Parse webhook payload into standard format
  parseWebhookPayload(payload: any): Promise<ParsedWebhook>
}

export interface InitiatePaymentParams {
  amount: number
  currency: string
  phoneNumber: string
  reference: string
  description?: string
  metadata?: Record<string, any>
  webhookUrl?: string
}

export interface InitiatePaymentResponse {
  success: boolean
  providerPaymentId?: string
  status: 'pending' | 'processing' | 'success' | 'failed'
  redirectUrl?: string
  metadata?: Record<string, any>
  failureReason?: string
}

export interface PaymentStatusResponse {
  success: boolean
  status: 'pending' | 'processing' | 'success' | 'failed' | 'expired' | 'cancelled'
  amount?: number
  currency?: string
  providerPaymentId?: string
  failureReason?: string
}

export interface ParsedWebhook {
  reference: string
  providerPaymentId: string
  status: 'pending' | 'processing' | 'success' | 'failed' | 'expired' | 'cancelled'
  amount?: number
  currency?: string
  metadata?: Record<string, any>
  failureReason?: string
}
