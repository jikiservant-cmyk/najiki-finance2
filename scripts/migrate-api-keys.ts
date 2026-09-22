/**
 * Move partner API keys out of cleartext.
 *
 * THE PROBLEM
 * -----------
 * `applications.api_key` held every partner's credential in the clear, so a
 * database dump, a backup, or the Supabase Data API (before `npm run db:harden`
 * revoked the anon role) handed over working credentials for every partner.
 *
 * WHAT THIS DOES
 * --------------
 * For every application still holding a cleartext key:
 *
 *   1. `apiKeyHash` ← SHA-256 of the key, so authentication no longer needs the
 *      plaintext
 *   2. `apiKeyHint` ← the last four characters, for the dashboard
 *   3. `webhookSecretEncrypted` ← the SAME key, encrypted with
 *      APP_ENCRYPTION_KEY
 *
 * Step 3 deliberately reuses the existing key rather than minting a new secret.
 * Partners verify outbound webhooks with an HMAC keyed on this value, and the
 * `Authorization: Bearer` header carries it too. Minting a different secret
 * here would silently break every partner's signature verification at the
 * moment of the migration. New applications get a distinct secret from the
 * setup API; this script's job is to be invisible.
 *
 * USAGE
 *   npx tsx scripts/migrate-api-keys.ts                 # backfill (safe to re-run)
 *   npx tsx scripts/migrate-api-keys.ts --dry-run       # report only
 *   npx tsx scripts/migrate-api-keys.ts --clear-plaintext
 *                                                       # ALSO null out api_key
 *
 * Run `--clear-plaintext` only after the backfill has been verified and the
 * application is deployed: it is irreversible, and any partner still
 * authenticating against the cleartext column would be locked out. Requires
 * DATABASE_URL and APP_ENCRYPTION_KEY.
 */

import { PrismaClient } from '@prisma/client'
import { encrypt } from '../src/lib/encryption'
// The real helper, not a copy: a duplicated namespace would silently produce
// hashes that authentication never matches.
import { hashApiKey } from '../src/lib/api-keys'

const prisma = new PrismaClient()

const dryRun = process.argv.includes('--dry-run')
const clearPlaintext = process.argv.includes('--clear-plaintext')

async function main() {
  const applications = await prisma.application.findMany({
    select: {
      id: true,
      code: true,
      apiKey: true,
      apiKeyHash: true,
      webhookSecretEncrypted: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`${applications.length} application(s) total.\n`)

  let backfilled = 0
  let alreadyDone = 0
  let skipped = 0
  const cleared: string[] = []

  for (const app of applications) {
    const needsHash = !app.apiKeyHash && !!app.apiKey
    const needsSecret = !app.webhookSecretEncrypted && !!app.apiKey

    if (needsHash || needsSecret) {
      console.log(
        `${dryRun ? '[dry-run] ' : ''}${app.code}: ` +
          [
            needsHash ? 'hash the API key' : null,
            needsSecret ? 'encrypt the webhook secret' : null,
          ]
            .filter(Boolean)
            .join(', ')
      )

      if (!dryRun) {
        await prisma.application.update({
          where: { id: app.id },
          data: {
            ...(needsHash
              ? {
                  apiKeyHash: hashApiKey(app.apiKey!),
                  apiKeyHint: app.apiKey!.slice(-4),
                  apiKeyRotatedAt: new Date(),
                }
              : {}),
            ...(needsSecret ? { webhookSecretEncrypted: encrypt(app.apiKey!) } : {}),
          },
        })
      }
      backfilled += 1
      continue
    }

    if (app.apiKeyHash && app.webhookSecretEncrypted) {
      alreadyDone += 1

      if (clearPlaintext && app.apiKey) {
        console.log(`${dryRun ? '[dry-run] ' : ''}${app.code}: clear the cleartext api_key`)
        if (!dryRun) {
          await prisma.application.update({
            where: { id: app.id },
            data: { apiKey: null },
          })
        }
        cleared.push(app.code)
      }
      continue
    }

    // No cleartext key and no hash — the application was never issued one.
    skipped += 1
    console.log(`${app.code}: no API key on record, skipped.`)
  }

  console.log(
    `\n${dryRun ? '[dry-run] ' : ''}Summary: ` +
      `${backfilled} backfilled, ${alreadyDone} already migrated, ${skipped} without a key` +
      (clearPlaintext ? `, ${cleared.length} cleared of cleartext.` : '.')
  )

  if (!clearPlaintext && alreadyDone > 0) {
    console.log(
      '\nEvery application is hashed, but the cleartext column is still populated.\n' +
        'Once you have confirmed authentication works, re-run with --clear-plaintext.'
    )
  }
}

main()
  .catch((error) => {
    console.error('API key migration failed:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
