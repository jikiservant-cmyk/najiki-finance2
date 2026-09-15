/**
 * Normalizes a phone number to standard E.164 format (+256...)
 */
export function normalizeToE164(phone: string): string {
  if (!phone) return ''
  let cleaned = phone.replace(/[\s\-\(\)]/g, '')
  
  if (cleaned.startsWith('00256')) {
    cleaned = '+256' + cleaned.slice(5)
  } else if (cleaned.startsWith('0')) {
    cleaned = '+256' + cleaned.slice(1)
  } else if (cleaned.startsWith('256')) {
    cleaned = '+' + cleaned
  } else if (cleaned.length === 9 && cleaned.startsWith('7')) {
    cleaned = '+256' + cleaned
  } else if (!cleaned.startsWith('+')) {
    cleaned = `+${cleaned}`
  }
  return cleaned
}

/**
 * Normalizes a phone number for local payment gateways (e.g., LivePay)
 * Drops the + and ensures standard prefix.
 */
export function normalizePhone(phone: string): string {
  let e164 = normalizeToE164(phone)
  if (e164.startsWith('+')) {
    return e164.substring(1)
  }
  return e164
}
