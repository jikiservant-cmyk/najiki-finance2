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
  // Trimmed because this value is commonly supplied from a secret store, and a
  // trailing newline copied out of one used to fail the application-code check
  // with a 403 whose message named neither the value sent nor the one expected.
  applicationCode: z.string().trim().min(1).max(64).optional(),
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

/**
 * Match a caller-supplied `applicationCode` against an application's stored code.
 *
 * Why this exists
 * ---------------
 * The partner SMS route compared the two with `!==`. That made three ordinary
 * inputs fail permanently with `403 Application code mismatch`:
 *
 *   • the reference prefix — references are built as
 *     `${appCode.slice(0,6).toUpperCase()}-…` (see payment-intent-handler), so a
 *     partner copying `CHURCH-BUY-…` naturally sends `CHURCH` for an app whose
 *     stored code is `church`;
 *   • a value pasted from a secret store, which routinely carries a trailing
 *     newline or space;
 *   • any other casing of the same code.
 *
 * None of those are an authorisation failure — the API key has already decided
 * which application the caller is. This check is a courtesy guard against
 * sending under the wrong code, so it should compare normalised text.
 *
 * An omitted code still matches: the API key alone identifies the application,
 * and that behaviour predates this helper.
 */
export function applicationCodeMatches(
  storedCode: string | null | undefined,
  providedCode: string | null | undefined
): boolean {
  if (providedCode === null || providedCode === undefined) return true
  const provided = String(providedCode).trim().toLowerCase()
  if (!provided) return true
  const stored = String(storedCode ?? '').trim().toLowerCase()
  return stored !== '' && stored === provided
}

/**
 * Whether terminal `unknown` SMS rows should notify the partner.
 *
 * `unknown` means "submitted, and no delivery report arrived inside the
 * settlement window" — from `markStalePendingUnknown`. It is a dead end for a
 * partner that is tracking a broadcast, because nothing else will ever update
 * that row. It is off by default so that enabling it is a deliberate decision:
 * partners that have not implemented handling for it would otherwise start
 * receiving a status they never expect.
 */
export function smsNotifyUnknownEnabled(raw: string | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'true'
}

