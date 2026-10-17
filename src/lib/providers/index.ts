// All five are interfaces. Without `import type` Node's strip-only type erasure
// (which is what `npm test` runs under) keeps them as runtime imports, and the
// module fails to instantiate with "does not provide an export named ...".
// Next.js/bundlers erase them, so this never surfaced in the app itself.
import type { PaymentProvider, ProviderCredentials, InitiatePaymentParams, InitiatePaymentResponse, ParsedWebhook } from './types'
import { LivePayProvider } from './livepay'

// Provider-availability rules live in ./availability, which has no imports, so
// `npm test` can exercise them directly. This module cannot be loaded by the
// test runner: the extensionless `./types` and `./livepay` specifiers above are
// not resolved by Node's strip-only type erasure. Re-exported here so every
// existing `@/lib/providers` import site keeps working unchanged.
export {
  IMPLEMENTED_PROVIDER_CODES,
  isProviderImplemented,
  getAvailableProviders,
  providerDisplayName,
  defaultProviderIssue,
  tenantsWithDefaultProviderIssue,
} from './availability'
export type { DefaultProviderIssue, TenantProviderProblem, TenantProviderShape } from './availability'

/**
 * Providers that exist as rows but have no adapter.
 *
 * Kept so callers can give a useful error ("MTN MoMo is configured but not
 * implemented") instead of the opaque throw from the stub itself.
 */
class StubProvider implements PaymentProvider {
  // Plain field declarations rather than constructor parameter properties:
  // `constructor(public code: ...)` is not supported by Node's strip-only type
  // erasure. That is not cosmetic — it made the module fail to parse under the
  // test runner before the resolver issue even came up.
  code: string
  name: string

  constructor(code: string, name: string) {
    this.code = code
    this.name = name
  }

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResponse> {
    throw new Error(
      `Provider ${this.name} (${this.code}) has no working adapter. It must not be ` +
        `selectable for payments — see IMPLEMENTED_PROVIDER_CODES in src/lib/providers/availability.ts.`
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
