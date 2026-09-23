import africastalking from 'africastalking'
import { normalizeToE164 } from '@/lib/phone'

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

    console.log(`[SMS Simulation] (development only) Sending to ${to}: "${message}"`)
    // Mock delivery delay for demonstration
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { success: true, providerId: 'sim_' + Math.random().toString(36).substring(2, 11) }
  }

  try {
    const atClient = africastalking({ apiKey, username })
    const formattedTo = normalizeToE164(to)
    
    console.log(`[Africa's Talking] Dispatching to ${formattedTo} with username: "${username}"...`)
    
    const sendOptions: { to: string[]; message: string; from?: string } = {
      to: [formattedTo],
      message: message,
    }

    // Only attach sender ID ('from') if it's explicitly configured and not sandbox default
    if (senderId && senderId.trim() !== '' && username !== 'sandbox') {
      sendOptions.from = senderId.trim()
    }

    let result = await atClient.SMS.send(sendOptions)
    console.log("[Africa's Talking] Send result:", JSON.stringify(result, null, 2))
    
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
    const senderIdRejected =
      result.SMSMessageData?.Message === 'InvalidSenderId' ||
      String(status || '').toLowerCase() === 'invalidsenderid' ||
      String(recipientData?.status || '').toLowerCase().includes('invalidsenderid')

    if (sendOptions.from && senderIdRejected) {
      console.warn(`[Africa's Talking] Sender ID "${sendOptions.from}" rejected as InvalidSenderId by telco. Retrying via default route...`)
      delete sendOptions.from
      result = await atClient.SMS.send(sendOptions)
      console.log("[Africa's Talking] Retry send result:", JSON.stringify(result, null, 2))
      recipientData = result.SMSMessageData?.Recipients?.[0]
      status = recipientData?.status || ''
    }

    const isSuccess = status.toLowerCase() === 'success' || status.toLowerCase() === 'submitted' || status.toLowerCase() === 'buffered'

    if (!isSuccess) {
      const errorMessage = recipientData?.status || result.SMSMessageData?.Message || 'SMS delivery rejected by provider'
      console.warn(`[Africa's Talking] Delivery not confirmed: ${errorMessage}`)
      return {
        success: false,
        providerId: recipientData?.messageId || 'at_msg',
        error: errorMessage,
      }
    }

    return { 
      success: true, 
      providerId: recipientData?.messageId || 'at_msg',
      cost: recipientData?.cost,
      status: status,
    }
  } catch (error: any) {
    console.error("[Africa's Talking] Exception sending SMS:", error)
    throw error 
  }
}

