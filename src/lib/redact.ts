/**
 * PII redaction helpers.
 *
 * Uganda's Data Protection and Privacy Act (and good manners generally) require
 * that phone numbers are not written to application logs or to audit tables in
 * cleartext. These helpers are pure functions so they are trivially testable.
 */

/** Canonical digits-only form of a phone number ("+256 700 123 456" → "256700123456"). */
export function normalizePhoneNumber(value: string): string {
  return String(value || '').replace(/[^\d]/g, '')
}

/**
 * Mask a phone number for logs: keep the leading country/dial prefix and the
 * last two digits, hide the middle.
 *
 *   maskPhoneNumber('+256700123456') → '+2567******56'
 *   maskPhoneNumber('0700123456')    → '0700****56'
 */
export function maskPhoneNumber(value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''

  const digits = normalizePhoneNumber(raw)
  if (digits.length < 6) {
    // Too short to mask meaningfully — hide everything but the last digit.
    return '*'.repeat(Math.max(raw.length - 1, 0)) + raw.slice(-1)
  }

  const hasPlus = raw.startsWith('+')
  const head = digits.slice(0, 4)
  const tail = digits.slice(-2)
  const masked = '*'.repeat(Math.max(digits.length - head.length - tail.length, 1))

  return `${hasPlus ? '+' : ''}${head}${masked}${tail}`
}

/**
 * Phone-shaped run: 9-15 digits, optionally with a leading `+` and with
 * dashes/parentheses as separators. Contiguous formats only — spaced-out
 * numbers should be normalised with `normalizePhoneNumber` before logging.
 *
 * The lookarounds keep provider identifiers such as `IP-123456789012` intact.
 */
const PHONE_LIKE = /(?<![\w-])\+?\d[\d\-()]{6,18}\d(?![\w-])/g

/**
 * Free-text redaction for provider payloads stored for audit and for persisted
 * error strings.
 *
 * Only runs that actually look like phone numbers (9-15 digits) are touched, so
 * amounts (`50000`), references (`NK-CHU-AB12`) and provider ids (`IP-...`) are
 * left alone.
 */
export function redactPhoneNumbersInText(text: string): string {
  if (!text) return ''
  return text.replace(PHONE_LIKE, (match) => {
    const digits = normalizePhoneNumber(match)
    if (digits.length < 9 || digits.length > 15) return match
    const hasPlus = match.trimStart().startsWith('+')
    return maskPhoneNumber(`${hasPlus ? '+' : ''}${digits}`)
  })
}

/**
 * Safe, loggable form of an unknown thrown value.
 * Full error text is still persisted to the DB where the caller decides to.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return 'Unknown error'
  }
}
