import crypto from 'crypto'

const ALGO = 'aes-256-gcm'

// Development-only ephemeral key. Production always requires APP_ENCRYPTION_KEY.
const ephemeralDevKey = crypto.randomBytes(32)
const getEncryptionKey = () => {
  const envKey = process.env.APP_ENCRYPTION_KEY
  // Must be exactly 64 HEX characters (32 bytes). Length alone is not enough:
  // Buffer.from(x, 'hex') silently drops invalid characters, which would
  // produce a wrong-length key and throw a confusing error at cipher time.
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey)) {
    return Buffer.from(envKey, 'hex')
  }
  // Fallback for dev ONLY, throw in prod
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CRITICAL: APP_ENCRYPTION_KEY must be a 64-character hex string in production!'
    )
  }
  if (envKey) {
    console.warn(
      '[encryption] APP_ENCRYPTION_KEY is set but is not a 64-character hex string — falling back to the development key.'
    )
  }
  console.warn('[encryption] Using an ephemeral development key; encrypted data cannot be read after restart')
  return ephemeralDevKey
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
