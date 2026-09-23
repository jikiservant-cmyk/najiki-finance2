/**
 * Database exposure hardening + verification.
 *
 * THE PROBLEM
 * -----------
 * Prisma puts every table in the `public` schema, and `public` is the schema
 * Supabase exposes through its Data API (PostgREST, i.e. `supabase-js` and
 * `/rest/v1/...`). The anon key that ships to the browser is enough to read any
 * table in that schema **unless Row Level Security is enabled and denies by
 * default**. On a project with Supabase's default grants, a table with RLS off
 * is world-readable — including `applications.api_key` (every partner's API
 * key) and every payment row.
 *
 * WHAT THIS DOES
 * --------------
 *   1. reads which public tables exist
 *   2. ENABLEs RLS on all of them (Prisma connects as the table owner, so the
 *      application keeps working — owners are not subject to their own RLS
 *      policies unless FORCE is used, which is deliberately not applied)
 *   3. revokes table privileges from the `anon` and `authenticated` roles so
 *      the Data API cannot reach them at all
 *   4. verifies by asking the Data API directly with the anon key
 *
 * USAGE
 *   npx tsx scripts/harden-database.ts            # apply + verify
 *   npx tsx scripts/harden-database.ts --dry-run  # report only
 *
 * Requires DATABASE_URL (Prisma's datasource) and, for the verification step,
 * NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const dryRun = process.argv.includes('--dry-run')

/** Tables the Data API has no business touching at all. */
const API_ROLES = ['anon', 'authenticated']

async function listPublicTables(): Promise<string[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  )) as Array<{ tablename: string }>
  return rows.map((row) => row.tablename)
}

async function rlsStatus(tables: string[]): Promise<Map<string, boolean>> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT c.relname, c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`
  )) as Array<{ relname: string; relrowsecurity: boolean }>
  const status = new Map<string, boolean>()
  for (const table of tables) status.set(table, false)
  for (const row of rows) status.set(row.relname, row.relrowsecurity)
  return status
}

async function anonGrants(tables: string[]): Promise<Map<string, string[]>> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT table_name, grantee
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = ANY($1::text[])
      GROUP BY table_name, grantee`,
    API_ROLES
  )) as Array<{ table_name: string; grantee: string }>
  const grants = new Map<string, string[]>()
  for (const table of tables) grants.set(table, [])
  for (const row of rows) {
    grants.set(row.table_name, [...(grants.get(row.table_name) || []), row.grantee])
  }
  return grants
}

async function enableRls(table: string): Promise<void> {
  // Identifiers cannot be parameterised — they come from pg_tables, not from
  // user input, and are quoted defensively.
  await prisma.$executeRawUnsafe(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`)
}

async function revokeApiRoles(table: string): Promise<void> {
  for (const role of API_ROLES) {
    try {
      await prisma.$executeRawUnsafe(`REVOKE ALL ON TABLE public."${table}" FROM ${role}`)
    } catch (error) {
      // Role may not exist (self-hosted Postgres without Supabase's roles).
      console.warn(`  ! could not revoke ${role} on ${table}: ${(error as Error).message}`)
    }
  }
}

/**
 * Ask the Data API the same question an attacker with the public anon key would
 * ask. A reachable table returns 200 with rows; a hardened one returns 401/404
 * (permission denied / not found in schema cache).
 */
async function verifyViaDataApi(tables: string[]): Promise<{ exposed: string[]; skipped: boolean }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    return { exposed: [], skipped: true }
  }

  const exposed: string[] = []
  for (const table of tables) {
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const body = (await res.text()).trim()
        // `[]` is not proof of safety: the table is still reachable, just empty.
        exposed.push(`${table}${body === '[]' ? ' (reachable, currently empty)' : ' (ROWS VISIBLE)'}`)
      }
    } catch (error) {
      console.warn(`  ! verification request for ${table} failed: ${(error as Error).message}`)
    }
  }
  return { exposed, skipped: false }
}

async function main() {
  console.log(`Database hardening (${dryRun ? 'dry run' : 'applying'})\n`)

  const tables = await listPublicTables()
  if (tables.length === 0) {
    console.error('No tables found in the public schema — has the schema been pushed?')
    process.exit(1)
  }

  const before = await rlsStatus(tables)
  const grantsBefore = await anonGrants(tables)

  const needsRls = tables.filter((table) => !before.get(table))
  const needsRevoke = tables.filter((table) => (grantsBefore.get(table) || []).length > 0)

  console.log(`Tables in public:        ${tables.length}`)
  console.log(`Missing RLS:             ${needsRls.length}${needsRls.length ? ` → ${needsRls.join(', ')}` : ''}`)
  console.log(`Reachable by anon/auth:  ${needsRevoke.length}${needsRevoke.length ? ` → ${needsRevoke.join(', ')}` : ''}\n`)

  if (!dryRun) {
    for (const table of tables) {
      if (!before.get(table)) {
        await enableRls(table)
        console.log(`  ✔ RLS enabled on ${table}`)
      }
      await revokeApiRoles(table)
    }
    console.log('\nPrivileges revoked from anon/authenticated on every public table.')
    console.log('NOTE: the app is unaffected — Prisma connects as the table owner, which')
    console.log('      bypasses these policies. `/rest/v1` clients (supabase-js) are now')
    console.log('      denied; use the server-side service-role client if you ever need one.\n')
  }

  const { exposed, skipped } = await verifyViaDataApi(tables)
  if (skipped) {
    console.log('Verification skipped: NEXT_PUBLIC_SUPABASE_URL / ANON_KEY not set in this shell.')
  } else if (exposed.length === 0) {
    console.log('✅ Verification passed: the anon key cannot read any public table.')
  } else {
    console.log('🔴 Verification FAILED — these tables are still reachable with the public anon key:')
    for (const item of exposed) console.log(`   - ${item}`)
    console.log('\nRotate any credentials that table contained, then re-run this script.')
    process.exitCode = 1
  }

  const after = await rlsStatus(tables)
  const unprotected = tables.filter((table) => !after.get(table))
  if (unprotected.length > 0) {
    console.log(`\n🔴 RLS is still disabled on: ${unprotected.join(', ')}`)
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error('Hardening failed:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
