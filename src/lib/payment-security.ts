import type { PaymentStatusResponse, ProviderCredentials } from './providers/types'
import { checkProviderAmount } from './provider-amount'

/** A provider transport/API error is never evidence that a payment failed. */
export function isConfirmedTerminalStatus(
  result: PaymentStatusResponse | null | undefined,
  expected?: {
    amount: number
    currency: string
    providerPaymentId?: string | null
    reference?: string | null
  }
): boolean {
  if (result?.success !== true || (result.status !== 'success' && result.status !== 'failed')) return false
  if (!expected) return true
  // Providers report the payer's GROSS plus their own fee (`charge`): LivePay
  // billed 17,510 for a 17,000 request, keeping 510 and crediting 17,000. The
  // intent amount must be compared to the NET (`amount - charge`), otherwise
  // every fee-bearing payment is stuck in `processing` forever — the status
  // poll can never confirm it and the reconcile sweep silently skips it.
  if (result.amount !== undefined) {
    const amountCheck = checkProviderAmount({
      expected: expected.amount,
      reported: result.amount,
      charge: result.charge,
    })
    if (!amountCheck.ok) return false
  }
  if (result.currency && result.currency.toUpperCase() !== expected.currency.toUpperCase()) return false
  const storedIdIsPlaceholderRef =
    Boolean(expected.reference) && expected.providerPaymentId === expected.reference
  if (
    expected.providerPaymentId &&
    !storedIdIsPlaceholderRef &&
    result.providerPaymentId &&
    expected.providerPaymentId !== result.providerPaymentId
  ) {
    return false
  }
  return true
}

/**
 * A tenant account is all-or-nothing: never fill missing fields with the
 * platform's LivePay credentials. Accept the legacy names used in older rows.
 */
export function parseTenantProviderCredentials(raw: unknown): ProviderCredentials | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  const first = (...names: string[]) => {
    for (const name of names) {
      const value = data[name]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }
  const apiKey = first('apiKey', 'api_key')
  const accountNo = first('accountNo', 'account_number', 'accountNumber')
  const webhookSecret = first('webhookSecret', 'webhook_secret')
  if (!apiKey || !accountNo || webhookSecret.length < 16) return null

  return {
    apiKey,
    accountNo,
    webhookSecret,
    // The provider's standard endpoint, not the platform's configurable URL,
    // is the default for a tenant that did not override its base URL.
    baseUrl: first('baseUrl', 'base_url') || 'https://livepay.me',
  }
}
