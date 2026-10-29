import africastalking from 'africastalking'
import { normalizeToE164 } from '@/lib/phone'

/** The AT SDK does not configure an Axios timeout. A timed-out call is
 * ambiguous, so its SMS stays pending and is NEVER automatically resent.
 * This bounds a cron invocation without pretending to cancel provider I/O.
 */
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

export async function sendSmsViaProvider(to: string, message: string, fromSenderId?: string) {
  const apiKey = process.env.AFRICASTALKING_API_KEY
  const username = process.env.AFRICASTALKING_USERNAME || 'sandbox'
  const senderId = fromSenderId || process.env.AFRICASTALKING_SENDER_ID || undefined

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
      if (!explicitRejection) throw new Error('Provider outcome unknown')
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
  } catch {
    // SDK/HTTP errors can echo request options (including SMS body). Never log them.
    throw new Error("Provider outcome unknown")
  }
}

