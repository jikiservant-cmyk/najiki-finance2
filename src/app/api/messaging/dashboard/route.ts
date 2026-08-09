import { NextResponse } from 'next/server'
import { smsStore } from '@/lib/sms-store'
import { db } from '@/lib/db'

export async function GET(request: Request) {
  try {
    const messages = await smsStore.getAll()
    const apps = await db.application.findMany()
    const appMap = new Map(apps.map(a => [a.code.toLowerCase(), a.name]))

    const totalSent = messages.length
    const totalCost = messages.filter(m => m.status === 'delivered').reduce((sum, m) => sum + m.cost, 0)

    const statusCounts = {
      delivered: messages.filter(m => m.status === 'delivered').length,
      pending: messages.filter(m => m.status === 'pending').length,
      failed: messages.filter(m => m.status === 'failed').length,
      queued: messages.filter(m => m.status === 'queued').length,
    }

    const deliveryRate = totalSent > 0
      ? ((statusCounts.delivered / totalSent) * 100).toFixed(1)
      : '0'

    // Group by application
    const appUsageMap = new Map<string, { count: number; cost: number }>()
    for (const m of messages) {
      const code = m.applicationCode.toLowerCase()
      const existing = appUsageMap.get(code) || { count: 0, cost: 0 }
      appUsageMap.set(code, {
        count: existing.count + 1,
        cost: existing.cost + (m.status === 'delivered' ? m.cost : 0),
      })
    }

    const appUsage = Array.from(appUsageMap.entries()).map(([code, stats]) => ({
      code,
      name: appMap.get(code) || code.toUpperCase(),
      count: stats.count,
      cost: stats.cost,
    }))

    // Group by provider
    const providerUsageMap = new Map<string, { count: number; cost: number }>()
    for (const m of messages) {
      const code = m.providerCode.toLowerCase()
      const existing = providerUsageMap.get(code) || { count: 0, cost: 0 }
      providerUsageMap.set(code, {
        count: existing.count + 1,
        cost: existing.cost + (m.status === 'delivered' ? m.cost : 0),
      })
    }

    const providerUsage = Array.from(providerUsageMap.entries()).map(([code, stats]) => ({
      code,
      name: code === 'africastalking' ? "Africa's Talking" : code.toUpperCase(),
      count: stats.count,
      cost: stats.cost,
    }))

    // Group by daily volume (last 14 days)
    const dailyVolumeMap = new Map<string, { volume: number; failed: number }>()
    const now = new Date()
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(now.getDate() - i)
      const dateStr = d.toISOString().split('T')[0]
      dailyVolumeMap.set(dateStr, { volume: 0, failed: 0 })
    }

    for (const m of messages) {
      const dateStr = m.createdAt.split('T')[0]
      if (dailyVolumeMap.has(dateStr)) {
        const stats = dailyVolumeMap.get(dateStr)!
        stats.volume += 1
        if (m.status === 'failed') {
          stats.failed += 1
        }
      }
    }

    const dailyVolume = Array.from(dailyVolumeMap.entries()).map(([date, stats]) => ({
      date,
      volume: stats.volume,
      failed: stats.failed,
    }))

    // Recent messages
    const recentMessages = messages.slice(0, 15).map(m => ({
      id: m.id,
      reference: m.reference,
      application: appMap.get(m.applicationCode.toLowerCase()) || m.applicationCode.toUpperCase(),
      applicationCode: m.applicationCode,
      recipient: m.recipient,
      status: m.status,
      providerCode: m.providerCode === 'africastalking' ? "Africa's Talking" : m.providerCode.toUpperCase(),
      createdAt: m.createdAt,
      cost: m.status === 'delivered' ? m.cost : 0,
    }))

    return NextResponse.json({
      totalSent,
      totalCost,
      statusCounts,
      deliveryRate,
      appUsage,
      providerUsage,
      dailyVolume,
      recentMessages,
    })
  } catch (error) {
    console.error('Messaging dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
