/**
 * Register the background workers as Upstash QStash schedules.
 *
 * WHY THIS EXISTS
 * ---------------
 * `vercel.json` can only carry two jobs at a *daily* cadence on Vercel's Hobby
 * plan — a sub-daily cron expression makes the whole deployment fail. Every
 * worker here is needed at minute granularity:
 *
 *   /api/cron/sync-payments     every 2 minutes — reconcile pending payments
 *   /api/cron/notifications     every minute   — retry undelivered webhooks
 *   /api/qstash/sms-cron        every minute   — drain the SMS queue
 *   /api/cron/alerts            every 15 min   — stuck payments / exhausted webhooks
 *   /api/cron/retention         daily at 03:00 — mask phone numbers past retention
 *
 * QStash is already a dependency (it delivers partner webhooks), so scheduling
 * through it works on any hosting plan and keeps everything in one dashboard.
 * Requests arrive with `Upstash-Signature`, which `verifyCronRequest()` checks —
 * no shared secret has to travel over the wire.
 *
 * USAGE
 *   QSTASH_TOKEN=... PUBLIC_BASE_URL=https://payments.example.com \
 *     npx tsx scripts/setup-cron-schedules.ts [--dry-run]
 */

import { Client } from '@upstash/qstash'

type Job = { name: string; path: string; cron: string; description: string }

const JOBS: Job[] = [
  {
    name: 'najiki-sync-payments',
    path: '/api/cron/sync-payments',
    cron: '*/2 * * * *',
    description: 'Reconcile payments stuck in pending/processing',
  },
  {
    name: 'najiki-notifications',
    path: '/api/cron/notifications',
    cron: '* * * * *',
    description: 'Retry undelivered partner webhooks with backoff',
  },
  {
    name: 'najiki-sms-cron',
    path: '/api/qstash/sms-cron',
    cron: '* * * * *',
    description: 'Drain the SMS queue',
  },
  {
    name: 'najiki-alerts',
    path: '/api/cron/alerts',
    cron: '*/15 * * * *',
    description: 'Operational alerting (stuck payments, exhausted webhooks, SMS backlog, ledger drift)',
  },
  {
    name: 'najiki-retention',
    path: '/api/cron/retention',
    cron: '0 3 * * *',
    description: 'Mask or purge customer phone numbers past the retention window',
  },
]

async function main() {
  const token = process.env.QSTASH_TOKEN
  const baseUrl = (process.env.PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || '').replace(/\/+$/, '')
  const dryRun = process.argv.includes('--dry-run')

  if (!token) {
    console.error('QSTASH_TOKEN is required')
    process.exit(1)
  }
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    console.error('PUBLIC_BASE_URL (or NEXTAUTH_URL) must be set to the public https origin of this app')
    process.exit(1)
  }

  const client = new Client({ token })

  const existing = await client.schedules.list()
  const byDestination = new Map(existing.map((schedule) => [schedule.destination, schedule]))

  for (const job of JOBS) {
    const destination = `${baseUrl}${job.path}`
    const found = byDestination.get(destination)

    if (dryRun) {
      console.log(`[dry-run] ${found ? 'would update' : 'would create'} ${job.name} → ${destination} (${job.cron})`)
      continue
    }

    if (found) {
      // QStash has no in-place update for the cron expression: replace it.
      await client.schedules.delete(found.scheduleId)
      console.log(`[cron] replaced ${job.name} (was ${found.cron})`)
    }

    const { scheduleId } = await client.schedules.create({
      destination,
      cron: job.cron,
      // A tiny body keeps the (unused) payload non-empty so verification has
      // something to hash; the signature covers the body either way.
      body: JSON.stringify({ source: 'qstash-schedule', job: job.name }),
      headers: { 'Content-Type': 'application/json' },
      retries: 2,
    })

    console.log(`[cron] ${job.name} → ${destination} (${job.cron}) id=${scheduleId} — ${job.description}`)
  }

  console.log('\nDone. Verify with: npx tsx scripts/setup-cron-schedules.ts --dry-run')
}

main().catch((error) => {
  console.error('Failed to configure cron schedules:', error)
  process.exit(1)
})
