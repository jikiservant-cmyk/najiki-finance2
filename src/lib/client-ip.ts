/**
 * Working out which IP an inbound request actually came from.
 *
 * `x-forwarded-for` is a list a proxy appends to: each hop adds the address it
 * received the request from, so the entries read left-to-right as
 * `<whoever the client claimed>, ..., <real client>, <our proxy>`.
 *
 * The left end is therefore supplied by the caller. Anything that treats the
 * FIRST entry as the client — which both the rate limiter and the Africa's
 * Talking callback did — can be defeated by sending a header:
 *
 *     X-Forwarded-For: 1.2.3.4      ← attacker picks this
 *
 * That made per-IP rate limits rotatable at will (one token bucket per spoofed
 * address, so a limit of 60/min became unlimited), and made the callback
 * allow-list accept any request that named an allow-listed address.
 *
 * Only the entries added by infrastructure we control can be trusted, and those
 * are at the RIGHT end. With one proxy in front of the app — a Vercel edge, a
 * load balancer — the last entry is the client as that proxy saw it, and it is
 * the closest thing to a trustworthy answer available from a header.
 *
 * This is why the callback allow-list must never be the *only* credential (see
 * callback-auth.ts): even a correctly-read forwarded header is only as good as
 * the proxy that wrote it.
 *
 * Zero imports so the type-stripped test runner can reach it.
 */

/**
 * How many rightmost entries to skip, i.e. how many proxies of our own sit in
 * front of the application. 1 = one edge/load balancer, which is the common
 * deployment. Raise it (TRUSTED_PROXY_HOPS) for each additional layer of your
 * own infrastructure; getting this wrong reads an attacker-supplied entry, so
 * erring high is safer than erring low.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1

/** Entries longer than this are not addresses; ignore junk rather than trust it. */
const MAX_ENTRY_LENGTH = 45 // longest IPv6 textual form

function parseHops(raw: string | number | null | undefined): number {
  const parsed = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TRUSTED_PROXY_HOPS
  return Math.floor(parsed)
}

/**
 * Pick the most trustworthy address out of a forwarded-for list.
 *
 * Returns `''` when the list is empty or entirely junk — never a placeholder
 * like `'unknown'`, so callers cannot accidentally treat a failed lookup as a
 * valid identity.
 */
export function clientIpFromForwardedFor(
  forwardedFor: string | null | undefined,
  trustedProxyHops: string | number | null | undefined = DEFAULT_TRUSTED_PROXY_HOPS
): string {
  const entries = String(forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= MAX_ENTRY_LENGTH)

  if (entries.length === 0) return ''

  const hops = parseHops(trustedProxyHops)
  // Entries appended by our own proxies are the last `hops`. The client is the
  // one immediately before them. Clamp so a short list cannot index negatively
  // and so a long list cannot read past the trustworthy boundary.
  const index = Math.max(0, entries.length - hops)
  return entries[index] ?? ''
}

/**
 * The client IP for a request, given the headers it carried.
 *
 * Prefers the forwarded-for list, because the number of trusted hops is
 * something an operator can reason about, whereas `x-real-ip` has no defined
 * provenance — anything that can set a header can set that one, so it is only
 * consulted when explicitly enabled with TRUST_X_REAL_IP.
 */
export function resolveClientIp(input: {
  forwardedFor?: string | null
  realIp?: string | null
  trustedProxyHops?: string | number | null
  trustRealIp?: boolean | string | null
}): string {
  const fromForwarded = clientIpFromForwardedFor(input.forwardedFor, input.trustedProxyHops)
  if (fromForwarded) return fromForwarded

  const trustRealIp =
    input.trustRealIp === true || String(input.trustRealIp ?? '').trim().toLowerCase() === 'true'
  if (!trustRealIp) return ''

  const realIp = String(input.realIp ?? '').trim()
  return realIp.length > 0 && realIp.length <= MAX_ENTRY_LENGTH ? realIp : ''
}
