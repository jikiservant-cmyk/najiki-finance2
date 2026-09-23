/**
 * Authenticating provider callbacks that cannot carry a header.
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * Africa's Talking posts delivery reports as form-encoded bodies and does **not**
 * sign them or attach any custom header. The handler required a shared secret in
 * `x-callback-secret`, and `src/lib/env.ts` refuses to boot production without
 * that secret set — so the check always ran and *every* delivery report was
 * rejected with 401. Messages stayed `delivered` forever even when the carrier
 * rejected them, because the delivery report is the only thing that can ever
 * correct that status (there is no status-polling fallback).
 *
 * A header requirement is therefore untestable-in-reverse: it can never be
 * satisfied by the real provider. The established pattern for AT integrations —
 * including the widely-used Community Health Toolkit config — is to put the
 * secret in the callback **URL** and verify it in constant time.
 *
 * WHAT THIS ACCEPTS
 * -----------------
 * Any ONE of these, compared in constant time against the configured secret:
 *
 *   1. `x-callback-secret` header      — works for anything that can set one
 *   2. `?key=` / `?secret=` query param — the AT-compatible path
 *   3. a body field (`key` / `secret`)  — last resort for form posts
 *
 * When **no** secret is configured, the IP allow-list is used on its own — an
 * operator who has not set a URL secret yet should not be locked out of
 * delivery reports.
 *
 * When a secret IS configured, it is the credential, and a request that fails
 * it is rejected even if its IP matches the allow-list. That ordering is not
 * stylistic: the client IP comes from `x-forwarded-for`, which the caller
 * populates (see client-ip.ts), so an allow-list that can authorise on its own
 * is an allow-list an attacker satisfies by naming one of Africa's Talking's
 * published addresses. Previously the code fell through to the IP check after a
 * secret mismatch, which is exactly that bypass.
 *
 * Operators who front this endpoint with a proxy that overwrites the forwarded
 * header can opt into requiring BOTH by setting `requireAllowedIp`.
 *
 * TRADE-OFF, STATED PLAINLY
 * ------------------------
 * A query-string secret is written to access logs, proxy logs and any
 * observability tool that records URLs. That is a weaker control than a header.
 * It is accepted here because the alternative is receiving no delivery reports
 * at all, which is worse — but it means the callback URL should be treated as a
 * credential, and `AFRICASTALKING_ALLOWED_IPS` should be set as well so a leaked
 * URL alone is not sufficient.
 *
 * Pure functions only — no imports, so the test suite can reach this module.
 */

/** Query parameters and body fields a provider might carry the secret in. */
export const CALLBACK_SECRET_PARAM_NAMES = ['key', 'secret', 'callbackSecret'] as const

/**
 * Constant-time string comparison.
 *
 * Duplicated from rate-limit.ts rather than imported: this module must stay
 * import-free to remain reachable from the type-stripped test runner. Length is
 * compared first — that leaks only the length, which is fixed for a configured
 * secret and unknowable to an attacker who has not got it.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = String(a ?? '')
  const right = String(b ?? '')

  if (left.length === 0 || left.length !== right.length) return false

  let mismatch = 0
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return mismatch === 0
}

/** True when a configured secret matches any presented candidate. */
export function secretMatches(configuredSecret: string, candidates: Array<string | null | undefined>): boolean {
  const secret = String(configuredSecret ?? '')
  if (secret.length === 0) return false

  // Every candidate is compared, without an early return, so the time taken
  // does not reveal *which* candidate matched.
  let matched = false
  for (const candidate of candidates) {
    if (candidate && constantTimeEquals(secret, String(candidate).trim())) {
      matched = true
    }
  }
  return matched
}

/** Match a request's IP against a comma-separated allow-list. */
export function ipAllowed(configuredList: string, clientIp: string): boolean {
  const allowed = String(configuredList ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (allowed.length === 0) return false

  const ip = String(clientIp ?? '').trim()
  if (!ip) return false

  return allowed.some((entry) => constantTimeEquals(entry, ip))
}

export interface CallbackAuthInput {
  /** Configured shared secret; empty/absent disables secret checking. */
  configuredSecret?: string | null
  /** Configured IP allow-list (comma separated); empty disables IP checking. */
  configuredIps?: string | null
  /** Secret presented in a header, if any. */
  headerSecret?: string | null
  /** The request URL, searched for the secret as a query parameter. */
  requestUrl?: string | null
  /** Parsed body, searched for the secret as a field. */
  body?: Record<string, unknown> | null
  /** The client's IP, for the allow-list fallback. */
  clientIp?: string | null
  /**
   * Require the client IP to match the allow-list *in addition to* the secret.
   * Only meaningful when an allow-list is configured. Set this when the app sits
   * behind a proxy that overwrites `x-forwarded-for`, so the header can be
   * trusted; otherwise it turns a leaked URL back into a full compromise.
   */
  requireAllowedIp?: boolean
}

export type CallbackAuthResult =
  | { ok: true; via: 'header' | 'query' | 'body' | 'ip' }
  | { ok: false; reason: 'no-method-configured' | 'mismatch' | 'ip-not-allowed' }

/**
 * Decide whether an inbound provider callback is authentic.
 *
 * Order matters for clarity of logs, not for security: all secret candidates are
 * checked before the IP allow-list, so a valid secret is never masked by an
 * unrelated IP mismatch.
 */
export function authorizeCallback(input: CallbackAuthInput): CallbackAuthResult {
  const configuredSecret = String(input.configuredSecret ?? '')
  const configuredIps = String(input.configuredIps ?? '')
  const ipMatches =
    configuredIps.length > 0 && !!input.clientIp && ipAllowed(configuredIps, input.clientIp)

  if (configuredSecret.length > 0) {
    const via = matchSecret(configuredSecret, input)

    // The secret is configured, so it is the credential. A mismatch is a denial
    // even when the IP matches — the IP is read from a caller-populated header
    // and cannot stand in for a secret.
    if (!via) {
      return { ok: false, reason: 'mismatch' }
    }

    // Opt-in hardening for deployments behind a proxy they control.
    if (input.requireAllowedIp && configuredIps.length > 0 && !ipMatches) {
      return { ok: false, reason: 'ip-not-allowed' }
    }

    return { ok: true, via }
  }

  // No secret configured: the allow-list is the only configured method.
  if (ipMatches) {
    return { ok: true, via: 'ip' }
  }

  if (configuredIps.length === 0) {
    return { ok: false, reason: 'no-method-configured' }
  }

  return { ok: false, reason: 'mismatch' }
}

/** Which of the accepted channels carried a matching secret, if any. */
function matchSecret(
  configuredSecret: string,
  input: CallbackAuthInput
): 'header' | 'query' | 'body' | null {
  if (input.headerSecret && secretMatches(configuredSecret, [input.headerSecret])) {
    return 'header'
  }

  let queryCandidates: Array<string | null> = []
  if (input.requestUrl) {
    try {
      const url = new URL(input.requestUrl)
      queryCandidates = CALLBACK_SECRET_PARAM_NAMES.map((name) => url.searchParams.get(name))
    } catch {
      // A URL we cannot parse simply yields no query candidates.
      queryCandidates = []
    }
  }
  if (secretMatches(configuredSecret, queryCandidates)) {
    return 'query'
  }

  const body = input.body ?? {}
  const bodyCandidates = CALLBACK_SECRET_PARAM_NAMES.map((name) => {
    const value = (body as Record<string, unknown>)[name]
    return value === undefined || value === null ? null : String(value)
  })
  if (secretMatches(configuredSecret, bodyCandidates)) {
    return 'body'
  }

  return null
}
