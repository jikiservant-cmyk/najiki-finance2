import africastalking from 'africastalking'
import { normalizeToE164 } from '@/lib/phone'

/** The AT SDK does not configure an Axios timeout. A timed-out call is
 * ambiguous, so its SMS stays pending and is NEVER automatically resent.
 * This bounds a cron invocation without pretending to cancel provider I/O.
 */
/** Guard so the sandbox warning is emitted once per process, not per message. */
let warnedAboutSandbox = false

export async function waitForSmsProvider<T>(operation: Promise<T>, maxWaitMs = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider outcome unknown')), maxWaitMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type AfricaTalkingSmsResponse = {
  SMSMessageData?: {
    Message?: string
    Recipients?: Array<{ status?: string; messageId?: string; cost?: string | number }>
  }
}

/**
 * Africa's Talking failure reasons that mean "this was not sent, and retrying
 * the same request unchanged will not change that".
 *
 * WHY THIS EXISTS
 * ---------------
 * The provider reports failures in TWO different places, and only one of them
 * was being read:
 *
 *   • **per recipient** — `SMSMessageData.Recipients[].status` (e.g.
 *     `InsufficientBalance`), which the route already handled; and
 *   • **account level** — `SMSMessageData.Message`, with **no** `Recipients`
 *     array at all (e.g. `Invalid API Key`, `Insufficient balance`,
 *     `User not found`).
 *
 * An account-level failure left `status` as the empty string, which failed the
 * explicit-rejection test and threw "Provider outcome unknown". That exception is
 * classified downstream as *ambiguous transport* — deliberately, because a lost
 * response must never be treated as a failure — so the message stayed `pending`
 * with `failure_reason: null` and became `unknown` 48 hours later.
 *
 * That is the worst possible outcome for an operator: a permanent
 * misconfiguration (wrong key, empty balance, unregistered sender) presented as
 * a transient network hiccup, with no reason recorded anywhere.
 *
 * Only unambiguous "we did not accept this" reasons are listed. Anything
 * unrecognised still throws, so an uncertain outcome is never turned into a
 * failure — that would risk a second billed send.
 */
const PERMANENT_PROVIDER_FAILURES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /invalid\s*api\s*key/i, label: 'InvalidApiKey' },
  { pattern: /invalid\s*username|user\s*not\s*found|unrecognised?\s*username/i, label: 'InvalidUsername' },
  { pattern: /insufficient\s*(balance|credit|funds)|not\s*enough\s*(balance|credit|funds)|no\s*credit/i, label: 'InsufficientBalance' },
  { pattern: /invalid\s*sender\s*id|sender\s*id[^.]*\b(not\s*(registered|approved|allowed)|invalid)\b/i, label: 'InvalidSenderId' },
  { pattern: /invalid\s*(phone|number|recipient)s?\b|invalid\s*phone\s*number|unrecognised?\s*number/i, label: 'InvalidPhoneNumber' },
  { pattern: /account\s*(is\s*)?(suspended|inactive|disabled|blocked)/i, label: 'AccountInactive' },
]

/**
 * Map a provider message to a stable label plus the provider's own words, or
 * null when the reason is not one we can act on.
 *
 * The label leads so a machine can group on it; the provider's text follows so a
 * human can read the exact wording Africa's Talking used.
 */
export function classifyProviderFailure(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  for (const { pattern, label } of PERMANENT_PROVIDER_FAILURES) {
    if (pattern.test(text)) return `${label}: ${text.slice(0, 160)}`
  }
  return null
}

/**
 * Recover the provider's reason from whatever the SDK threw.
 *
 * The SDK (`africastalking/lib/sms.js`) rejects in three different shapes:
 *
 *   1. an axios error on a non-2xx response  → `error.response.data`
 *   2. the raw body when the status was 2xx but not 201 → the body itself
 *   3. a local Joi validation error, before any HTTP call (invalid phone number)
 *
 * Only the provider's own message field is read — never the request echo, which
 * can contain the SMS body and the recipient number. That is why this returns a
 * short string rather than the thrown value, and why nothing here is logged.
 */
function providerFailureFromThrown(thrown: unknown): string | null {
  const error = thrown as any
  const body = error?.response?.data ?? error?.data ?? error

  const message =
    typeof body === 'string'
      ? body
      : body?.SMSMessageData?.Message ?? body?.message ?? body?.error ?? null

  const classified = classifyProviderFailure(message)
  if (classified) return classified

  // Shape 3: the SDK refused the number locally, so nothing was transmitted and
  // failing the row cannot mask a send that actually happened.
  if (!error?.response && typeof error?.message === 'string' && /valid\s*phone\s*number/i.test(error.message)) {
    return "InvalidPhoneNumber: rejected by the Africa's Talking SDK before sending"
  }

  return null
}

