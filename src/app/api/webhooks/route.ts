import { NextResponse } from 'next/server'
import { getWebhookLogsData } from '@/lib/data'

export async function GET() {
  try {
    const logs = await getWebhookLogsData(50)
    return NextResponse.json(logs)
  } catch (error) {
    console.error('Webhooks API error:', error)
    return NextResponse.json({ error: 'Failed to fetch webhook logs' }, { status: 500 })
  }
}
