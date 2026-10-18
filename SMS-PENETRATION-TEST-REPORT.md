# Na'jiki Finance — SMS engine security assessment

**Date:** 2026-10-17
**Scope:** Current `arena/ef3370ad-najiki-finance2` checkout: partner/admin send routes, Africa's Talking adapter, Redis queue, Postgres SMS store, delivery reports, scheduling, limits, retention and runtime dependencies. This was a **local, non-destructive** code review with mocked routes/Redis/provider responses. No real SMS, live API, production database, provider account or external target was used. Severity reflects potential impact, **not** confirmed exploitation of a deployment.

## Verdict

**Do not rely on this SMS engine for exactly-once delivery, purchased-credit enforcement, or authoritative delivery statistics yet.** Authentication of partner sends and admin quick-send, signed/secret-protected callbacks, and the recent callback body limit are present, but the queue and billing/state-machine paths below need work before high-volume paid use.

## Findings, ordered by priority

### SMS-1 — High: ambiguous provider timeout can send the same SMS twice

**Code:** `src/lib/sms-queue.ts:115-122,191-214`; `src/lib/sms.ts:34-45,90-93`.

An exception from `SMS.send` is treated as a failed delivery and the same row is requeued. An HTTP timeout or lost response does **not** establish that the provider rejected the message. The outbound request contains a recipient, message and optional sender, but no stable provider-side idempotency key. HTTP `Idempotency-Key` only deduplicates creation of the local row, not later provider attempts.

**Safe mock:** First provider call was simulated as *accepted but response lost*, then threw; the worker retried and invoked the mocked provider **twice** for one SMS row (final attempt count 2). This proves the retry path, not that a real provider will bill twice.

**Impact:** Duplicate texts, duplicate charges and confusing delivery reports during transient provider/network failures.

**Fix:** Distinguish explicit provider rejection from ambiguous transport failure. Hold ambiguous jobs for reconciliation against a provider message ID/status if possible; otherwise require a deliberate retry policy that acknowledges possible duplicates. Use a provider-supported idempotency/reference field if available, and test timeout-after-acceptance.

### SMS-2 — High: a partial Redis failure can strand a newly created SMS permanently

**Code:** `src/lib/sms-queue.ts:25-44,55-69`; `src/app/api/messaging/send/route.ts:134-165`; `src/lib/sms-store.ts:101-143`.

`enqueue` writes `sms:queue:seen` with `SADD` **before** it writes the actual job list with `LPUSH`. If `LPUSH` fails, the set still says the ID is queued. On an API retry with the same idempotency key, `createOrGet` returns `created: false`, so the route does not enqueue again. Even a direct second `enqueue` sees the stale set entry and skips the missing job. A worker also removes a job with `RPOP` before it has a durable in-flight claim; a crash or Redis error in that interval has no database-backed recovery scan.

**Safe mock:** `SADD` succeeded and `LPUSH` threw once; the second `enqueue('sms-mock-1')` skipped. Result: **one seen marker, zero queued jobs, zero provider calls**.

**Impact:** Accepted/stored SMS can remain unsent with no automatic recovery; clients may receive a misleading duplicate acknowledgement on retry.

**Fix:** Use a durable database outbox and a transactional/atomic claim (or an acknowledged Redis queue with a processing list and visibility timeout). Reconcile old `queued`/`pending` rows against queue/in-flight state; make API retries able to repair missing jobs without resending completed ones. Test failures between every queue/database write.

### SMS-3 — High: spending control is not atomic, and partner payloads are unbounded

**Code:** `src/app/api/messaging/send/route.ts:41-55,102-149`; `src/app/api/messaging/quick-send/route.ts:9-13`; `src/lib/sms-store.ts:67-96`.

The partner route calls `count()` and then creates a row in separate operations. Concurrent sends can all observe the same count below `SMS_DAILY_LIMIT_PER_APP`; there is no atomic quota reservation or debit against purchased SMS credit. The default cap is **10,000 messages per application per day**, not a prepaid balance. `SMS_DAILY_LIMIT_PER_APP=0` intentionally disables it; a nonnumeric value also makes the `> 0` guard false. Unlike quick-send's 918-character schema cap, the partner route has no recipient/message schema or streaming body-size/segment limit before `request.json()` and insertion.

**Safe mock:** With a daily limit of **1**, four concurrent authorized requests were held at the same `count() = 0` snapshot. All **four returned 202**, created four rows, and queued four jobs. A **2,000-character** message was accepted by the partner handler. These were mocked DB/queue operations; no provider was contacted.

**Impact:** A compromised or overactive partner key can overspend provider credit, including through multi-part messages; concurrent requests can exceed even the configured message-count cap. Actual provider billing depends on carrier segmentation and acceptance.

**Fix:** Validate a finite positive quota at boot, enforce a small request/body and message/segment limit, and make quota/credit reservations atomic in the database. Charge or reserve against an explicit per-application balance before enqueuing; reconcile real provider cost and release failed reservations. Scope limits to the authenticated application and test concurrent sends.

