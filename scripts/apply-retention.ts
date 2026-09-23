/**
 * Apply the phone-number retention policy, by hand.
 *
 * The scheduled path is `/api/cron/retention` (registered by
 * `scripts/setup-cron-schedules.ts`). This CLI exists for the two cases a
 * schedule cannot serve: a first pass over an existing backlog, and an operator
 * who wants to see what would change before it does.
 *
 * USAGE
 *   npx tsx scripts/apply-retention.ts                     # apply, configured window
 *   npx tsx scripts/apply-retention.ts --dry-run           # report only
 *   npx tsx scripts/apply-retention.ts --days 30           # override the window
 *   npx tsx scripts/apply-retention.ts --mode purge        # delete instead of mask
 *   npx tsx scripts/apply-retention.ts --batch-size 2000   # bigger single pass
 *
 * Configuration:
 *   PHONE_RETENTION_DAYS   default 90; 0 disables retention entirely
 *   PHONE_RETENTION_MODE   'mask' (default) or 'purge'
 *
 * Requires DATABASE_URL.
 */

import { applyPhoneRetention } from '../src/lib/retention-store'
import {
  describeRetentionWindow,
  isRetentionDisabled,
  resolvePhoneRetentionDays,
  resolveRetentionMode,
  type RetentionMode,
} from '../src/lib/retention'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : ''
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  const days = flag('days') ? resolvePhoneRetentionDays(flag('days')) : resolvePhoneRetentionDays()
  const modeFlag = flag('mode')
  const mode: RetentionMode = modeFlag === 'purge' ? 'purge' : modeFlag === 'mask' ? 'mask' : resolveRetentionMode()

  const batchSizeFlag = flag('batch-size')
  const batchSize = batchSizeFlag ? Number(batchSizeFlag) : 500

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    console.error('--batch-size must be a positive number')
    process.exit(1)
  }

  console.log(describeRetentionWindow(days, mode))
  console.log(dryRun ? 'Dry run — nothing will be written.\n' : '')

  if (isRetentionDisabled(days)) {
    console.log('Nothing to do.')
    return
  }

  const report = await applyPhoneRetention({ days, mode, batchSize, dryRun })

  console.log(
    [
      `${dryRun ? 'Would redact' : 'Redacted'}:`,
      `  payment intents : ${report.paymentIntentsRedacted}`,
      `  SMS messages    : ${report.smsMessagesRedacted}`,
      `  cutoff          : ${report.cutoff}`,
      `  mode            : ${report.mode}`,
    ].join('\n')
  )

  if (report.truncated) {
    console.log(
      '\nBatch limit reached — more records remain. Re-run to continue, or raise\n' +
        '--batch-size. Rows already processed are marked, so nothing is done twice.'
    )
  }

  if (dryRun) {
    console.log('\nRe-run without --dry-run to apply.')
  }
}

main().catch((error) => {
  console.error('Retention run failed:', error)
  process.exit(1)
})
