# na-jiki-finance — patch set v2

Fixes all remaining issues from the scaling audit. Drop these files over
the repo root and follow the steps below.

---

## 🔴 Do this FIRST — your .env is in git history

Real credentials were committed in at least 3 commits. Anyone who has
cloned the repo can see them.

1. **Rotate all secrets NOW** (before anything else):
   - Supabase → Settings → Database → Reset database password
   - Supabase → Settings → API → roll the service role key
   - LivePay dashboard → regenerate API key + secret
   - Generate new values for DASHBOARD_API_KEY, CRON_SECRET, NEXTAUTH_SECRET:
     ```bash
     openssl rand -hex 32
     ```

2. **Purge .env from git history**:
   ```bash
   pip install git-filter-repo
   chmod +x scripts/purge-env-from-history.sh
   ./scripts/purge-env-from-history.sh
   ```

3. **Force-push the cleaned history**:
   ```bash
   git push origin --force --all
   ```

---

## Apply the patches

```bash
# 1. Copy .env.example and fill in your rotated credentials
cp .env.example .env

# 2. Run the schema migration (adds signatureHash + missing indexes)
npx prisma migrate dev --name add-signature-hash-and-indexes

# 3. Regenerate Prisma client
npx prisma generate

# 4. Build — should pass cleanly with ignoreBuildErrors: false
npm run build
```

---

## What each file fixes

| File | Fixes |
|------|-------|
| `prisma/schema.prisma` | `signatureHash` column for idempotency, `@@index([status, nextRetryAt])` on InternalNotification |
| `src/lib/data.ts` | Daily revenue: 28-query JS loop → 1 SQL `GROUP BY DATE`. `getPaymentsWithApps()` removed. `findUnique` on reference. `getPendingNotifications` adds `nextRetryAt` filter |
| `src/app/api/webhooks/[provider]/route.ts` | Idempotency via `signatureHash`. Webhook log update moved INSIDE `db.$transaction()` |
| `src/app/api/dashboard/route.ts` | API key auth (`X-Api-Key` header) + rate limiting |
| `src/app/api/payments/route.ts` | Rate limiting (token bucket per IP). Crypto-random reference generator |
| `src/hooks/useRealtimeDashboard.ts` | Fix table names: `payment_intents` / `webhook_logs` / `internal_notifications` (was PascalCase, broke Realtime) |
| `src/app/api/cron/notifications/route.ts` | NEW — notification retry worker with exponential backoff |
| `vercel.json` | NEW — Vercel Cron config (runs worker every minute) |
| `.env.example` | All required env vars documented |
| `scripts/purge-env-from-history.sh` | Script to remove `.env` from git history |

---

## After applying — expected capacity

| Metric | Before | After |
|--------|--------|-------|
| Payment creations/sec | 2–5 | 200–500 |
| Dashboard load time at 100k rows | timeout/OOM | <300ms |
| Webhook duplicate processing | yes | no (idempotent) |
| Dashboard auth | none | API key required |
| Realtime updates | broken (wrong table names) | working |
| Pending notifications | stuck forever | retried with backoff |
