/**
 * Database & Supabase Connectivity Checker
 *
 * Verifies that:
 * 1. DATABASE_URL is set and has correct parameters (e.g. ?pgbouncer=true for Supabase pooler on port 6543)
 * 2. Prisma can connect to PostgreSQL and execute queries
 * 3. Core tables exist in the public schema
 * 4. Supabase Auth configuration (NEXT_PUBLIC_SUPABASE_URL and ANON_KEY) is valid and reachable
 *
 * Usage:
 *   npm run db:check
 *   npx tsx scripts/check-db.ts
 */

import { PrismaClient } from '@prisma/client'
import { isSupabaseConfigured, inspectDatabaseUrl } from '../src/lib/supabase-config'

async function checkConnectivity() {
  console.log('================================================================')
  console.log(" Na'jiki Finance — Database (Prisma) & Supabase Connection Check")
  console.log('================================================================\n')

  const databaseUrl = process.env.DATABASE_URL
  const directUrl = process.env.DIRECT_URL
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  let hasErrors = false

  // 1. Inspect DATABASE_URL
  console.log('1. Checking DATABASE_URL...')
  const dbInspect = inspectDatabaseUrl(databaseUrl)
  if (!dbInspect.configured) {
    console.error('   ❌ DATABASE_URL is not configured.')
    console.error('      Add DATABASE_URL to your .env file with your Supabase PostgreSQL connection string.')
    hasErrors = true
  } else {
    console.log('   ✔ DATABASE_URL is present.')
    if (dbInspect.warning) {
      console.warn(`   ⚠️ ${dbInspect.warning}`)
    } else if (dbInspect.isSupabasePooler && dbInspect.hasPgbouncer) {
      console.log('   ✔ Supabase pooler detected with required ?pgbouncer=true parameter.')
    }
  }

  // 2. Inspect DIRECT_URL
  console.log('\n2. Checking DIRECT_URL (for migrations)...')
  if (!directUrl) {
    console.warn('   ⚠️ DIRECT_URL is not set. A direct connection on port 5432 is recommended for Prisma migrations.')
  } else {
    console.log('   ✔ DIRECT_URL is configured.')
  }

  // 3. Test Prisma Database Connection
  console.log('\n3. Testing Prisma PostgreSQL connection...')
  if (!databaseUrl) {
    console.log('   ⏭ Skipped database ping: DATABASE_URL not set.')
  } else {
    let prisma: PrismaClient | null = null
    try {
      prisma = new PrismaClient({ log: ['error'] })
    } catch (clientErr: any) {
      console.error('   ❌ Failed to initialize Prisma Client:')
      console.error(`      ${clientErr?.message || clientErr}`)
      console.log('      Run `npx prisma generate` to generate the client.')
      hasErrors = true
    }

    if (prisma) {
      try {
        const pingResult = await prisma.$queryRawUnsafe<Array<{ db: string; usr: string; ver: string }>>(
          'SELECT current_database() as db, current_user as usr, version() as ver'
        )
        console.log('   ✅ Prisma connected to PostgreSQL successfully!')
        if (pingResult && pingResult[0]) {
          console.log(`      Database: ${pingResult[0].db}`)
          console.log(`      User:     ${pingResult[0].usr}`)
          console.log(`      Version:  ${pingResult[0].ver.slice(0, 50)}...`)
        }

        // Check for core tables
        const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
        )
        console.log(`      Tables in public schema: ${tables.length}`)
        const required = ['applications', 'providers', 'tenants', 'payment_intents', 'admin_profiles']
        const existing = new Set(tables.map((t) => t.tablename))
        const missing = required.filter((r) => !existing.has(r))

        if (missing.length > 0) {
          console.warn(`   ⚠️ Missing tables: ${missing.join(', ')}`)
          console.warn('      Run `npx prisma db push` or `npx prisma migrate deploy` to create them.')
        } else {
          console.log('   ✔ Core application tables exist.')
        }
      } catch (err: any) {
        console.error('   ❌ Prisma database query failed:')
        console.error(`      ${err?.message || err}`)
        console.log('\n   Troubleshooting checklist for Supabase:')
        console.log('   - Has the Supabase project been paused? Check https://supabase.com/dashboard.')
        console.log('   - Is the database password correct?')
        console.log('   - If connecting to port 6543, did you append ?pgbouncer=true?')
        console.log('   - Are IPv4/IPv6 connections allowed by your network?')
        hasErrors = true
      } finally {
        await prisma.$disconnect().catch(() => {})
      }
    }
  }

  // 4. Test Supabase Auth configuration
  console.log('\n4. Checking Supabase Auth...')
  const authConfigured = isSupabaseConfigured(supabaseUrl, supabaseAnonKey)
  if (!authConfigured) {
    console.warn('   ⚠️ Supabase Auth is NOT configured (missing or placeholder NEXT_PUBLIC_SUPABASE_URL / ANON_KEY).')
    console.warn('      Dashboard login at /login will report that Supabase Auth is not configured.')
    console.warn('      In development mode, dashboard access bypass is available without auth.')
  } else {
    console.log(`   ✔ Supabase URL: ${supabaseUrl}`)
    console.log('   ✔ Supabase Anon Key: configured')

    try {
      const healthUrl = `${supabaseUrl!.replace(/\/+$/, '')}/auth/v1/health`
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        console.log('   ✅ Supabase Auth service is reachable and responding!')
      } else {
        console.warn(`   ⚠️ Supabase Auth endpoint responded with HTTP ${res.status}: ${res.statusText}`)
      }
    } catch (err: any) {
      console.error(`   ❌ Failed to reach Supabase Auth at ${supabaseUrl}:`)
      console.error(`      ${err?.message || err}`)
      console.log('      This will cause "Failed to fetch" on the login page.')
      console.log('      Verify the project URL and that the Supabase instance is active.')
      hasErrors = true
    }
  }

  console.log('\n================================================================')
  if (hasErrors) {
    console.log(' 🔴 Check completed with issues — see details above.')
    process.exit(1)
  } else {
    console.log(' 🟢 All checks passed successfully!')
    process.exit(0)
  }
}

checkConnectivity().catch((e) => {
  console.error('Fatal check error:', e)
  process.exit(1)
})
