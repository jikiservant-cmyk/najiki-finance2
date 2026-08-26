import { PaymentProvider, ProviderCredentials } from './types'
import { LivePayProvider } from './livepay'

export function getPaymentProvider(code: string, credentials?: ProviderCredentials): PaymentProvider {
  switch (code.toLowerCase()) {
    case 'livepay':
      return new LivePayProvider(credentials)
    default:
      throw new Error(`Provider not found: ${code}`)
  }
}

export function getAvailableProviders(): string[] {
  return ['livepay']
}
