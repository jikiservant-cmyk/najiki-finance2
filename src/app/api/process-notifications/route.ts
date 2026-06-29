import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function POST() {
  try {
    const pendingNotifications = await db.internalNotification.findMany({
      where: { status: { in: ['pending', 'failed_retrying'] } },
      include: { paymentIntent: { include: { application: true } }, application: true },
      orderBy: { createdAt: 'asc' },
    })
    const results: Array<{
      id: string
      status: 'delivered' | 'failed_retrying' | 'failed_exhausted'
      statusCode?: number
      error?: string
    }> = []

    for (const notification of pendingNotifications) {
      try {
        console.log(`Processing notification ${notification.id} to ${notification.url}`)

        // Send the notification
        const response = await fetch(notification.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Najiki-Notification': 'true',
          },
          body: JSON.stringify(notification.payload),
        })

        if (response.ok) {
          // Success!
          await db.internalNotification.update({
            where: { id: notification.id },
            data: {
              status: 'delivered',
              attemptCount: notification.attemptCount + 1,
              lastAttemptAt: new Date(),
              lastResponseStatus: response.status,
              nextRetryAt: null,
            },
          })
          results.push({ id: notification.id, status: 'delivered', statusCode: response.status })
        } else {
          // Failed but we might retry
          const newAttemptCount = notification.attemptCount + 1
          const shouldRetry = newAttemptCount < (notification.maxAttempts || 5)
          const newStatus = shouldRetry ? 'failed_retrying' : 'failed_exhausted'
          const nextRetryAt = shouldRetry 
            ? new Date(Date.now() + Math.pow(2, newAttemptCount) * 60000) // Exponential backoff
            : null

          await db.internalNotification.update({
            where: { id: notification.id },
            data: {
              status: newStatus,
              attemptCount: newAttemptCount,
              lastAttemptAt: new Date(),
              lastResponseStatus: response.status,
              nextRetryAt,
            },
          })
          results.push({ id: notification.id, status: newStatus, statusCode: response.status })
        }
      } catch (error) {
        // Network error or other failure
        const newAttemptCount = notification.attemptCount + 1
        const shouldRetry = newAttemptCount < (notification.maxAttempts || 5)
        const newStatus = shouldRetry ? 'failed_retrying' : 'failed_exhausted'
        const nextRetryAt = shouldRetry 
          ? new Date(Date.now() + Math.pow(2, newAttemptCount) * 60000)
          : null

        await db.internalNotification.update({
          where: { id: notification.id },
          data: {
            status: newStatus,
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            lastResponseStatus: null,
            lastResponseBody: error instanceof Error ? error.message : 'Unknown error',
            nextRetryAt,
          },
        })
        results.push({ id: notification.id, status: newStatus, error: error instanceof Error ? error.message : 'Unknown error' })
      }
    }

    return NextResponse.json({
      success: true,
      processed: pendingNotifications.length,
      results,
    })
  } catch (error) {
    console.error('Error processing notifications:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}