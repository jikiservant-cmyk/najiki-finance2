/**
 * Webhook preflight — read-only launch check.
 *
 * Answers the question "will the church actually receive its webhooks?" from
 * configuration alone, without sending anything and without writing anything.
 * Run it against the production environment immediately before go-live:
 *
 *     npm run webhook:preflight
 *
 * What it checks, per partner application:
 *
 *   • the webhook URL resolves to something deliverable — not the seeded
 *     `https://*.yourdomain.com` placeholder, which the SSRF guard refuses
 *     permanently (the notification is marked `failed_exhausted` and never
 *     retried),
 *   • the outbound signing secret is present and decryptable with
 *     APP_ENCRYPTION_KEY, because a null secret means unsigned notifications,
 *   • the stored path is the partner's real endpoint, and a legacy
 *     `/api/internal/payment-completed` path will need the 404 self-heal,
 *   • the inbound LivePay secret and public origin are configured, because the
 *     public origin is part of the inbound signature string,
 *   • the retry worker is scheduled often enough to recover a failed delivery.
 *
 * Exit code is 1 when anything would stop webhooks working, so this can gate a
 * deployment step. It performs no writes and no outbound requests.
 */

import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { isPlaceholderUrl } from '../src/lib/safe-fetch'
import { webhookSecretFromRow, fallbackSigningSecretsFromRow } from '../src/lib/application-auth'
import { resolvePartnerWebhookUrl } from '../src/lib/constants'
import { getAvailableProviders } from '../src/lib/providers'

const problems: string[] = []
const warnings: string[] = []

function fail(message: string) {
  problems.push(message)
}

function warn(message: string) {
  warnings.push(message)
}

function publicOrigin(): string | null {
  const raw = (process.env.NEXTAUTH_URL || process.env.PUBLIC_BASE_URL || '').trim()
  if (!raw) return null
  return raw.replace(/\/+$/, '')
}

async function checkEnvironment() {
  console.log('\n— Inbound (LivePay → this gateway) —')

  const origin = publicOrigin()
  if (!origin) {
    fail('NEXTAUTH_URL is not set: the public origin is part of the signature string, so every LivePay webhook will fail verification.')
  } else if (!origin.startsWith('https://')) {
    fail(`The public origin "${origin}" is not HTTPS. LivePay signs "https" URLs; set NEXTAUTH_URL to the https origin.`)
  } else {
    console.log(`  ✓ public origin            ${origin}`)
    console.log(`    LivePay callback URL     ${origin}/api/webhooks/livepay`)
  }

  const livePaySecret = (process.env.LIVEPAY_WEBHOOK_SECRET || '').trim()
  if (!livePaySecret) {
    fail('LIVEPAY_WEBHOOK_SECRET is not set: inbound verification fails closed, so no LivePay webhook can ever settle.')
  } else if (livePaySecret.length < 16) {
    fail('LIVEPAY_WEBHOOK_SECRET is shorter than 16 characters: the verifier rejects it (fail-closed) and boot refuses in production.')
  } else {
    console.log(`  ✓ LIVEPAY_WEBHOOK_SECRET   set (${livePaySecret.length} chars)`)
  }

  const atSecret = (process.env.AFRICASTALKING_CALLBACK_SECRET || '').trim()
  const atIps = (process.env.AFRICASTALKING_ALLOWED_IPS || '').trim()
  if (!atSecret && !atIps) {
    fail("Neither AFRICASTALKING_CALLBACK_SECRET nor AFRICASTALKING_ALLOWED_IPS is set: delivery reports are refused (fail-closed).")
  } else {
    const callbackUrl = origin
      ? `${origin}/api/webhooks/africastalking${atSecret ? '?key=<AFRICASTALKING_CALLBACK_SECRET>' : ''}`
      : '/api/webhooks/africastalking'
    console.log(`  ✓ Africa's Talking DLR     ${atSecret ? 'secret configured' : 'IP allow-list only'}`)
    console.log(`    callback URL             ${callbackUrl}`)
    if (atSecret && !atIps) {
      warn('AFRICASTALKING_ALLOWED_IPS is not set: a leaked callback URL (which contains the secret) is sufficient on its own.')
    }
  }

  const encryptionKey = (process.env.APP_ENCRYPTION_KEY || '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    fail('APP_ENCRYPTION_KEY is missing or not 64 hex characters: partner webhook secrets cannot be decrypted, so notifications would be unsigned.')
  } else {
    console.log('  ✓ APP_ENCRYPTION_KEY       set')
  }
}

