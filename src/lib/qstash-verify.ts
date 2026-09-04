import { Receiver } from '@upstash/qstash'

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
  if (!isAuthorized && cronSecret && authHeader === `Bearer ${cronSecret}`) {
    isAuthorized = true
  }

  return isAuthorized
}
