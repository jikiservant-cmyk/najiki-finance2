import { PaymentProvider, ProviderCredentials, InitiatePaymentParams, InitiatePaymentResponse, ParsedWebhook } from './types'
import { LivePayProvider } from './livepay'

/**
 * Providers with a working implementation.
 *
 * This list is load-bearing, not documentation. `stub` providers below throw on
 * `initiatePayment`, and the seeded database has MTN/Airtel/Pesapal rows marked
 * `isActive: true` — so "pick the first active provider" could select a provider
 * that cannot accept a payment, and did. Every provider-selection path filters
 * on this list.
 *
 * Adding a provider to this array without implementing it re-introduces the bug.
 */
export const IMPLEMENTED_PROVIDER_CODES = ['livepay'] as const

type ImplementedProviderCode = (typeof IMPLEMENTED_PROVIDER_CODES)[number]

/** True when a working adapter exists for this code. */
export function isProviderImplemented(code: string | null | undefined): boolean {
  const normalized = String(code ?? '').trim().toLowerCase()
  return (IMPLEMENTED_PROVIDER_CODES as readonly string[]).includes(normalized)
}

/**
 * Providers that exist as rows but have no adapter.
 *
 * Kept so callers can give a useful error ("MTN MoMo is configured but not
 * implemented") instead of the opaque throw from the stub itself.
 */
class StubProvider implements PaymentProvider {
  constructor(public code: string, public name: string) {}

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResponse> {
    throw new Error(
      `Provider ${this.name} (${this.code}) has no working adapter. It must not be ` +
        `selectable for payments — see IMPLEMENTED_PROVIDER_CODES in src/lib/providers/index.ts.`
    )
  }

  async validateWebhookSignature(payload: string, signature: string): Promise<boolean> {
    // Reject: there is no implementation here to verify anything with, so
    // accepting would be a fail-open webhook endpoint.
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

/**
 * Providers that may be used to take a payment.
 *
 * Used to filter provider queries and to populate the Setup UI, so an operator
 * cannot configure a tenant onto a provider that will throw on first use.
 */
export function getAvailableProviders(): string[] {
  return [...IMPLEMENTED_PROVIDER_CODES as readonly string[]]
}

/** Display name for a code, for error messages. */
export function providerDisplayName(code: string): string {
  const names: Record<string, string> = {
    livepay: 'LivePay',
    mtn: 'MTN Mobile Money',
    airtel: 'Airtel Money',
    pesapal: 'Pesapal',
  }
  return names[String(code).toLowerCase()] ?? String(code)
}
