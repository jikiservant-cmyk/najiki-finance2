import { PaymentProvider } from './types'
import { LivePayProvider } from './livepay'

// Add other providers here as we implement them
const providers: Record<string, new () => PaymentProvider> = {
  livepay: LivePayProvider,
  // mtn: MtnProvider,
  // airtel: AirtelProvider,
  // pesapal: PesapalProvider,
}

export function getPaymentProvider(code: string): PaymentProvider {
  const ProviderClass = providers[code.toLowerCase()]
  if (!ProviderClass) {
    throw new Error(`Provider not found: ${code}`)
  }
  return new ProviderClass()
}

export function getAvailableProviders(): string[] {
  return Object.keys(providers)
}
