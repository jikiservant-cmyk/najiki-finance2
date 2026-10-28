/**
 * Register (or verify) the background workers as Upstash QStash schedules.
 *
 * WHY QSTASH AND NOT vercel.json
 * ------------------------------
 * `vercel.json` can only carry a *daily* cadence on Vercel's Hobby plan — a
 * sub-daily cron expression makes the whole deployment fail. Every worker here
 * needs minute granularity:
 *
 *   /api/cron/sync-payments     every 2 minutes — reconcile pending payments
 *   /api/cron/notifications     every minute    — retry undelivered webhooks
 *   /api/qstash/sms-cron        every minute    — drain the SMS queue
 *   /api/cron/alerts            every 15 min    — stuck payments / exhausted webhooks
 *   /api/cron/retention         daily 03:00     — mask phone numbers past retention
 *
 * So QStash owns the schedule and the two `vercel.json` entries are only a
 * once-a-day backstop. Requests arrive with `Upstash-Signature`, which
 * `verifyCronRequest()` checks — no shared secret travels over the wire.
 *
 * USAGE
 *   QSTASH_TOKEN=... PUBLIC_BASE_URL=https://payments.example.com \
 *     npx tsx scripts/setup-cron-schedules.ts            # create or repair
 *   ... --dry-run                                        # show what would change
 *   ... --verify                                         # report drift, change nothing
 *
 * `--verify` exits non-zero when a worker is missing, paused, pointing at the
 * wrong destination, carrying the wrong cron expression, or duplicated. It is
 * the check to run before go-live and after any deploy that changes a path.
 *
 * REPAIR IS IN-PLACE
 * ------------------
 * QStash accepts a `scheduleId` on create, which updates that schedule. The
 * previous version deleted first and created second, so a failure or a network
 * blip between the two left the worker with **no schedule at all** — silently,
 * because the script only printed what it did. Updating by id has no gap.
 *
 * Leftover duplicates for the same destination are removed last, after the
 * canonical schedule exists, so a cleanup can never be the reason a worker stops.
 */

import { Client } from '@upstash/qstash'
import { CRON_JOBS, cronDestination, type CronJob } from '../src/lib/cron-jobs'

/** The schedule list lives in src/lib/cron-jobs.ts — one source of truth for
 * the registrar, the preflight check and the tests. */
const JOBS: CronJob[] = CRON_JOBS

function resolveBaseUrl(): string {
  const raw = (process.env.PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || '').trim().replace(/\/+$/, '')
  if (!raw || !/^https?:\/\//.test(raw)) {
    console.error('PUBLIC_BASE_URL (or NEXTAUTH_URL) must be set to the public https origin of this app')
    process.exit(1)
  }
  if (!raw.startsWith('https://')) {
    // QStash will happily call http://, but request bodies here carry signed
    // webhook payloads and the signature travels in a header.
    console.warn(`[warn] ${raw} is not HTTPS — the worker endpoints and their signatures travel in clear text`)
  }
  return raw
}

