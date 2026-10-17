import { z } from 'zod'

export const MAX_SMS_BODY_BYTES = 8 * 1024
export const MAX_SMS_SEGMENTS = 6

// GSM extension-table characters consume two septets. Everything else outside
// the GSM alphabet is UCS-2/UTF-16 and is billed at 70/67 code units per part.
const GSM_BASIC = new Set([..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"])
const GSM_EXTENDED = new Set([...'^{}\\[~]|€'])

export function smsSegmentCount(message: string): number {
  if (!message) return 0
  let septets = 0
  let gsm = true
  for (const char of message) {
    if (GSM_BASIC.has(char)) septets += 1
    else if (GSM_EXTENDED.has(char)) septets += 2
    else { gsm = false; break }
  }
  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153)
  return message.length <= 70 ? 1 : Math.ceil(message.length / 67)
}

export const SmsInputSchema = z.object({
  to: z.string().regex(/^\+?[0-9]{9,15}$/, 'use a 9–15 digit phone number, optionally prefixed with +'),
  message: z.string().min(1).max(918).refine((value) => smsSegmentCount(value) <= MAX_SMS_SEGMENTS,
    `SMS must fit within ${MAX_SMS_SEGMENTS} segments`),
  applicationCode: z.string().min(1).max(64).optional(),
  senderId: z.string().regex(/^[A-Za-z0-9]{3,11}$/).optional(),
  from: z.string().regex(/^[A-Za-z0-9]{3,11}$/).optional(),
  idempotencyKey: z.string().trim().min(8).max(255).optional(),
  apiKey: z.string().optional(), // legacy body-key clients; never log or return
})

export function resolveSmsDailyLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 10_000
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new Error('SMS_DAILY_LIMIT_PER_APP must be an integer between 1 and 1000000')
  }
  return limit
}