export async function sendSmsViaProvider(to: string, message: string, fromSenderId?: string) {
  const apiKey = process.env.AFRICASTALKING_API_KEY
  const username = process.env.AFRICASTALKING_USERNAME || 'sandbox'
  const senderId = fromSenderId || process.env.AFRICASTALKING_SENDER_ID || undefined

  // Sandbox is the SDK's default when the username is missing, and it is the
  // most misleading failure mode this integration has: Africa's Talking ACCEPTS
  // every message, answers "Success", and delivers only to numbers registered as
  // test recipients on that sandbox app. The database looks healthy, the row
  // reaches `pending`, and a real handset never rings.
  //
  // Deliberately a warning rather than a throw: a missing variable must not take
  // the whole deployment — including payments — down. Warned once per process so
  // a queue drain does not produce one line per message.
  if (process.env.NODE_ENV === 'production' && username.trim().toLowerCase() === 'sandbox' && !warnedAboutSandbox) {
    warnedAboutSandbox = true
    console.warn(
      "[Africa's Talking] AFRICASTALKING_USERNAME is unset or 'sandbox' in production. " +
        'Messages will be accepted and reported as sent but only reach numbers registered as ' +
        'sandbox test recipients. Set it to the production app username.'
    )
  }

  if (!apiKey) {
    // FAIL CLOSED in production.
    //
    // Previously this branch "simulated" a successful delivery (and returned a
    // fake providerId) whenever AFRICASTALKING_API_KEY was missing. In
    // production that meant every SMS was recorded as delivered while nothing
    // was ever sent — silent data corruption plus wasted billing records.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SMS provider is not configured: AFRICASTALKING_API_KEY is missing. Refusing to simulate delivery in production.'
      )
    }

    console.log("[SMS Simulation] (development only) Simulating SMS; content and recipient omitted")
    // Mock delivery delay for demonstration
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { success: true, providerId: 'sim_' + Math.random().toString(36).substring(2, 11) }
  }

  try {
    const atClient = africastalking({ apiKey, username })
    const formattedTo = normalizeToE164(to)
    
    console.log("[Africa's Talking] Dispatching SMS")
    
    const sendOptions: { to: string[]; message: string; from?: string } = {
      to: [formattedTo],
      message: message,
    }

    // Only attach sender ID ('from') if it's explicitly configured and not sandbox default
    if (senderId && senderId.trim() !== '' && username !== 'sandbox') {
      sendOptions.from = senderId.trim()
    }

    let result = await waitForSmsProvider<AfricaTalkingSmsResponse>(atClient.SMS.send(sendOptions))
    
    let recipientData = result.SMSMessageData?.Recipients?.[0]
    let status = recipientData?.status || ''

    // If an explicitly configured senderId was rejected as InvalidSenderId,
    // retry without 'from' so delivery can succeed via the default route.
    //
    // The condition used to include `!recipientData`, meaning ANY response
    // without a Recipients array triggered a second real send. If the first
    // send had actually succeeded and simply returned an empty array, the
    // message went out twice and was billed twice. Only an explicit
    // sender-ID rejection justifies a retry now.
    // Never trust a contradictory top-level error over an accepted recipient:
    // retrying that case can produce two paid SMS messages.
    const senderIdRejected =
      String(status).toLowerCase() === 'invalidsenderid' ||
      (!recipientData && String(result.SMSMessageData?.Message || '').toLowerCase() === 'invalidsenderid')

    if (sendOptions.from && senderIdRejected) {
      console.warn("[Africa's Talking] Sender ID rejected; retrying via default route")
      delete sendOptions.from
      result = await waitForSmsProvider<AfricaTalkingSmsResponse>(atClient.SMS.send(sendOptions))
      recipientData = result.SMSMessageData?.Recipients?.[0]
      status = recipientData?.status || ''
    }

    const isSuccess = status.toLowerCase() === 'success' || status.toLowerCase() === 'submitted' || status.toLowerCase() === 'buffered'

    if (!isSuccess) {
      // A missing/malformed status is not an explicit rejection: the request
      // might have been accepted before the response was lost or truncated.
      const explicitRejection = /^(failed|rejected|invalidsenderid|invalidphonenumber|insufficientbalance|invalidnumber|invalidphone|invalid)$/i.test(status)
      if (!explicitRejection) {
        // Account-level failure: the provider put the reason in
        // `SMSMessageData.Message` and returned no recipients at all. A *known*
        // permanent reason is a rejection; an unrecognised one stays ambiguous.
        const accountLevel = classifyProviderFailure(result.SMSMessageData?.Message)
        if (accountLevel) {
          console.warn("[Africa's Talking] Provider rejected SMS at account level")
          return {
            success: false,
            providerId: recipientData?.messageId,
            error: 'Provider rejected SMS',
            providerStatus: accountLevel,
          }
        }
        throw new Error('Provider outcome unknown')
      }
      console.warn("[Africa's Talking] Provider explicitly rejected SMS")
      // `providerStatus` carries the provider's own word (InvalidSenderId,
      // InsufficientBalance, …) to the caller so it can be persisted. Without
      // it every rejection was stored as the same opaque string and an operator
      // could not tell an expired sender ID from an empty account balance.
      return {
        success: false,
        providerId: recipientData?.messageId,
        error: 'Provider rejected SMS',
        providerStatus: status,
      }
    }


    return { 
      success: true, 
      providerId: recipientData?.messageId,
      cost: recipientData?.cost,
      status: status,
    }
  } catch (thrown) {
    // SDK/HTTP errors can echo request options (including SMS body). Never log
    // them. Only the provider's own reason field is inspected, and only to
    // decide whether this was a permanent rejection rather than a lost response.
    const rejection = providerFailureFromThrown(thrown)
    if (rejection) {
      console.warn("[Africa's Talking] Provider rejected SMS (surfaced via SDK error)")
      return {
        success: false,
        providerId: undefined,
        error: 'Provider rejected SMS',
        providerStatus: rejection,
      }
    }
    throw new Error("Provider outcome unknown")
  }
}