async function main() {
  const token = process.env.QSTASH_TOKEN
  if (!token) {
    console.error('QSTASH_TOKEN is required')
    process.exit(1)
  }

  const baseUrl = resolveBaseUrl()
  const dryRun = process.argv.includes('--dry-run')
  const verifyOnly = process.argv.includes('--verify')
  const client = new Client({ token })

  // One listing, grouped by destination, so duplicates are visible.
  const existing = await client.schedules.list()
  const byDestination = new Map<string, Awaited<ReturnType<typeof client.schedules.list>>>()
  for (const schedule of existing) {
    const group = byDestination.get(schedule.destination) ?? []
    group.push(schedule)
    byDestination.set(schedule.destination, group)
  }

  const problems: string[] = []
  const actions: string[] = []

  for (const job of JOBS) {
    const destination = cronDestination(baseUrl, job)
    const found = byDestination.get(destination) ?? []
    const keep = found[0]
    const duplicates = found.slice(1)
    const label = `${job.name} → ${destination}`

    if (duplicates.length > 0) {
      problems.push(`${job.name}: ${duplicates.length} duplicate schedule(s) for this destination`)
    }

    if (!keep) {
      problems.push(`${job.name}: NO SCHEDULE for ${destination} — this worker never runs`)
      if (verifyOnly) continue
      if (dryRun) {
        actions.push(`would create ${label} (${job.cron})`)
        continue
      }
      const { scheduleId } = await client.schedules.create({
        destination,
        cron: job.cron,
        body: JSON.stringify({ source: 'qstash-schedule', job: job.name }),
        headers: { 'Content-Type': 'application/json' },
        retries: 2,
      })
      actions.push(`created ${label} (${job.cron}) id=${scheduleId} — ${job.description}`)
    } else {
      const drift: string[] = []
      if (keep.cron !== job.cron) drift.push(`cron ${keep.cron} → ${job.cron}`)
      if (keep.method && keep.method.toUpperCase() !== 'POST') drift.push(`method ${keep.method} → POST`)
      if (keep.isPaused) drift.push('resumed (was paused)')

      if (keep.isPaused) {
        problems.push(`${job.name}: schedule is PAUSED — this worker is not running`)
      }
      if (keep.cron !== job.cron) {
        problems.push(`${job.name}: cron is "${keep.cron}", expected "${job.cron}"`)
      }

      if (verifyOnly) {
        if (drift.length === 0 && duplicates.length === 0) {
          actions.push(`ok ${label} (${keep.cron}) id=${keep.scheduleId}`)
        }
        continue
      }

      if (dryRun) {
        actions.push(
          drift.length === 0
            ? `would leave ${label} (${keep.cron}) unchanged`
            : `would update ${label}: ${drift.join(', ')}`
        )
        continue
      }

      if (drift.length > 0) {
        // Update in place by id. Deleting first — what this script used to do —
        // leaves a window with no schedule, and a failure in that window is
        // invisible: the worker simply stops and nothing says so.
        await client.schedules.create({
          scheduleId: keep.scheduleId,
          destination,
          cron: job.cron,
          method: 'POST',
          body: JSON.stringify({ source: 'qstash-schedule', job: job.name }),
          headers: { 'Content-Type': 'application/json' },
          retries: 2,
        })
        actions.push(`updated ${label}: ${drift.join(', ')}`)
      } else {
        actions.push(`ok ${label} (${keep.cron}) id=${keep.scheduleId}`)
      }
    }

    // Duplicates are removed only after the canonical schedule is in place.
    if (!verifyOnly && !dryRun) {
      for (const duplicate of duplicates) {
        await client.schedules.delete(duplicate.scheduleId)
        actions.push(`deleted duplicate schedule ${duplicate.scheduleId} for ${destination}`)
      }
    }
  }

  // Schedules pointing at a destination this script does not own are reported,
  // not deleted: another deployment (staging, a renamed host) may own them, and
  // guessing would be destructive.
  const managed = new Set(JOBS.map((job) => cronDestination(baseUrl, job)))
  for (const schedule of existing) {
    if (!managed.has(schedule.destination)) {
      actions.push(
        `note: unmanaged schedule ${schedule.scheduleId} → ${schedule.destination} (${schedule.cron})`
      )
    }
  }

  for (const action of actions) console.log(`[cron] ${action}`)

  if (problems.length > 0) {
    console.log('')
    for (const problem of problems) console.error(`[problem] ${problem}`)
    console.log('')
    if (verifyOnly) {
      console.error(
        'Verification failed. Run without --verify to create or repair the schedules above.'
      )
      process.exit(1)
    }
    // Repair mode does not fail on drift it just fixed, but a missing schedule
    // that could not be created would have thrown by now.
    console.log('Repaired. Re-run with --verify to confirm.')
    return
  }

  if (verifyOnly) {
    console.log('\nAll schedules present and correct.')
  } else {
    console.log('\nDone. Verify with: npx tsx scripts/setup-cron-schedules.ts --verify')
  }
}

main().catch((error) => {
  console.error('Failed to configure cron schedules:', error)
  process.exit(1)
})
