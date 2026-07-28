import africastalking from 'africastalking'

export async function sendSmsViaProvider(to: string, message: string) {
  const apiKey = process.env.AFRICASTALKING_API_KEY
  const username = process.env.AFRICASTALKING_USERNAME || 'sandbox'

  if (!apiKey) {
    console.log(`[SMS Simulation] Sending to ${to}: "${message}"`)
    // Mock delivery delay for demonstration
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return { success: true, providerId: 'sim_' + Math.random().toString(36).substring(2, 11) }
  }

  try {
    const atClient = africastalking({ apiKey, username })
    
    // Ensure the phone number has a + prefix (required by Africa's Talking)
    const formattedTo = to.startsWith('+') ? to : `+${to}`
    
    console.log(`[Africa's Talking] Sending to ${formattedTo}...`)
    
    const result = await atClient.SMS.send({
      to: [formattedTo],
      message: message,
    })
    console.log("[Africa's Talking] Send result:", JSON.stringify(result, null, 2))
    
    const recipientData = result.SMSMessageData?.Recipients?.[0]
    return { 
      success: recipientData?.status === 'Success' || recipientData?.status === 'Submitted', 
      providerId: recipientData?.messageId || 'at_msg' 
    }
  } catch (error) {
    console.error("[Africa's Talking] Error sending SMS:", error)
    throw error 
  }
}
