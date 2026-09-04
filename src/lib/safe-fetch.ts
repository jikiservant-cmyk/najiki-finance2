/**
 * Known placeholder / template hostnames that should not be hit with outbound network requests
 */
const PLACEHOLDER_DOMAINS = [
  'yourdomain.com',
  'example.com',
  'example.org',
  'example.net',
  'test.com',
  'localhost.localdomain',
]

export function isPlaceholderUrl(urlString: string): boolean {
  try {
    const cleaned = urlString.trim()
    if (!cleaned) return true
    const parsed = new URL(cleaned)
    const hostname = parsed.hostname.toLowerCase()
    
    return PLACEHOLDER_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`)
    )
  } catch {
    return true
  }
}

export async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const urlString = typeof input === 'string'
    ? input.trim()
    : input instanceof URL
      ? input.toString()
      : input.url

  // 1. Validate URL syntax and protocol
  let parsedUrl: URL
  try {
    parsedUrl = new URL(urlString)
  } catch {
    throw new Error(`Invalid target URL: "${urlString}"`)
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Unsupported protocol for fetch: "${parsedUrl.protocol}"`)
  }

  // 2. Reject unconfigured placeholder domains before TLS negotiation
  if (isPlaceholderUrl(urlString)) {
    throw new Error(`Target host is an unconfigured placeholder domain: ${parsedUrl.hostname}. Configure a live endpoint URL to receive webhooks.`)
  }

  // 3. Set a sensible default timeout (8s) if caller didn't provide an AbortSignal
  const signal = init?.signal ?? AbortSignal.timeout(8000)

  return fetch(input, {
    ...init,
    signal,
  })
}
