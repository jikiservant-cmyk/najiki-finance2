// Payment Provider Interface
// All payment providers (LivePay, MTN, Airtel, Pesapal) must implement this

export interface PaymentProvider {
  code: string
  name: string

  // Initiate a payment request
  initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResponse>

  // Check payment status (optional, but some providers require it)
  checkPaymentStatus?(providerPaymentId: string): Promise<PaymentStatusResponse>

  // Validate webhook signature
  validateWebhookSignature(payload: string, signature: string, headers?: Record<string, string>): Promise<boolean>

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
