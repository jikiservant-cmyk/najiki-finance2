# Na'jiki Tech — Payment & Messaging Gateway

Unified payment and messaging gateway for SACCO, Church, and School platforms.
Partner applications create payment intents against this service, receive signed
webhooks when payments settle, and can dispatch SMS to their members.

- **Payments:** LivePay (mobile money collection) with per-tenant credentials
- **Messaging:** Africa's Talking SMS with a Redis-backed queue, retries, and delivery reports
- **Dashboard:** Next.js 15 admin console — revenue analytics, transactions, webhook logs, setup
- **Auth:** Supabase Auth (email + password), super-admin gated
- **Data:** PostgreSQL (Supabase) via Prisma

---

## Quick start

**Prerequisites:** Node.js ≥ 20.9, a PostgreSQL database (Supabase recommended), and a Redis instance (Upstash).

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env      # then fill in the values

# 3. Create the database schema
npx prisma db push        # or: npx prisma migrate dev

# 4. (optional) Seed demo applications, providers and tenants
npm run db:seed

# 5. Run
npm run dev               # http://localhost:3000
```

Sign in at `/login` with a Supabase user whose email is listed in
`SUPER_ADMIN_EMAILS`. That account is auto-provisioned as `super_admin` on
first login. **There is no default** — if `SUPER_ADMIN_EMAILS` is empty, nobody
can access the dashboard.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Development server (build output goes to `.next-dev`) |
| `npm run build` | `prisma generate` + production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:push` | Push the Prisma schema to the database |
| `npm run db:migrate` | Create/apply a Prisma migration |
| `npm run db:check` | Verify Prisma <-> Supabase PostgreSQL and Supabase Auth connectivity |
| `npm run db:seed` | Seed demo data (`scripts/seed.ts` — never run in production) |
| `npm run db:harden` | Enable RLS + revoke anon/authenticated grants, then verify |
| `npm run cron:setup` | Register the QStash schedules for the background workers |
| `npm test` | Unit tests (Node's built-in runner) |
| `npm run verify` | `typecheck` + `lint` + `test` — what CI runs |

---

## Environment variables

See [`.env.example`](./.env.example) for the full annotated list.

Everything marked **required in production** is asserted at boot by
`src/lib/env.ts` (wired up through `src/instrumentation.ts`). A misconfigured
deployment fails immediately instead of failing later at runtime. In particular:

- `APP_ENCRYPTION_KEY` — 64 hex chars; encrypts per-tenant provider credentials (AES-256-GCM)
- `SUPER_ADMIN_EMAILS` — dashboard allowlist; no default
- `LIVEPAY_WEBHOOK_SECRET` — ≥16 chars; webhook verification fails closed without it
- `UPSTASH_REDIS_*` — the in-memory Redis fallback is refused in production
- `CRON_SECRET` — protects the background worker endpoints
- `NEXTAUTH_URL` — public origin; part of the LivePay webhook signature string

---

## API overview

### Partner APIs (API key auth — `Authorization: Bearer <app api key>`)

| Endpoint | Description |
| --- | --- |
| `POST /api/payments` | Create a payment intent (idempotent via `idempotencyKey`) |
| `GET /api/payments/:reference` | Payment status; scoped to the calling application |
| `POST /api/messaging/send` | Queue an SMS for delivery |

### Webhooks (signature verified, no session)

| Endpoint | Description |
| --- | --- |
| `POST /api/webhooks/livepay` | LivePay payment status callback |
| `POST /api/webhooks/africastalking` | SMS delivery report (`X-Callback-Secret`) |

### Background workers (Bearer `CRON_SECRET`, scheduled via `vercel.json`)

| Endpoint | Description |
| --- | --- |
| `POST/GET /api/cron/notifications` | Retries undelivered partner webhooks with exponential backoff |
| `POST/GET /api/cron/sync-payments` | Polls the provider for stuck pending payments |
| `POST/GET /api/cron/alerts` | Operational alerting (stuck payments, exhausted webhooks, SMS backlog) |
| `POST/GET /api/qstash/sms-cron` | Drains the SMS queue |

### Unauthenticated endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Liveness probe — DB + Redis reachability. `?deep=1` also counts stuck payments. Returns 503 when a dependency is down. |

### Admin APIs (Supabase session + `super_admin`)

| Endpoint | Description |
| --- | --- |
| `GET /api/dashboard` | Revenue/analytics aggregates |
| `GET /api/setup`, `POST /api/setup` | Applications, providers, tenants, tenant credentials |
| `GET /api/messaging/dashboard` | SMS stats |
| `POST /api/messaging/quick-send` | Send an SMS from the dashboard (rate limited) |

All admin responses are sent with `Cache-Control: no-store`, and the dashboard
refreshes by polling `/api/dashboard` rather than subscribing to Supabase
Realtime from the browser — see the security notes below.

---

## Webhook verification

Outbound partner webhooks are signed so the receiving application can verify
authenticity and reject replays:

```
X-Najiki-Timestamp: <unix ms>
X-Najiki-Signature: t=<unix ms>,v=<hmac>
```

`v = HMAC-SHA256(application_api_key, "<timestamp>.<raw request body>")`.
Reject requests whose timestamp is more than 5 minutes old.

Inbound LivePay webhooks are verified with `LIVEPAY_WEBHOOK_SECRET`, including a
5-minute replay window, and delivery is idempotent — replayed deliveries are
detected via a SHA-256 `signatureHash` on `webhook_logs` and acknowledged
without reprocessing.

---

## Deployment

1. Set every **required in production** variable from `.env.example` in your
   hosting provider's environment settings. The app refuses to boot if any are
   missing (`src/lib/env.ts`).
2. Apply the schema with migrations — never `db push` in production:

   ```bash
   npx prisma migrate deploy     # see prisma/migrations/README.md for the baseline step
   ```

3. **Harden database exposure** (this one is not optional — see below):

   ```bash
   npm run db:harden              # enables RLS, revokes anon/authenticated, then verifies
   ```

4. Deploy.
5. Register the background workers. `vercel.json` ships two *daily* crons
   because Vercel's Hobby plan rejects sub-daily expressions outright (a
   deployment with `* * * * *` fails to build). Minute-level scheduling is done
   through QStash, which works on any plan and any host:

