import { promises as dns } from 'dns'
import net from 'net'

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

const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
]

/**
 * Checks if an IP address belongs to private, loopback, link-local, or cloud metadata ranges.
 */
export function isPrivateOrInternalIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some(isNaN)) return true

    // 0.0.0.0/8 (Current network)
    if (parts[0] === 0) return true
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true
    // 10.0.0.0/8 (Private RFC 1918)
    if (parts[0] === 10) return true
    // 172.16.0.0/12 (Private RFC 1918: 172.16.0.0 - 172.31.255.255)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    // 192.168.0.0/16 (Private RFC 1918)
    if (parts[0] === 192 && parts[1] === 168) return true
    // 169.254.0.0/16 (Link-local / Cloud Metadata)
    if (parts[0] === 169 && parts[1] === 254) return true
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (parts[0] >= 224) return true

    return false
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase().trim()
    // ::1 loopback, :: unspecified
    if (normalized === '::1' || normalized === '::') return true
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:169.254.169.254)
    if (normalized.startsWith('::ffff:')) {
      const ipv4Part = normalized.slice(7)
      if (net.isIPv4(ipv4Part)) {
        return isPrivateOrInternalIp(ipv4Part)
      }
      return true
    }
    // Unique Local Addresses fc00::/7 (starts with fc or fd)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    // Link-local fe80::/10 (starts with fe8, fe9, fea, feb)
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) return true

    return false
  }

  return false
}

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

export async function validateSafeUrl(urlString: string): Promise<URL> {
  const cleaned = urlString.trim()
  let parsedUrl: URL
  try {
    parsedUrl = new URL(cleaned)
  } catch {
    throw new Error(`Invalid target URL: "${urlString}"`)
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Unsupported protocol for fetch: "${parsedUrl.protocol}"`)
  }

  const hostname = parsedUrl.hostname.toLowerCase()

  // 1. Check for placeholder / template domains
  if (isPlaceholderUrl(cleaned)) {
    throw new Error(`Target host is an unconfigured placeholder domain: ${hostname}`)
  }

  // 2. Check for blocked internal hostnames
  if (
    BLOCKED_HOSTNAMES.includes(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error(`Target host is restricted internal infrastructure: ${hostname}`)
  }

  // 3. Check direct IP address literal
  if (net.isIP(hostname)) {
    if (isPrivateOrInternalIp(hostname)) {
      throw new Error(`Requests to private or internal IP addresses are blocked: ${hostname}`)
    }
  } else {
    // 4. Resolve DNS to protect against DNS rebinding / hostnames resolving to internal IPs
    try {
      const lookupResult = await dns.lookup(hostname, { all: true })
      for (const entry of lookupResult) {
        if (isPrivateOrInternalIp(entry.address)) {
          throw new Error(`Target host ${hostname} resolves to blocked internal IP: ${entry.address}`)
        }
      }
    } catch (err: any) {
      // Re-throw SSRF block errors
      if (err.message && err.message.includes('blocked internal IP')) {
        throw err
      }
      // If DNS resolution fails outright, fetch will fail anyway
    }
  }

  return parsedUrl
}

export async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const urlString = typeof input === 'string'
    ? input.trim()
    : input instanceof URL
      ? input.toString()
      : input.url

  // Validate URL syntax, protocol, placeholder domains, and SSRF ranges
  await validateSafeUrl(urlString)

  // Set a sensible default timeout (8s) if caller didn't provide an AbortSignal
  const signal = init?.signal ?? AbortSignal.timeout(8000)

  return fetch(input, {
    ...init,
    signal,
  })
}
