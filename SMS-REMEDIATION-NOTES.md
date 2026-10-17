# SMS remediation — deployment notes (2026-10-17)

This change addresses the six findings in `SMS-PENETRATION-TEST-REPORT.md`.
It does **not** add a platform-managed SMS credit ledger: `BUY_SMS` payments still
route to Na'jiki's platform account; the receiving partner application allocates
its own SMS credits after the payment-success webhook.

- Deploy **both SMS Prisma migrations** before deploying application code.
  They add webhook retry bookkeeping and the early-DLR inbox. The first marks
  pre-existing terminal rows as notified to avoid a historical webhook replay.
  Run `npm run db:harden` after migrations and verify Data API access is denied.
- Keep `/api/qstash/sms-cron` scheduled (normally every minute): Postgres
  `queued` rows are the durable outbox; Redis only accelerates dispatch. The
  `queued -> pending` database claim occurs before provider I/O. A worker crash
  or provider/network timeout *after* claiming can leave an SMS unconfirmed;
  the SDK wait is bounded to 12 seconds, but the system deliberately will **not**
  auto-resend it. Investigate the provider account manually before deciding
  whether another SMS is appropriate.
- Provider `submitted`/`buffered` responses remain `pending`. An authenticated,
  provider-ID-matched DLR alone may confirm `delivered` or `failed`. A DLR that
  arrives before the provider ID is saved is held in `sms_delivery_reports` and
  reconciled by the SMS cron; unmatched reports expire after seven days. The
  correlation is by provider ID **only**, never the recipient phone number.
  Pending messages become `unknown` after 48 hours without a terminal DLR;
  late DLRs can still resolve them. Never treat `unknown` as proof of failure
  or delivery.
- Partners receive signed `SMS_DELIVERY_UPDATE` webhooks for terminal states;
  non-2xx responses are retried by cron. Deliveries are **at least once**, so
  partners should deduplicate using `(smsId, status)`. Missing/placeholder
  partner URLs or missing signing secrets must be configured for delivery.
- The operational cap `SMS_DAILY_LIMIT_PER_APP` (default 10,000) resets at
  midnight **UTC**; it counts requests, not paid credits or segments. The same
  atomic per-app cap and six-segment maximum apply to partner and admin sends.
- The retention cron also purges terminal/unknown SMS bodies after
  `SMS_CONTENT_RETENTION_DAYS` (default 7), separately from the recipient
  retention policy. If `PHONE_RETENTION_DAYS=0`, SMS bodies are **still purged**.
  Pending/queued texts are kept for processing/reconciliation. Assess this
  retention period and any dispute-preservation requirements before production.

Mocked regression tests cover quota serialization, Redis failures, duplicate
jobs, ambiguous provider outcomes, delivery-report correlation, segment limits,
provider logging, callback-before-ID reconciliation, UTC-midnight quota races,
and content retention. The schema parsed using Prisma's local WASM DMMF
parser; the baseline plus both SMS migrations applied in an in-memory
PostgreSQL runtime. A real database/Redis/provider staging run is still
needed: this sandbox cannot fetch the native Prisma schema engine, generate
a complete client or run a production build, and has no live provider
credentials. Historical rows previously marked `delivered` at provider
acceptance cannot be reliably reclassified without provider records.