```bash
npm run cron:setup             # creates/replaces all four QStash schedules
```

---

## Connecting Supabase & Troubleshooting

### 1. Database Connection (`DATABASE_URL` and `DIRECT_URL`)
- **Port 6543 (Transaction Pooler):** Prisma requires `?pgbouncer=true` when connecting through PgBouncer / Supavisor in transaction mode (port 6543). Without it, Prisma prepared statements fail.
  ```bash
  DATABASE_URL="postgresql://postgres.[REF]:[PASS]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true"
  DIRECT_URL="postgresql://postgres.[REF]:[PASS]@aws-0-[REGION].pooler.supabase.com:5432/postgres"
  ```
- **Port 5432 (Session Mode / Direct):** Used for migrations (`DIRECT_URL`) and direct queries.

### 2. Dashboard Login & Supabase Auth (`NEXT_PUBLIC_SUPABASE_*`)
- **"Failed to fetch" on `/login`:** Occurs when:
  - `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` are missing or set to placeholder values.
  - The Supabase project is **paused** (free tier projects pause after 7 days of inactivity — restore it via the Supabase dashboard).
  - Network policies or CORS prevent reaching the Supabase Auth endpoint.
- **Local Development:** When Supabase Auth is unconfigured in development mode (`process.env.NODE_ENV !== 'production'`), the `/login` page provides a clear diagnostic warning and a dev-mode bypass to explore the dashboard.

### 3. Verify Connection Status
Run the built-in diagnostic tool to test both Prisma database connectivity and Supabase Auth:
```bash
npm run db:check
```

6. Set `NEXTAUTH_URL` to your public HTTPS origin — it must match the URL
   registered with LivePay or webhook signatures will not verify.
7. Point Africa's Talking's delivery-report callback at
   `https://<your-domain>/api/webhooks/africastalking` and set
   `AFRICASTALKING_CALLBACK_SECRET`.
8. Optionally set `ALERT_WEBHOOK_URL` (Slack/Discord/generic JSON) so
   `/api/cron/alerts` can reach a human.

### Why step 3 matters

Prisma creates every table in the `public` schema, which is the schema Supabase
exposes through its Data API. The anon key that ships to the browser can read
any table in that schema **unless RLS is enabled and denies by default** — so
`applications.api_key` (every partner's API key) and all payment rows would be
world-readable. `npm run db:harden` fixes and then *proves* the fix by querying
the Data API with the anon key.

---

## Project structure

```
src/
  app/                 Next.js App Router (pages + API routes)
  components/          UI (shadcn/ui) and app components
  hooks/               Dashboard polling (no browser-side database access)
  lib/
    auth.ts            Session + super-admin guards
    env.ts             Boot-time environment assertions
    encryption.ts      AES-256-GCM for tenant credentials
    payments.ts        Payment lifecycle, webhook signing + delivery
    backoff.ts         Retry/backoff policy (unit-tested)
    rate-limit.ts      Shared Upstash limiter
    redact.ts          Phone-number masking for logs and audit payloads
    sms-store.ts       SMS records (Postgres)
    safe-fetch.ts      SSRF-guarded outbound HTTP
    webhook-hash.ts    Inbound webhook idempotency hashing (unit-tested)
    redis.ts           Upstash client (in-memory fallback in dev only)
    providers/         Payment provider adapters (LivePay)
tests/                 Unit tests (node --test, no framework)
scripts/harden-database.ts       RLS + grant hardening and verification
scripts/setup-cron-schedules.ts  QStash schedule registration
.github/workflows/ci.yml         typecheck · lint · test · build
prisma/schema.prisma   Data model
apps/, packages/       Reserved for future modular-monolith extraction (see ARCHITECTURE.md)
.zscripts/             Sandbox tooling — NOT used for production deploys
```

---

## Security notes

- Dashboard auth fails **closed**: an error in the auth check denies the request.
- All outbound webhook requests go through `safe-fetch`, which blocks private,
  loopback, link-local and cloud-metadata addresses (SSRF protection).
- Provider credentials are encrypted at rest; the service-role Supabase client
  is marked `server-only` so it can never be bundled for the browser.
- Customer phone numbers are masked in stored webhook payloads and in logs.
- Inbound provider webhooks are rate limited, size capped, and **verified before
  anything is written** — a rejected delivery cannot create or suppress an audit
  row.
- Partner API keys are opaque `Authorization: Bearer` credentials; the
  idempotency key is scoped per application so one partner can never observe
  another's payment.
- The dashboard reads data through session-gated API routes only; no
  browser-side Supabase table access (which would require either RLS-off or a
  public Realtime policy).
