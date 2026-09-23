import { Receiver } from '@upstash/qstash'
import { constantTimeEqual } from '@/lib/api-keys'

export async function verifyCronRequest(request: Request): Promise<boolean> {
  const qstashSignature = request.headers.get('upstash-signature')
  const authHeader = request.headers.get('authorization')
  
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY
  const cronSecret = process.env.CRON_SECRET

  let isAuthorized = false

  // 1. QStash Signature Verification
  if (qstashSignature && currentSigningKey) {
    try {
      const receiver = new Receiver({
        currentSigningKey,
        nextSigningKey: nextSigningKey || currentSigningKey,
      })
      const body = await request.clone().text()
      isAuthorized = await receiver.verify({
        signature: qstashSignature,
        body,
      })
    } catch (err) {
      console.error('QStash verification error:', err)
    }
  }

  // 2. CRON_SECRET Fallback (for Vercel Cron, GitHub Actions, or local manual testing)
  //
  // Compared in constant time. `===` on a secret short-circuits at the first
  // differing byte, which leaks its prefix to anyone who can time the response.
  // Remote timing attacks on a 16+ character secret are impractical over the
  // internet, but this is the same primitive the API-key path already uses and
  // there is no reason for the cron path to be the weaker one.
  if (!isAuthorized && cronSecret && constantTimeEqual(authHeader ?? '', `Bearer ${cronSecret}`)) {
    isAuthorized = true
  }

  return isAuthorized
}
