// Classification for a PaymentIntent whose initiate call ended `failed`.
//
// One HTTP status cannot serve three very different situations:
//
//   - LivePay actively refused the collection (bad account number, duplicate
//     reference, invalid phone) → the partner can fix the request: 422.
//   - Our static-IP egress proxy refused the CONNECT tunnel (typically HTTP
//     402 Payment Required — the proxy vendor account is out of credit) →
//     LivePay was never contacted; this is broken infrastructure: 502.
//   - The gateway could not reach LivePay at all (DNS/refused/TLS) → also
//     infrastructure, also 502.
//
// Returning 422 for the latter two made operators chase SACCO credentials and
// LivePay-side issues that were never involved, while the real fix (top up the
// proxy vendor / repair egress) stayed invisible.

export type PaymentFailureKind =
  /** LivePay received the request and rejected it — partner-actionable. */
  | 'provider_rejected'
  /** Static-IP proxy refused/blocked the tunnel — LivePay never contacted. */
  | 'proxy_unavailable'
  /** Gateway could not reach LivePay itself. */
  | 'provider_unreachable'

export interface PaymentFailurePresentation {
  httpStatus: number
  code: 'PAYMENT_PROVIDER_REJECTED' | 'PAYMENT_STATIC_PROXY_UNAVAILABLE' | 'PAYMENT_PROVIDER_UNREACHABLE'
  retryable: boolean
  error: string
  hint: string
}

/**
 * String-based on purpose: the reason has already round-tripped through
 * `paymentIntent.failureReason` (a DB column), so an Error class cannot travel
 * with it. Both markers are produced only by our own provider code, never by
 * LivePay's payload.
 */
export function classifyPaymentFailure(
  failureReason: string | null | undefined
): PaymentFailureKind {
  const reason = String(failureReason || '')
  if (reason.includes('Static IP proxy')) return 'proxy_unavailable'
  if (reason.startsWith('LivePay network error')) return 'provider_unreachable'
  return 'provider_rejected'
}

export function presentPaymentFailure(
  failureReason: string | null | undefined
): PaymentFailurePresentation {
  const kind = classifyPaymentFailure(failureReason)

  if (kind === 'proxy_unavailable') {
    return {
      httpStatus: 502,
      code: 'PAYMENT_STATIC_PROXY_UNAVAILABLE',
      retryable: true,
      error: `Payment infrastructure failure — static IP proxy refused the tunnel, so LivePay was never contacted: ${failureReason}`,
      hint:
        'NOT a LivePay rejection and NOT SACCO credentials. The static outbound proxy ' +
        '(LIVEPAY_PROXY_URL / QUOTAGUARDSTATIC_URL / FIXIE_URL) refused the CONNECT — ' +
        'HTTP 402 means the proxy vendor account is out of credits or past due: top up the ' +
        'vendor or fix the proxy URL, then retry. No PIN was sent.',
    }
  }

  if (kind === 'provider_unreachable') {
    return {
      httpStatus: 502,
      code: 'PAYMENT_PROVIDER_UNREACHABLE',
      retryable: true,
      error: `Payment infrastructure failure — gateway could not reach LivePay: ${failureReason}`,
      hint:
        'LivePay never received this collection request, so no PIN was sent. Check outbound ' +
        'connectivity from this deployment to the LivePay base URL, then retry.',
    }
  }

  return {
    httpStatus: 422,
    code: 'PAYMENT_PROVIDER_REJECTED',
    retryable: false,
    error: failureReason
      ? `Payment provider rejected collection: ${failureReason}`
      : 'Payment provider rejected collection request.',
    hint: 'PIN not sent — verify SACCO LivePay Account Number + API Key in Setup and phone number.',
  }
}
