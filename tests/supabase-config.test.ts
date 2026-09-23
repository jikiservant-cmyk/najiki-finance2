/**
 * Tests for Supabase Auth and Database connection inspection helpers.
 *
 * Runs on Node's built-in test runner with type stripping:
 *   npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isSupabaseConfigured,
  inspectDatabaseUrl,
  getFriendlyAuthErrorMessage,
} from '../src/lib/supabase-config.ts'

// ─── isSupabaseConfigured ────────────────────────────────────────────────────

test('rejects undefined or empty values', () => {
  assert.equal(isSupabaseConfigured(undefined, undefined), false)
  assert.equal(isSupabaseConfigured('', ''), false)
  assert.equal(isSupabaseConfigured('https://test.supabase.co', ''), false)
  assert.equal(isSupabaseConfigured('', 'some-key'), false)
})

test('rejects template and placeholder values', () => {
  assert.equal(
    isSupabaseConfigured('https://your-project.supabase.co', 'your-anon-key'),
    false
  )
  assert.equal(
    isSupabaseConfigured('https://placeholder.supabase.co', 'placeholder'),
    false
  )
  assert.equal(
    isSupabaseConfigured('https://myproject.supabase.co', 'placeholder'),
    false
  )
  assert.equal(
    isSupabaseConfigured('https://placeholder.supabase.co', 'real-anon-key-123'),
    false
  )
})

test('rejects invalid URL protocols', () => {
  assert.equal(
    isSupabaseConfigured('ftp://myproject.supabase.co', 'anon-key-123'),
    false
  )
  assert.equal(
    isSupabaseConfigured('not-a-url', 'anon-key-123'),
    false
  )
})

test('accepts valid https URLs and keys', () => {
  assert.equal(
    isSupabaseConfigured('https://xyzcompany.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'),
    true
  )
  assert.equal(
    isSupabaseConfigured('http://localhost:54321', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'),
    true
  )
})

// ─── inspectDatabaseUrl ──────────────────────────────────────────────────────

test('inspectDatabaseUrl identifies unset url', () => {
  const result = inspectDatabaseUrl('')
  assert.equal(result.configured, false)
  assert.equal(result.isSupabasePooler, false)
  assert.equal(result.hasPgbouncer, false)
  assert.ok(result.warning?.includes('not set'))
})

test('inspectDatabaseUrl detects Supabase pooler on port 6543 without pgbouncer', () => {
  const url = 'postgresql://postgres.ref:pass@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'
  const result = inspectDatabaseUrl(url)
  assert.equal(result.configured, true)
  assert.equal(result.isSupabasePooler, true)
  assert.equal(result.hasPgbouncer, false)
  assert.ok(result.warning?.includes('?pgbouncer=true'), 'must warn about missing ?pgbouncer=true')
})

test('inspectDatabaseUrl recognizes ?pgbouncer=true parameter', () => {
  const url = 'postgresql://postgres.ref:pass@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true'
  const result = inspectDatabaseUrl(url)
  assert.equal(result.configured, true)
  assert.equal(result.isSupabasePooler, true)
  assert.equal(result.hasPgbouncer, true)
  assert.equal(result.warning, null)
})

test('inspectDatabaseUrl recognizes direct connection without warning', () => {
  const url = 'postgresql://postgres.ref:pass@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'
  const result = inspectDatabaseUrl(url)
  assert.equal(result.configured, true)
  assert.equal(result.hasPgbouncer, false)
  assert.equal(result.warning, null)
})

// ─── getFriendlyAuthErrorMessage ─────────────────────────────────────────────

test('translates "Failed to fetch" into an informative error', () => {
  const err = new TypeError('Failed to fetch')
  const friendly = getFriendlyAuthErrorMessage(err, 'https://myproject.supabase.co')
  assert.ok(friendly.includes('Failed to connect to Supabase Auth'))
  assert.ok(friendly.includes('https://myproject.supabase.co'))
  assert.ok(friendly.includes('paused'))
})

test('translates "fetch failed" (Node-style) into an informative error', () => {
  const err = new Error('fetch failed')
  const friendly = getFriendlyAuthErrorMessage(err, 'https://myproject.supabase.co')
  assert.ok(friendly.includes('Failed to connect to Supabase Auth'))
})

test('translates invalid credentials', () => {
  const friendly = getFriendlyAuthErrorMessage(new Error('Invalid login credentials'))
  assert.equal(friendly, 'Invalid email or password. Please verify your credentials.')
})

test('passes through specific unrecognized errors', () => {
  const friendly = getFriendlyAuthErrorMessage(new Error('Rate limit exceeded'))
  assert.equal(friendly, 'Rate limit exceeded')
})
