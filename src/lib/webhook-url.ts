/**
 * Candidate webhook URLs used as the signature base string, most authoritative
 * first.
 *
 * LivePay signs `<url><timestamp><sorted params>` where `<url>` is the URL it
 * was given at initiation time. We therefore try the configured public origin
 * before anything derived from request headers: trusting `x-forwarded-host`
 * lets a caller control a component of the signed string.
 */
export function buildSignatureUrlCandidates(request: Request): string[] {
  const urls: string[] = []
  const path = new URL(request.url).pathname

  const configured = (process.env.NEXTAUTH_URL || '').replace(/\/+$/, '')
  if (configured) urls.push(`${configured}${path}`)

  const vercel = (process.env.VERCEL_URL || '').replace(/\/+$/, '')
  if (vercel) urls.push(`https://${vercel}${path}`)

  if (process.env.NODE_ENV !== 'production') {
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host')
    const protocol = request.headers.get('x-forwarded-proto') || 'https'
    if (host) urls.push(`${protocol}://${host}${path}`)
    urls.push(`http://localhost:3000${path}`)
  }

  const unique = Array.from(new Set(urls.map((u) => u.replace(/\/+$/, ''))))
  if (unique.length === 0) {
    throw new Error('No webhook base URL configured (set NEXTAUTH_URL)')
  }
  return unique
}
