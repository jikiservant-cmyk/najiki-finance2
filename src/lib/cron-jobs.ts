/**
 * The background workers and the cadence each one needs.
 *
 * One list, three readers:
 *
 *   * `scripts/setup-cron-schedules.ts` — registers these as QStash schedules,
 *   * `scripts/webhook-preflight.ts`    — reports a missing or drifted schedule,
 *   * `tests/webhook-ops.test.ts`       — asserts the registration is correct.
 *
 * They were separate before, which is how a worker can end up registered at one
 * cadence and described at another. `vercel.json` is deliberately not the
 * source: on Vercel's Hobby plan it can only carry two *daily* jobs, so QStash
 * owns the schedule and the two `vercel.json` entries are a once-a-day backstop.
 *
 * Pure data — no imports.
 */

export type CronJob = {
  /** QStash schedule label, used in logs and in this file's tests. */
  name: string
  /** Path on this app, appended to the public origin. */
  path: string
  /** Cron expression. `* * * * *` is every minute. */
  cron: string
  /** What stops working if this is missing. */
  description: string
}

export const CRON_JOBS: CronJob[] = [
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

/** Full destination URL for a job, given the app's public origin. */
export function cronDestination(baseUrl: string, job: CronJob): string {
  return `${baseUrl.replace(/\/+$/, '')}${job.path}`
}
