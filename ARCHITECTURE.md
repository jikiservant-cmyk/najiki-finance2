# Architecture

A single Next.js (App Router) deployment: React dashboard + API routes + background
workers in one codebase, backed by Postgres (Prisma) and Upstash Redis.

There is no monorepo and no workspace packages. An earlier version of this file
described an `apps/*` + `packages/*` layout reachable through a `@najiki/*` path
alias; those directories contained only `.gitkeep` files, the alias had no
importers, and both have been removed. If you are looking for that structure, it
never existed.

## Layers

```
src/middleware.ts        session gate for every dashboard route (fail-closed)
src/app/                 routing layer — pages and API routes, kept thin
src/lib/                 all business logic; read this to understand behaviour
src/instrumentation.ts   runs once at boot: env assertion + process safety nets
prisma/schema.prisma     data model; prisma/migrations/0_init is the baseline
scripts/                 operational CLIs (seed, retention, reconcile, hardening)
```

Business logic lives in `src/lib` and is imported with the single alias `@/*`
(→ `./src/*`). Routes validate input, call into `src/lib`, and shape the response;
they do not contain the rules.

## Payment flow

1. **`POST /api/payments`** — rate limit → API key auth → body validation →
   idempotency lookup scoped to the authenticated application → provider
   selection → create `PaymentIntent` → `processPayment()`.
   The order is deliberate: the idempotency lookup used to run before API key
   validation, so a caller with a guessed key could read back another
   application's payment.

2. **Provider selection** is `explicit request → tenant default → DEFAULT_PROVIDER_CODE
   → oldest active implemented provider`, always filtered on
   `IMPLEMENTED_PROVIDER_CODES` (`src/lib/providers/index.ts`). That list is
   load-bearing: the database seeds MTN/Airtel/Pesapal rows as `isActive: true`
   but they are `StubProvider`s that throw, so an unfiltered "first active
   provider" query could hand a payment to a provider that cannot take it.
   A tenant pointed at an unimplemented provider gets a 503 naming the problem,
   not a silent fallback to a different provider.

3. **`processPayment()`** (`src/lib/payments.ts`) calls the provider adapter and
   persists the result. Money is stored in **minor units** as integers
   (`src/lib/money.ts`); note that UGX is a zero-decimal currency, so
   "UGX 5000" is `5000`, not `500000`.

4. **Settlement** arrives at `POST /api/webhooks/[provider]`, which verifies the
   provider signature, and only then calls `parseWebhookPayload` — the raw payload
   is parsed *after* authentication so an unauthenticated caller cannot reach the
   parser. On success, tenant payments (excluding platform-fee types) credit the
   tenant wallet and write one immutable `LedgerEntry`, keyed
   `${paymentIntentId}:payment_in` so a retry cannot double-credit
   (`src/lib/ledger-core.ts`, `src/lib/payments.ts`).

The intent must belong to the provider that signed the request: a callback
signed by provider A that names a payment created through provider B is rejected
with 409 rather than settling it.

## SMS flow

`POST /api/messaging/send` → optional idempotent enqueue → Upstash Redis queue →
worker drains the queue → Africa's Talking → delivery report.

- **Idempotency** is enforced in the database by
  `SmsMessage @@unique([applicationId, idempotencyKey])`. The queue claims work
  with `srem`, so a duplicate kick is wasted work rather than a duplicate send.
- **`sms_messages` is a table**, not a Redis hash. A single `HGETALL` per delivery
  report did not scale and lost records when Redis was flushed.
- **Retry** (`src/lib/sms.ts`) is gated on an explicit `senderIdRejected` signal.
  An earlier version retried whenever the response lacked a `Recipients` array,
  which rebilled a successful send.
- **Delivery reports** arrive at `/api/webhooks/africastalking`. See the auth note
  below — this endpoint is the only path that can move a message to `failed`.

## Authentication

| Surface | Mechanism |
| --- | --- |
| Dashboard pages/routes | Supabase session, enforced in `src/middleware.ts`; public routes are exactly `/login` and `/offline` |
| Partner API | `Authorization: Bearer <api key>`, hashed lookup (`src/lib/application-auth.ts`) |
| Provider webhooks | Per-provider signature (HMAC) over the raw body |
| Africa's Talking DLR | Shared secret in the callback URL + optional source-IP allowlist |
| Cron | `CRON_SECRET` bearer token or QStash signature (`src/lib/qstash-verify.ts`) |

### Africa's Talking delivery reports

AT does not sign its callbacks and sends no custom headers, so a header-only
secret check rejected **every** delivery report with 401. Because the DLR is the
only thing that can correct a message's status, messages stayed "delivered"
forever even when the carrier rejected them.

The secret now travels as a **query parameter** in the callback URL you register
in the AT dashboard:

```
https://<your-domain>/api/webhooks/africastalking?key=<AFRICASTALKING_CALLBACK_SECRET>
```

The `x-callback-secret` header is still accepted for setups that proxy the
callback. A secret in a query string is written to access logs, so treat the URL
as a credential — and set `AFRICASTALKING_ALLOWED_IPS` so a leaked URL alone is
not sufficient. The endpoint fails closed in production when the secret is unset.

## Data

- **Prisma + Postgres.** `prisma/migrations/0_init/migration.sql` is the baseline
  for a fresh database; an existing `db push`-managed database is *baselined*
  (`migrate resolve --applied 0_init`) rather than replayed. See
  `prisma/migrations/README.md` for both paths, and never use `db push` against
  a production database.
- **Retention.** Customer phone numbers and SMS recipients are masked after
  `PHONE_RETENTION_DAYS` (default 90) via `/api/cron/retention`. Only a literal
  `0` disables it — a malformed value falls back to the default rather than
  silently retaining everything forever. Masking, not deletion, is the default so
  a payment can still be reconciled after the number is gone.
- **Ledger.** `scripts/reconcile-ledger.ts` exits non-zero when derived balances
  and stored ledger entries disagree; wire it into monitoring, because drift means
  money moved without a matching record.

## Failure behaviour

- **Env**: `src/instrumentation.ts` calls `assertRuntimeEnv()` once at boot.
  Missing production secrets fail at start rather than at first use.
- **Unhandled rejections** are logged, not fatal. **Uncaught exceptions** are
  logged and then `process.exit(1)` so the platform restarts a corrupted process
  instead of leaving it serving.
- **Redis absent in production** is a hard error, not a silent in-memory
  fallback: queued messages and rate-limit state would otherwise be per-instance
  and vanish on cold start.

## Known gaps

Documented so they are not mistaken for working code:

- Only LivePay has a real adapter. MTN, Airtel and Pesapal are stubs.
- Settlement **payout** is not implemented. The ledger records what is owed.
- No Africa's Talking status-poll fallback: if a DLR is lost, the payment stays
  pending until manual reconciliation.
- The CSP still allows `unsafe-inline` for scripts; nonces would be the next step.
