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
| `npm run db:seed` | Seed demo data |

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
| `POST/GET /api/qstash/sms-cron` | Drains the SMS queue |

### Admin APIs (Supabase session + `super_admin`)

| Endpoint | Description |
| --- | --- |
| `GET /api/dashboard` | Revenue/analytics aggregates |
| `GET /api/setup`, `POST /api/setup` | Applications, providers, tenants, tenant credentials |
| `GET /api/messaging/dashboard` | SMS stats |
| `POST /api/messaging/quick-send` | Send an SMS from the dashboard |

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
   hosting provider's environment settings.
2. Apply the schema: `npx prisma migrate deploy`.
3. Deploy. On Vercel, `vercel.json` registers the cron schedules automatically;
   on other platforms, schedule the worker endpoints yourself.
4. Set `NEXTAUTH_URL` to your public HTTPS origin — it must match the URL
   registered with LivePay or webhook signatures will not verify.

---

## Project structure

```
src/
  app/                 Next.js App Router (pages + API routes)
  components/          UI (shadcn/ui) and app components
  hooks/               Realtime dashboard subscription
  lib/
    auth.ts            Session + super-admin guards
    env.ts             Boot-time environment assertions
    encryption.ts      AES-256-GCM for tenant credentials
    payments.ts        Payment lifecycle, webhook signing + delivery
    safe-fetch.ts      SSRF-guarded outbound HTTP
    redis.ts           Upstash client (in-memory fallback in dev only)
    providers/         Payment provider adapters (LivePay)
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
- Customer phone numbers are masked in stored webhook payloads.
