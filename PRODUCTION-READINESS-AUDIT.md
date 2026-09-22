# Production-readiness audit — `najiki-finance2`

**Audited:** `main` @ `6fe6440` and PR **#1** (`arena/01a0ca5d-…`, head `f252dc0`) · 2026-09-22

---

## Status update — what this branch now fixes

**Branch:** `arena/01a0ca6f-najiki-finance2` (contains PR #1, plus 7 commits on top)

| Item | Status |
| --- | --- |
| **B1** cross-tenant leak in `POST /api/payments` | ✅ Fixed — authenticate → validate → scoped idempotency; key is now unique per application |
| **B2** Supabase Data API exposure | ⚠️ Tooling shipped (`npm run db:harden`), **must be run against the real database** — it verifies by querying `/rest/v1` with the anon key and exits non-zero if anything is still readable |
| **B3** browser-side Realtime access | ✅ Fixed — replaced with polling of the session-gated `/api/dashboard` |
| **B4** broken SMS delivery reports | ✅ Fixed — matcher exempts both callback paths (trailing-slash anchored), `AFRICASTALKING_CALLBACK_SECRET` required again, lookup is indexed |
| **B5** webhook poisoning / unbounded writes | ✅ Fixed — rate limited, 64 KB cap, **verify before write**, canonical signature URL, P2002-safe dedupe |
| **B6** Vercel Hobby cron limits | ✅ Fixed — `vercel.json` is Hobby-safe (2 daily jobs); minute-granularity workers registered via QStash (`npm run cron:setup`) |
| **B7** no Prisma migrations | ⚠️ Procedure + pre-flight queries documented (`prisma/migrations/README.md`); the baseline itself must be generated where the Prisma engines can download |
| **B8** no tests / no CI | ✅ Fixed — 13 unit tests on the money-path helpers (`npm test`), CI runs typecheck · lint · test · build |
| **B9** no health endpoint / alerting | ✅ Fixed — `GET /api/health`, `/api/cron/alerts` with Slack/Discord webhook + thresholds |
| **B10** settlement model, mixed units, BigInt | ❌ **Not addressed** — needs product decisions (payout/settlement flow, whether `amount` stays `Decimal(14,2)` for UGX) |
| Medium: API keys plaintext + reused as webhook HMAC | ❌ **Not addressed** — hashing at rest needs a key-migration/rotation plan (existing keys are in use) |
| Medium: `StubProvider` reachable via setup UI | ❌ Not addressed |
| Medium: PII in logs, notification payloads | 🟡 Partially — phone numbers masked in logs, stored webhook payloads and dashboard responses; `payment_intents.phone_number` is still stored in clear and there is no retention policy |

Also fixed on this branch beyond the list below: retry/poll starvation (a payment
the provider never resolved fell out of the 24h window and was never
reconciled), the QStash path claiming `delivered` with no delivery receipt, the
notification worker being killed mid-batch, and six SQL scripts that cannot run
against the Prisma schema (one of which creates a conflicting `applications`
table).

---

## Verdict (as of the audit, before the fixes above)

**No — not production-ready.** The status table above lists what this branch now
closes; the blockers that remain are the ones marked ❌ or ⚠️.

**PR #1 is genuinely good and should be merged** — I read the diff and most of its claims check out (auth fail-open, hard-coded super-admin backdoor, the webhook retry state machine, simulated SMS, prod Redis mock, dead env validation). But it is a *security hardening* PR, not a "ready to take real money" PR. There were **10 blockers**, several of which could lose money or leak partner API keys in a way the PR did not touch.

| Area | State |
| --- | --- |
| Auth / privilege escalation | ✅ PR fixes the two serious ones (fail-open middleware, hard-coded Gmail super-admin default). ⚠️ still a cross-tenant leak in `POST /api/payments`. |
| Money-path correctness | ⚠️ Works for the happy path. No settlement/payout side, amounts stored as `Decimal(14,2)` for a zero-decimal currency, no reconciliation. |
| Data exposure (Supabase) | 🔴 **Unverified and possibly critical** — see B2. Tables live in `public`; nothing in the deploy path enables RLS. |
| Webhook reliability | ✅ Much better after PR #1. ⚠️ the inbound webhook can still be spoofed/suppressed pre-signature (B5). |
| Deployability | 🔴 `vercel.json` schedules will **fail the deployment on Vercel Hobby** (B6); no Prisma migrations exist (B7). |
| Testing / CI / observability | 🔴 None. Zero tests, no CI, no health endpoint, no alerting, no error tracking (B8, B9). |

### Still open (found or confirmed while implementing the fixes)

1. **`POST /api/messaging/send` has no idempotency key.** A partner that retries
   an HTTP request creates and sends a *second* SMS — real money, per retry. The
   fix mirrors payments (optional `idempotencyKey`, unique per application) and
   needs a schema column plus a partner-facing contract decision, so it is left
   as an explicit decision rather than a silent behaviour change.
2. **API keys are plaintext and double as the outbound webhook HMAC secret.**
   Hashing at rest needs a rotation plan for keys already in use.
3. **Settlement/payout side does not exist.** The ledger only credits
   (`payment_in`); no payout, fee or reversal entry, and amounts stay
   `Decimal(14,2)` for a zero-decimal currency — reconciliation against provider
   statements will disagree by 100×.
4. **Inbound SMS delivery-report signature format differs from the payments
   webhook format** (`t=…,v=…` with replay window vs. a bare HMAC), and the SMS
   dispatch webhook sends the partner's API key as a bearer token. Changing
   either breaks existing integrations, so both are documented rather than
   silently altered.
5. **Background work kicked off inside a request** (`after()` / a detached
   `setTimeout` on enqueue) is best-effort on serverless. Correctness now rests
   on the cron workers; the inline path is just latency.
6. **Housekeeping:** `apps/`, `packages/`, `mini-services/` are empty
   scaffolding (`ARCHITECTURE.md` describes a structure that does not exist),
   `.zscripts/` is sandbox tooling, `reactStrictMode: false`, and there is no
   Content-Security-Policy.

---

## 1. What PR #1 fixes — verified in the diff, not just the description

I read every source change in the four commits. Confirmed:

| Fix | Confirmed how |
| --- | --- |
| Middleware was fail-open (`catch` returned the unauthenticated pass-through) → now fail-closed `denyRequest()` | `src/middleware.ts` diff |
| `requireSuperAdmin()` fell back to `smartskoolz@gmail.com,jikiservant@gmail.com` when `SUPER_ADMIN_EMAILS` was unset → no default now | `src/lib/auth.ts` diff |
| Failed partner webhooks were written as `'failed'` but the retry query only reads `('pending','failed_retrying')`, and **no worker route existed at all** → state machine fixed, `/api/cron/notifications` added with exponential backoff + jitter, `vercel.json` schedules added | `src/lib/payments.ts`, new `src/app/api/cron/notifications/route.ts` |
| `POST /api/messaging/quick-send` used `requireAuth()` → any logged-in user could spend platform SMS credit; now `requireSuperAdmin()` | route diff |
| Missing `AFRICASTALKING_API_KEY` **simulated** successful SMS delivery in production → now throws | `src/lib/sms.ts` diff |
| `AdminProfile.role` defaulted to `super_admin` → `member` (needs a schema push) | `prisma/schema.prisma` diff |
| `assertRuntimeEnv()` was dead code (never imported) → now wired via `src/instrumentation.ts`, plus `APP_ENCRYPTION_KEY` / `CRON_SECRET` / `NEXTAUTH_URL` checks | `src/lib/env.ts`, new `src/instrumentation.ts` |
| Production Redis silently fell back to a per-process in-memory mock → refuses now | `src/lib/redis.ts` diff |
| Build depended on `fonts.googleapis.com` at build time → self-hosted `geist` | `src/app/layout.tsx` diff |
| `/api/debug-apps` (duplicate of `/api/setup`, leaked every application API key) deleted; CORS no longer echoes an allow header to non-allowlisted origins; service-role client marked server-only | route diffs |
| Repo hygiene: ~80 MB of committed `.next-dev` output, AI Studio boilerplate README, stale `bun.lock`, `APPLY.md`/`worklog.md`/`metadata.json` removed; `package-lock.json` committed | `f252dc0` |

Two of those deserve emphasis: the **fail-open middleware** and the **hard-coded super-admin list** were full authentication bypasses, and the **dropped webhooks** meant partner apps were never told that payments had settled. Merging is a clear net win.

---

## 2. Blockers

### B1 🔴 Idempotency check runs *before* API-key authentication — cross-tenant leak
`src/app/api/payments/route.ts:96-107` looks up `idempotencyKey` and returns
`{ paymentId, reference, status }` **before** the caller's API key is validated at
`:110-122`.

Consequences:
- Anyone who presents *any* `Authorization: Bearer …` string (the key is never checked on that path) and supplies a known/guessed `idempotencyKey` gets back another application's payment id, reference and status.
- `PaymentIntent.idempotencyKey` is globally `@unique` (`prisma/schema.prisma`), so two partner apps can never use the same key — app B's request silently returns app A's payment instead of creating its own.

**Fix:** authenticate first, then look up idempotency; make it `@@unique([applicationId, idempotencyKey])` and filter the lookup by `applicationId`.

### B2 🔴 Supabase Data API / RLS: your payment tables may be world-readable with the public anon key
Every Prisma model is mapped into the `public` schema, `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships to the browser, and `public` is the schema Supabase exposes through its REST API. Nothing in the documented deploy path (`prisma db push` / `migrate deploy`) enables Row Level Security.

- On projects where Supabase's long-standing default grants apply, **a table in `public` with grants and no RLS is readable/writable through `/rest/v1/` by anyone holding the anon key** — including `applications.api_key` (every partner's API key) and all payment rows. ([supabase docs](https://supabase.com/docs/guides/api/securing-your-api), [grant change discussion](https://github.com/orgs/supabase/discussions/45329))
- Worth checking which side of Supabase's 2026 "automatically expose new tables" change your project is on — newer projects no longer auto-grant, older ones do.
- The repo's only RLS script (`scripts/rls-policies.sql`) is manual, is **not** part of the deploy path, and covers 9 of the 12 tables — `wallet_accounts`, `ledger_entries` and `admin_profiles` are missing.

**Verify (5 minutes):**
```sql
-- run in the Supabase SQL editor
select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace order by 1;
select grantee, table_name, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon','authenticated') order by 1,2;
```
```bash
# should NOT return any application API keys
curl -s "$SUPABASE_URL/rest/v1/applications?select=code,api_key" -H "apikey: $ANON_KEY"
```

**Fix:** enable RLS + deny-by-default on **every** table (Prisma connects as the owning role, so this does not break the app), or revoke `anon`/`authenticated` grants, or move the Prisma tables out of the exposed `public` schema. Commit it as a migration so it can't drift.

### B3 🔴 The "live" dashboard is either a public data firehose or permanently silent
`src/hooks/useRealtimeDashboard.ts` subscribes from the browser (anon key) to `postgres_changes` on `payment_intents`, `webhook_logs` and `internal_notifications`.
- With RLS **off** (today's likely state) any holder of the public anon key can stream live payment data.
- With RLS **on**, the only policies in the repo are `USING (auth.role() = 'service_role')`, which never matches the browser's `anon` role — so the subscription connects and then never fires. The feature is silently dead.

**Fix:** decide — drop Realtime (poll `/api/dashboard` on an interval, the route is already session-gated), or add per-authenticated-user policies + add the tables to the `supabase_realtime` publication.

### B4 🔴 SMS delivery reports are broken (and the required-env list regressed)
- `src/app/api/messaging/callback/route.ts` re-exports the Africa's Talking DLR handler, but the middleware matcher (`src/middleware.ts:107`) does **not** exclude it, so it sits behind the session gate: Africa's Talking gets `401 {"error":"Unauthorized"}` on every delivery report. I confirmed the matcher behaviour by executing the regex: `/api/messaging/callback` → session-gated, `/api/webhooks/africastalking` → public.
- PR #1 also removed `AFRICASTALKING_CALLBACK_SECRET` from `REQUIRED_IN_PROD` (`src/lib/env.ts`), while the handler fails closed in production when it is unset. So a deployment that follows the new `.env.example` semantics can end up with every DLR rejected — SMS stay `pending` forever and SMS cost reporting is wrong.

**Fix:** restore the env requirement; either exclude `/api/messaging/callback` from the matcher or delete the alias and register `/api/webhooks/africastalking` with the provider.

### B5 🟠 Inbound webhooks can be spammed and pre-poisoned (write happens before verification)
`src/app/api/webhooks/[provider]/route.ts`:
- The dedupe lookup (`:49-52`) happens **before** signature validation, and the audit row is inserted for *every* request including invalid signatures (`:103-121`). No rate limiting, no body-size cap → unauthenticated `INSERT` + `UPDATE` per request: DB bloat and cheap DoS.
- Worse, the invalid-signature path marks the row `processed: true`. Because the dedupe check short-circuits on `existingLog?.processed`, an attacker who knows a payment's provider-side identifier (`internal_reference`) and status can pre-seed the hash and cause the **genuine** webhook to be acknowledged as a duplicate and never processed. The 2-minute status-poll cron is the only thing saving the payment — a thin safety net, not a design.
- The signature candidate list also includes a URL derived from `x-forwarded-host` (`:85-89`) rather than the canonical `NEXTAUTH_URL`.

**Fix:** verify the signature first; persist audit rows only after verification (or store pre-verification rejects in a way that cannot suppress later valid deliveries); rate-limit and size-cap the endpoint; canonicalise the URL used for signature verification.

### B6 🔴 `vercel.json` will fail the deployment on Vercel Hobby
PR #1 adds three crons at `* * * * *` / `*/2 * * * *`. Vercel Hobby allows **2 cron jobs, once per day**; a sub-daily schedule makes the deployment fail outright ("Hobby accounts are limited to daily Cron Jobs"). Pro (40 jobs, per-minute) or an external scheduler is required. ([Vercel cron docs](https://vercel.com/blog/cron-jobs), [limits](https://steadycron.com/guides/vercel-cron-limits/))

### B7 🔴 `prisma/migrations/` does not exist
The PR's README tells you to deploy with `npx prisma migrate deploy`, but there are no migration files — on a fresh database that creates **nothing**. Production has also been relying on `prisma db push`, which can silently drop columns.

**Fix:** generate and commit the initial migration; use `migrate deploy` in the pipeline; keep `db push` for local dev only.

### B8 🔴 No tests, no CI
Zero test files, no test runner in `package.json`, no `.github/` directory. This service moves money and fans out signed webhooks. Minimum viable coverage: signature verification (valid/invalid/replayed/stale timestamp), amount & currency mismatch, `completePayment()` double-credit guard, idempotency, notification backoff/exhaustion. Plus a CI workflow running `tsc --noEmit`, `eslint .`, `next build` — the three commands PR #1 claims to have run by hand.

### B9 🔴 No health endpoint, no alerting, no error tracking
Only `console.log`. There is no `/api/health`, no Sentry/OpenTelemetry, no alert when a payment is stuck in `processing`, when notifications hit `failed_exhausted`, or when the SMS queue backs up. You will find out about outages from a partner, not from the system.

### B10 🟠 Money model: no settlement side, mixed units, latent `BigInt` serialization bug
- `PaymentIntent.amount` is `Decimal(14,2)` but UGX has no minor units; the wallet converts with `BigInt(Math.round(amount * 100))` (`src/lib/payments.ts`). Internally consistent, but nothing maps back to provider statements — reconciliation will disagree by 100×.
- The ledger only ever **credits** (`entryType: 'payment_in'`); there is no payout, settlement, fee or reversal flow, so `WalletAccount.balanceMinor` only grows and cannot be tied to real bank/mobile-money balances.
- `WalletAccount.balanceMinor`/`LedgerEntry.balanceAfterMinor` are `BigInt`; `NextResponse.json()` throws on `BigInt` ("Do not know how to serialize a BigInt"). Nothing returns wallets today — it is a landmine for the first endpoint that does.

---

## 3. Medium — fix before scaling up

- **API keys are plaintext, duplicated and overloaded.** `Application.apiKey` is stored unhashed, returned by `GET /api/setup`, and reused as the outbound webhook **HMAC signing key** (`buildNotificationHeaders`). One leak breaks both inbound auth and outbound authenticity. Hash at rest, return once, add rotation, and use a separate webhook signing secret.
- **Provider selection is arbitrary.** `db.provider.findFirst({ where: { isActive: true } })` (`src/app/api/payments/route.ts:117`) has no ordering. `getPaymentProvider()` returns a `StubProvider` that *throws* for `mtn`/`airtel`/`pesapal` — if anyone activates such a provider row in the setup UI, payment initiation starts failing for every new intent. Restrict to `getAvailableProviders()` and make the platform provider explicit.
- **Stuck payments are forgotten after 24 h.** Both pollers filter `createdAt: { gte: twentyFourHoursAgo }` (`sync-payments/route.ts:21-25`, `qstash/cron/route.ts:22-26`). Anything older is never resolved and never surfaced.
- **Notification worker can exceed its budget.** Up to 100 rows processed serially with 10 s timeouts under `maxDuration = 60` — Vercel kills it mid-run. Batch by elapsed time, or fan out.
- **The DB overstates webhook delivery.** The QStash path marks rows `delivered` at publish time, with no DLQ/status callback, so a partner who never received the payload still looks green.
- **SMS storage won't scale.** One Redis hash + `HGETALL` on every DLR callback and dashboard load (`src/lib/sms-store.ts`): O(N) traffic and cost, unbounded growth, no retention. Move SMS records to Postgres with an index on provider message id. SMS ids also use `Math.random()`.
- **Rate limiting is partial.** Only `/api/payments` (POST/GET) and `/api/messaging/send`. Nothing on inbound webhooks or cron. Quick-send (which spends real money) has none.
- **PII.** Phone numbers are logged in plaintext (`webhooks/africastalking/route.ts`, `sms-queue.ts`) and stored unencrypted in `payment_intents`. No retention policy. Also note the payload-masking regex `/(\+?[0-9]{3})[0-9]{3,6}([0-9]{3})/g` masks *any* 9-12 digit run — it can corrupt long identifiers/amounts in the audit trail.
- **Admin model is all-or-nothing.** Everything gated behind `super_admin`; no per-tenant scoping, no audit log of admin actions (who changed a tenant's credentials), and the `AdminRoleEnum` values beyond `super_admin` are decorative.
- **`POST /api/setup` has no schema validation** — raw `request.json()` straight into Prisma writes.
- **Error messages are echoed to callers** in the cron/webhook handlers (`error.message` in the JSON body).
- **Matcher uses unanchored prefixes** — `api/cron` also excludes a future `api/crons-…`. Use `api/cron/` (same for the others).
- **Legacy schema drift:** `scripts/supabase-schema.sql` creates a *different* `applications`/`payments` schema (UUID ids, `display_name`, `webhook_url`). Running it against the Prisma database creates conflicting tables. Delete it or move it to `docs/legacy/`.
- **Unused scaffolding:** `apps/`, `packages/`, `mini-services/` contain only `.gitkeep`; `ARCHITECTURE.md` describes a modular monolith that does not exist. `reactStrictMode: false`; no `Content-Security-Policy`; no `db:seed` guard against running demo data in production.
- **Installs are not reproducible on `main`** (only a stale `bun.lock`). PR #1 fixes this by committing `package-lock.json` — another reason to merge.

---

## 4. Secrets in history — checked, with one caveat

I scanned all 47 commits of `main` plus dangling objects: **no `.env` was ever committed, and no high-entropy credentials (JWTs, `sk_*`, `AIza*`, `postgresql://user:pass@…`) exist in the current history.** `gh api .../commits?path=.env` returns nothing.

Caveat: history was rewritten at some point — an earlier commit added `scripts/purge-env-from-history.sh` (gone from the tree), and `APPLY.md` (still on `main`, deleted by PR #1) claimed real credentials *had* been committed in "at least 3 commits". If that ever happened, GitHub may still serve the old SHAs, and clones/forks would keep them.

**Do this anyway (30 minutes, cheap insurance):** rotate the Supabase database password and service-role key, the LivePay API key + webhook secret, `CRON_SECRET`, and any Africa's Talking keys; then enable GitHub secret scanning + push protection.

---

## 5. What I could and could not verify

**Verified myself:**
- `npx eslint .` on `main` → **clean**.
- `npx tsc --noEmit` on `main` and on the PR head → identical error sets (10, all in `src/lib/data.ts`), all caused by the Prisma client not being generated in this sandbox. **The PR introduces no new type errors.**
- Middleware matcher behaviour, executed as a regex (`/api/messaging/callback` gated; `/api/webhooks/*`, `/api/cron/*`, `/api/payments*` public).
- Every source change in PR #1, plus the RLS/inventory scans above.

**Could not verify:** `next build` and `prisma generate` — this sandbox blocks `binaries.prisma.sh`, so the Prisma engine cannot be downloaded. I could not independently reproduce PR #1's "build is green" claim, though the code review gives no reason to doubt it. Note for CI: the build still depends on Prisma's engine CDN, so a hermetic build needs `PRISMA_ENGINES_MIRROR` or a warm engine cache.

---

## 6. Recommended order

1. **Merge PR #1** (already included in this branch).
2. Apply the schema change (`role` default + the three changes in this branch) — via a real migration, not `db push` (B7).
3. Run `npm run db:harden` against the production database and keep the output: it is the evidence for **B2**.
4. Generate the migration baseline (B7) and switch the deploy step to `migrate deploy`.
5. Register the workers (`npm run cron:setup`) and confirm `/api/health` is green.
6. Add settlement/payout + reconciliation and settle on minor units (**B10**); then work through the medium list (key hashing/rotation is the next security item).

**Bottom line:** PR #1 takes this from "actively dangerous" to "solid beta". It is not yet a system I would let hold other people's money without B1, B2, B4, B5, B6, B7, B8 and B9 closed.
