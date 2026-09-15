import { PaymentProvider, ProviderCredentials, InitiatePaymentParams, InitiatePaymentResponse, ParsedWebhook } from './types'
import { LivePayProvider } from './livepay'

class StubProvider implements PaymentProvider {
  constructor(public code: string, public name: string) {}

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResponse> {
    throw new Error(`Provider ${this.name} (${this.code}) is not yet fully implemented.`)
  }

  async validateWebhookSignature(payload: string, signature: string): Promise<boolean> {
    return false
  }

  async parseWebhookPayload(payload: any): Promise<ParsedWebhook> {
    throw new Error(`Provider ${this.name} webhook parsing is not implemented.`)
  }
}

export function getPaymentProvider(code: string, credentials?: ProviderCredentials): PaymentProvider {
  switch (code.toLowerCase()) {
    case 'livepay':
      return new LivePayProvider(credentials)
    case 'mtn':
      return new StubProvider('mtn', 'MTN Mobile Money')
    case 'airtel':
      return new StubProvider('airtel', 'Airtel Money')
    case 'pesapal':
      return new StubProvider('pesapal', 'Pesapal')
    default:
      throw new Error(`Provider not found: ${code}`)
  }
}

export function getAvailableProviders(): string[] {
  return ['livepay']
}