async function checkApplications(db: PrismaClient) {
  console.log('\n— Outbound (this gateway → partner apps) —')

  const applications = await db.application.findMany({
    where: { isActive: true },
    orderBy: { code: 'asc' },
  })

  if (applications.length === 0) {
    fail('No active partner applications — nothing will be notified.')
    return
  }

  for (const application of applications) {
    const url = resolvePartnerWebhookUrl(application)
    const primary = webhookSecretFromRow(application)
    const fallbacks = fallbackSigningSecretsFromRow(application)

    const label = `${application.code} (${application.name})`
    console.log(`\n  ${label}`)
    console.log(`    delivery URL             ${url}`)

    if (!application.baseUrl?.trim()) {
      fail(`${label}: baseUrl is empty — the delivery URL is unusable.`)
    } else if (isPlaceholderUrl(application.baseUrl)) {
      fail(
        `${label}: baseUrl "${application.baseUrl}" is a placeholder domain. The SSRF guard refuses it permanently, so no webhook is ever delivered (status failed_exhausted, no retry). Set the real host in /setup.`
      )
    } else if (application.baseUrl.startsWith('http://')) {
      warn(`${label}: baseUrl is plain HTTP — the payload and its signature travel unencrypted.`)
    }

    if (/\/api\/internal\/payment-completed\/?$/i.test(url)) {
      warn(
        `${label}: still points at the legacy /api/internal/payment-completed path. It works only if that path answers 404/405 so the self-heal can redirect to /api/webhooks/najiki; set webhookPath to /api/webhooks/najiki explicitly.`
      )
    }

    if (!primary) {
      fail(`${label}: no webhook secret could be resolved (webhookSecretEncrypted unreadable). Notifications would go out unsigned.`)
    } else {
      console.log(`    signing secret           present (${primary.length} chars)`)
    }

    if (fallbacks.length === 0) {
      warn(`${label}: no fallback signing secret — a partner verifying with its API key gets no retry.`)
    } else {
      console.log(`    fallback secrets         ${fallbacks.length}`)
    }

    const endpoint = url.replace(/^https?:\/\//, '')
    console.log(`    partner must allow       POST ${endpoint}  (X-Najiki-Timestamp, X-Najiki-Signature)`)

    const pending = await db.internalNotification.count({
      where: {
        applicationId: application.id,
        status: { in: ['pending', 'failed_retrying'] },
      },
    })
    const exhausted = await db.internalNotification.count({
      where: { applicationId: application.id, status: 'failed_exhausted' },
    })

    if (pending > 0) console.log(`    in-flight notifications  ${pending}`)
    if (exhausted > 0) {
      warn(`${label}: ${exhausted} notification(s) are failed_exhausted — they will never be retried. Inspect /webhooks.`)
    }
  }
}

async function checkProviders(db: PrismaClient) {
  console.log('\n— Providers —')
  const implemented = getAvailableProviders()
  const providers = await db.provider.findMany({ where: { isActive: true } })

  for (const provider of providers) {
    const implementedFlag = implemented.includes(provider.code.toLowerCase())
    console.log(
      `  ${implementedFlag ? '✓' : '·'} ${provider.code.padEnd(10)} ${implementedFlag ? 'active adapter' : 'row only — no adapter, cannot be used for payments'}`
    )
  }

  const livePay = providers.find((provider) => provider.code.toLowerCase() === 'livepay')
  if (!livePay) fail('No active livepay provider row: inbound webhooks resolve to 404 "Provider not active".')
}

async function checkRetrySchedule() {
  console.log('\n— Retry worker —')
  try {
    const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
    const cron = (vercel.crons ?? []).find((entry: any) => entry.path === '/api/cron/notifications')
    if (!cron) {
      fail('/api/cron/notifications is not scheduled: a failed delivery is never retried.')
      return
    }
    console.log(`  schedule: ${cron.schedule}`)
    if (cron.schedule !== '* * * * *') {
      warn(
        `The retry worker runs "${cron.schedule}", not every minute. Backoff is designed around minute-level retries, so a transient partner outage is recovered late (not lost).`
      )
    }
  } catch {
    warn('Could not read vercel.json to confirm the retry schedule.')
  }

  if (!(process.env.CRON_SECRET || '').trim()) {
    fail('CRON_SECRET is not set: the retry worker cannot be called.')
  }
}

async function main() {
  console.log('================================================================')
  console.log(" Na'jiki Finance — webhook preflight (read-only)")
  console.log('================================================================')

  await checkEnvironment()
  await checkRetrySchedule()

  const db = new PrismaClient()
  try {
    await checkApplications(db)
    await checkProviders(db)
  } finally {
    await db.$disconnect()
  }

  console.log('\n================================================================')
  if (problems.length > 0) {
    console.log(` BLOCKERS (${problems.length}) — webhooks will not work as configured:`)
    for (const problem of problems) console.log(`   ✗ ${problem}`)
  }
  if (warnings.length > 0) {
    console.log(`\n WARNINGS (${warnings.length}) — will work, but know about it:`)
    for (const warning of warnings) console.log(`   ! ${warning}`)
  }
  if (problems.length === 0 && warnings.length === 0) {
    console.log(' All checks passed.')
  }
  console.log('================================================================\n')

  process.exitCode = problems.length > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('\nPreflight failed to run:', error)
  process.exitCode = 1
})
