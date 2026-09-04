import { NextResponse } from 'next/server'
import { smsStore } from '@/lib/sms-store'

export async function POST(request: Request) {
  try {
    let payload: Record<string, any> = {}
    const contentType = request.headers.get('content-type') || ''

    if (contentType.includes('application/json')) {
      payload = await request.json()
    } else {
      // Form URL-encoded format is default for Africa's Talking callbacks
      const text = await request.text()
      const searchParams = new URLSearchParams(text)
      for (const [key, value] of searchParams.entries()) {
        payload[key] = value
      }
    }

    const { id, status, phoneNumber, failureReason, networkCode } = payload
    console.log(`[Africa's Talking DLR] Received callback for message ${id || 'unknown'}: status=${status}, phone=${phoneNumber}, reason=${failureReason || 'none'}`)

    if (id) {
      // Find matching SMS in smsStore
      const allSms = await smsStore.getAll()
      const matchingSms = allSms.find(
        (s) => s.providerMessageId === id || (phoneNumber && s.recipient === phoneNumber && s.status !== 'delivered')
      )

      if (matchingSms) {
        const normalizedStatus = (status || '').toLowerCase()
        const isSuccess = normalizedStatus === 'success' || normalizedStatus === 'delivered'
        const newStatus = isSuccess ? 'delivered' : normalizedStatus === 'buffered' ? 'pending' : 'failed'

        await smsStore.updateStatus(
          matchingSms.id,
          newStatus,
          failureReason ? `${status}: ${failureReason} (network: ${networkCode || 'N/A'})` : undefined,
          undefined,
          id
        )
        console.log(`[Africa's Talking DLR] Updated SMS ${matchingSms.id} status to ${newStatus}`)
      }
    }

    // Africa's Talking expects a 200 OK response
    return new NextResponse('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  } catch (error: any) {
    console.error("[Africa's Talking DLR] Callback handling error:", error)
    return new NextResponse('Internal Error', { status: 200 }) // Return 200 so AT does not retry infinitely
  }
}

export async function GET() {
  return new NextResponse('Africa\'s Talking Webhook Active', { status: 200 })
}