### SMS-4 — Medium: provider acceptance is recorded as final delivery

**Code:** `src/lib/sms.ts:72-89`; `src/lib/sms-queue.ts:124-147`; `src/app/api/webhooks/africastalking/route.ts:124-155`.

Africa's Talking statuses `submitted` and `buffered` are treated as successful sends, then the queue writes `status: 'delivered'` and emits a delivered partner webhook. Those statuses mean provider/carrier acceptance, not handset delivery. A later delivery report can change the row, but if no report arrives, dashboards and partners continue to show a false final delivery.

**Safe mock:** A mocked provider response `{ success: true, status: 'submitted' }` made the queue store **`delivered`** immediately.

**Fix:** Represent accepted/submitted/buffered as `pending` (or a separate `submitted` state); emit final `delivered` only after an authenticated DLR says delivered. Add a timeout/unknown state for missing reports and ensure partner webhooks reflect final transitions.

### SMS-5 — Medium: delivery-report phone fallback can update another application's SMS

**Code:** `src/app/api/webhooks/africastalking/route.ts:131-155`; `src/lib/sms-store.ts:245-283,193-211`.

If a callback's provider message ID is unknown, the handler falls back to the newest unresolved row matching the phone number. That search does **not** scope by application or verify the callback ID matches the stored provider ID. It also writes the presented ID onto the chosen row and permits later status overwrites. A valid shared callback secret is still required; this is **not** an anonymous bypass. A legitimate mismatched/late report, or someone with the callback secret, can corrupt an unrelated app's status when a recipient has multiple messages.

**Safe mock:** A valid-secret callback with `id=unknown-id` and a phone number, with the provider-ID lookup returning null, updated a mocked **`sms-other-app`** row to `failed` and stored `unknown-id` on it; the handler returned **200**.

**Fix:** Match on provider ID as the authoritative key. If phone-only callbacks are necessary, require an unambiguous, tightly time-scoped candidate and a verified application/provider association; never overwrite an existing different provider ID. Make terminal transitions monotonic and audit rejected/mismatched DLRs.

### SMS-6 — Medium: SMS contents/recipient data leak into logs and are retained beyond phone redaction

**Code:** `src/lib/sms.ts:22-45,65-67`; `prisma/schema.prisma` (`SmsMessage.message`); `src/lib/retention-store.ts:82-160`.

The real send path logs the full destination and the provider response (which can include recipient data). Development simulation logs both destination **and full message**. The retention worker masks/purges `sms_messages.recipient` but never deletes/redacts `sms_messages.message`; stored texts can include OTPs or sensitive financial details. Access to DB/logs was not tested.

**Fix:** Remove or mask recipient/provider response fields in logs, never log message bodies, and adopt a defined short retention/purge policy for SMS content. Document exceptions needed for disputes and limit access to logs and DB exports.

## Conditional callback-secret risk

Africa's Talking cannot attach this app's custom HMAC header, so the production integration accepts a shared secret in the callback URL. `AFRICASTALKING_REQUIRE_ALLOWED_IP` is optional and empty in `.env.example`. A URL secret appearing in proxy/access logs can therefore be replayed to forge delivery reports if the URL leaks. This is a **credential-handling risk, not proof of a leak**. Use a dedicated high-entropy secret, redact query strings from logging, rotate on exposure, and require an IP allowlist **only behind a proxy that overwrites forwarded IP headers**. The already-added 16 KiB streaming cap and per-IP limiter do not authenticate a leaked URL.

## Checks and boundaries

- `npm test`: **154 passed, 0 failed**. Existing tests do not cover the SMS queue interleavings above.
- `npm run lint`: **passed**; `git diff --check`: **passed**.
- `npm audit --omit=dev`: **3 high affected package entries** (`prisma`, `@prisma/config`, `deepmerge-ts`), no moderate/critical. The installed Africa's Talking SDK and overridden `axios`/`joi`/`lodash` versions are **not** listed as affected by this audit. Advisory counts are not exploit proof.
- `npm run typecheck`: still fails in `src/lib/data.ts` and `scripts/reconcile-ledger.ts` because this sandbox lacks a generated Prisma client; Prisma engine downloads are blocked here. The production build and database migrations were not reverified.
- All exploit demonstrations used fake identifiers and stubbed DB, Redis and provider functions. They did **not** test actual provider acceptance, purchased balances, production RLS, proxy configuration, delivery timing, or real-world billing.

**Suggested fix order:** prevent duplicate/ambiguous sends (SMS-1), make queue writes recoverable (SMS-2), enforce atomic credit/segment limits (SMS-3), then correct DLR state/correlation (SMS-4/5) and privacy retention (SMS-6). Verify with an authorized staging database, Redis and Africa's Talking sandbox before using paid credentials. No SMS application behavior was changed by this assessment.
