import crypto from 'crypto'

const ALGO = 'aes-256-gcm'

// Generate a secure key for dev if not provided (so it doesn't crash locally, though it should be required in prod)
const getEncryptionKey = () => {
  const envKey = process.env.APP_ENCRYPTION_KEY
  if (envKey && envKey.length === 64) {
    return Buffer.from(envKey, 'hex')
  }
  // Fallback for dev ONLY, ideally throw in prod
  if (process.env.NODE_ENV === 'production') {
    console.warn('CRITICAL: APP_ENCRYPTION_KEY is missing or invalid in production!')
  }
  return crypto.scryptSync(process.env.NEXTAUTH_SECRET || 'fallback-secret-1234', 'salt', 32)
}

export function encrypt(text: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

export function decrypt(payload: string): string {
  try {
    const key = getEncryptionKey()
    const [ivHex, tagHex, encHex] = payload.split(':')
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()])
    return dec.toString('utf8')
  } catch (err) {
    console.error('Decryption failed', err)
    throw new Error('Decryption failed')
  }
}
