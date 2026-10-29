# SMS broadcast go-live — implemented on the gateway, and what remains on the partner side

Status: **gateway changes complete, tested, ready to deploy.**
Scope of this change: the Na'jiki side of the plan only. Nothing here touches the
payment path, and the church application's webhook URL is **not** changed.

---

## 1. Why SMS never reached the partner (root cause)

Four independent faults were stacked. Fixing one would not have revealed the next.

| # | Fault | Effect | Where it was fixed |
|---|---|---|---|
| 1 | `applicationCode` compared with `!==` against the stored code | `403 Application code mismatch` for `CHURCH`, `Church`, ` church ` — returned **before** the row was inserted, so the messaging dashboard had nothing to show | `src/lib/sms-policy.ts`, `send/route.ts` |
| 2 | Provider rejection reason overwritten with the constant `'Provider rejected SMS'` | `InvalidSenderId`, `InsufficientBalance` and a network failure were indistinguishable in `failure_reason` | `src/lib/sms.ts`, `sms-store.ts`, `sms-queue.ts` |
| 3 | No per-message status read | A partner tracking a broadcast depended entirely on the webhook, which fires only for `delivered`/`failed` | new `GET /api/messaging/sms/:reference` |
| 4 | `unknown` is terminal but never notified | A recipient that aged out of the settlement window stayed unresolved forever | opt-in `SMS_NOTIFY_UNKNOWN` |
| 5 | **Account-level provider failures were discarded** | `Invalid API Key`, `Insufficient balance`, `User not found` came back in `SMSMessageData.Message` with no recipients; the code threw "outcome unknown", so the row stayed `pending` with no reason and became `unknown` 48 h later | `classifyProviderFailure()` in `src/lib/sms.ts` |

### Fault 5 is the one that explains the silent `pending → unknown` rows

Africa's Talking reports failures in **two** places and only one was read:

| Channel | Example | Was it handled? |
|---|---|---|
| per recipient — `SMSMessageData.Recipients[].status` | `InsufficientBalance` | yes |
| **account level** — `SMSMessageData.Message`, **no recipients at all** | `Invalid API Key`, `Insufficient balance`, `User not found` | **no — thrown as ambiguous** |

The SDK (`node_modules/africastalking/lib/sms.js`) makes this worse: on any
non-201 it rejects with the axios error, so a 401 never even reaches the response
parser — it lands in the `catch` and was flattened to `"Provider outcome unknown"`.

That classification is deliberate and correct for a *lost* response (never treat
an uncertain send as failed, or a retry bills twice). But it was being applied to
**permanent, deterministic misconfiguration**, producing exactly the state in the
production dump: `pending`, `failure_reason: null`, then `unknown` after 48 h,
with nothing anywhere to explain it.

`classifyProviderFailure()` now recognises only unambiguous "we did not accept
this" reasons — bad key, bad username, insufficient balance, unregistered sender,
invalid number, suspended account — from all three shapes the SDK can reject with
(axios `error.response.data`, a raw body on 2xx-not-201, and the SDK's local Joi
phone validation). Anything unrecognised still throws, so an uncertain outcome is
still never turned into a failure.

Consequence worth knowing: a permanent error now lands in `failed` with
`failure_reason` like `Provider rejected SMS: InvalidApiKey: Invalid API Key`,
which is both human-readable and greppable, instead of silently ageing to
`unknown`.

Two further causes are **configuration, not code**, and must be checked in the
deployment before anything else (see §6): the Africa's Talking delivery-report
callback URL, and `AFRICASTALKING_USERNAME` silently defaulting to `sandbox`.

---

## 2. What changed (gateway)

| File | Change | Risk |
|---|---|---|
| `src/lib/sms-policy.ts` | `applicationCode` is trimmed in the schema; new `applicationCodeMatches()`; new `smsNotifyUnknownEnabled()` | none — widening only |
| `src/app/api/messaging/send/route.ts` | Uses the normalised comparison; the 403 now names the expected code | none |
| `src/app/api/messaging/quick-send/route.ts` | Exact lookup first, then a case-insensitive retry | none — one extra query only on the miss path |
| `src/lib/sms.ts` | Provider's own status returned as `providerStatus`; account-level failures classified instead of discarded; one-shot sandbox warning in production | additive |
| `src/lib/sms-store.ts` | `failExplicitly(id, reason?)` stores the real reason; `getPendingTerminalNotifications()` can include `unknown` | additive; old call shape still valid |
| `src/lib/sms-queue.ts` | Passes the real reason; `unknown` notifiable only when the flag is on | default behaviour unchanged |
| `src/app/api/messaging/dashboard/route.ts` | Returns `attemptCount`, `providerMessageId`, `failureReason` | additive |
| `src/app/messaging/page.tsx` | New "Detail" column showing the reason | presentation only |
| `src/app/api/messaging/sms/[reference]/route.ts` | **New** partner status endpoint | new surface, API-key scoped |
| `src/lib/recipient-mask.ts` | Masking extracted so both surfaces share it | none |
| `src/middleware.ts` | `api/messaging/sms/` exempted from the session gate | see below |

### The middleware entry is load-bearing

The new endpoint authenticates with a partner API key, exactly like
`api/messaging/send`. Without the exemption the Supabase session gate answers
first with an HTML redirect, and the partner receives a login page instead of
JSON — the same failure that produced a permanent 401 on the Africa's Talking
delivery-report route for weeks. The entry carries a trailing slash so a future
`/api/messaging/sms-admin` cannot inherit the exemption. A test asserts both
directions.

### Deliberately NOT changed

* `src/lib/application-auth.ts` — `findApplicationByApiKey(key, { code })` is
  used by the **payment intent handler**. Making that filter case-insensitive
  would widen payment lookups for no SMS benefit. The SMS route calls it without
  a code filter, so it needs no change. **The payment path is untouched by this
  PR.**
* The church application's `baseUrl` / `webhookPath`. See §5.

---

## 3. Verification

```
npm test        366 tests, 366 pass, 0 fail      (325 before, +41 new)
npx eslint      clean on every changed file
npx tsc --noEmit 12 errors, all pre-existing in src/lib/data.ts
```

Two suites, deliberately different in kind.

**`tests/sms-partner-flow.test.ts` (25)** — each module in isolation: the code
comparison, the 403 body, the rejection reason, the `unknown` flag, masking, and
every Africa's Talking failure shape (account-level, axios, raw body, SDK-local
phone rejection, and the three that must *stay* ambiguous).

**`tests/sms-paths-e2e.test.ts` (16)** — the modules **chained**, because that is
a different claim: the names one module writes are the names the next one reads.
It drives the real `POST /api/messaging/send` → real `smsStore.createOrGet` →
real `smsQueue.processBatch` → real Africa's Talking DLR route → real
`deliverSmsNotification` → real `GET /api/messaging/sms/:reference`. Only the
database, the socket and the AT SDK are replaced; **HMAC signing is the shipped
code**, and a test verifies the emitted notification with the documented receiver
algorithm (plus wrong secret, tampered body and replayed timestamp, each of which
must fail).

What that surfaces that units cannot:

| Assertion | Why it matters |
|---|---|
| submit → send → DLR → notify → read, one reference end to end | the reference the partner joins on is the reference we gave it |
| the 403 creates **no row** | the actual reason the messaging dashboard was empty — nothing to diagnose |
| a duplicate DLR cannot rewrite a terminal row | first terminal report wins; the partner is not told twice |
| a forged DLR is 401 and leaves the row `pending` | an unauthenticated caller cannot settle a message |
| a partner 500 leaves `notificationDeliveredAt` null | delivery is not claimed when it was not acknowledged |
| a provider rejection notifies on the **cron tick**, not inline | `processBatch` never blocks on a partner endpoint |
| `CHURCH` / `Church` / `"  church  "` all resolve in **quick-send** | the dashboard path, which 404'd before the fallback |
| `unknown` is silent by default and notifies when opted in | the flag behaves at both ends of the chain |
| daily ceiling returns 429 + `Retry-After` and creates no row | the refusal does not poison the next send |
| `smsId` handed out at submit is byte-identical to the one the webhook repeats, and is never the `reference` | the required `(reference, smsId)` match cannot fail on a contract mismatch |
| an idempotent retry returns the **same** `smsId` and `reference` | the pair a webhook matches on stays unique per message |

**Live server check** (`next dev`, real HTTP, no database): the middleware
exemption was proven on the wire rather than inferred from a regex —

```
GET  /api/messaging/sms/ANY       401 {"error":"Invalid or missing API key"}   ← the route answered
GET  /api/messaging/sms-admin     503 {"error":"Auth not configured"}          ← the session gate answered
GET  /api/messaging/dashboard     503 {"error":"Auth not configured"}          ← the session gate answered
GET  /api/messaging/sms-admin     503                                          ← prefix safety holds
POST /api/messaging/send (bad key) 401 {"error":"Invalid or missing API key"}
POST /api/qstash/sms-cron          401 {"error":"Unauthorized"}
```

The `sms-admin` / `dashboard` responses are the Supabase gate failing closed in
this sandbox (no auth env), which is the proof that the gate *ran* on those paths
and not on the exempted one. A DB outage on the send route also returned 401:
it fails closed, it does not fail open.

The `src/lib/data.ts` errors and the `next build` type-check failure are
environmental: `prisma generate` cannot download its engine in this sandbox. They
are identical with these changes stashed (`git stash` → still 12). Webpack
compiles the new route successfully.

---

## 4. Verified contract (for the receiver)

### Headers on every outbound notification

```
Content-Type:            application/json
X-Najiki-Notification:   true
X-Najiki-Timestamp:      <ms since epoch>
X-Najiki-Signature:      t=<timestamp>,v=<hex hmac>
```

`v = HMAC-SHA256(secret, "<timestamp>.<raw request body bytes>")`. The secret is
**never** sent as a header. Verify the raw bytes you received, then parse:

```ts
const raw = await req.text()
const ts  = req.headers.get('x-najiki-timestamp')
const sig = req.headers.get('x-najiki-signature')
if (!ts || !sig) return new Response('Unauthorized', { status: 401 })
if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return new Response('Stale', { status: 401 })
const hex = await hmacHex(SECRET, `${ts}.${raw}`)
if (sig !== `t=${ts},v=${hex}`) return new Response('Unauthorized', { status: 401 })
const body = JSON.parse(raw)
```

### Three payload shapes arrive at the same URL

| Event | Discriminator | Shape |
|---|---|---|
| Payment | **no `eventType` field** | `paymentIntentId, reference, status, amount, currency, providerPaymentId, failureReason, externalEntityId, tenantId, tenantCode, paymentType, paymentTypeCode, metadata` |
| SMS | `eventType === 'SMS_DELIVERY_UPDATE'` | `eventType, smsId, reference, status, providerId, recipient, applicationCode` |
| Self-test | `test === true` | `event, test, applicationCode, deliveryId, sentAt, signatureVersion, note` |

`status` for SMS is only ever **`delivered`** or **`failed`** — `deliverSmsNotification`
returns early for anything else — plus `unknown` if `SMS_NOTIFY_UNKNOWN=true`.
Match on the **lower-case** value; `reference` is the only join key back to your
own row (never the `sms` queue id).

The Setup self-test sends the payment-shaped `test` payload. It proves URL,
signature and reachability; it does **not** exercise the SMS branch. Only a real
terminal SMS does that.

### Limits (verified in source)

| Limit | Value |
|---|---|
| Per API key | 60 / minute |
| Per source IP | 120 / minute |
| Per application per UTC day | 10,000 (`SMS_DAILY_LIMIT_PER_APP`) |
| `Idempotency-Key` | 8–255 chars, unique per application |
| Send timeout | 8 s (`safeFetch` default) |
| SMS notification retries | every minute, **max 10 per run, no attempt cap** |

The retry line is the one that shapes the design: a partner endpoint that is
unreachable produces a backlog that drains at 10/minute. Be reachable, not merely
correct.

---

## 5. Deployment order

1. **Africa's Talking dashboard — delivery-report callback.**
   `https://<gateway>/api/webhooks/africastalking?key=<AFRICASTALKING_CALLBACK_SECRET>`
   Until this answers, every message ages `pending → unknown` and nothing notifies.
2. **Netlify env:** `AFRICASTALKING_API_KEY`, `AFRICASTALKING_USERNAME` (production
   app, **not `sandbox`**), `AFRICASTALKING_SENDER_ID` (approved).
3. **`ENFORCE_REDIS_RATELIMIT=true`** before any volume: the limiter fails open to
   per-instance memory when Upstash is slow, which multiplies the published limit
   by the warm-instance count.
4. **Deploy this change.** Verify with one send from `/messaging` — the new
   "Detail" column should say `accepted · 1×` (provider reached) or
   `not reached · 1×` (credentials). That single column separates the two
   remaining failure domains.
5. **Partner send path:** `POST /api/messaging/send` with `applicationCode: "church"`
   (or omit it). Expect 202, not 403.
6. **Partner status path:** `GET /api/messaging/sms/<reference>` with the church
   API key.
7. **SMS webhook forwarding (Vercel-first)** — last, and only after a real SMS has
   reached a terminal state.

Step 7 is deliberately last and deliberately does **not** change the church
application's URL. `deliverNotificationRow` re-resolves the webhook URL from the
live application row on every retry, so the moment that field is saved, queued
**payment** retries redirect too. The proven path

```
LivePay → Na'jiki → churchsys-ten.vercel.app  {"received":true,"settlement":"credited"}
```

stays exactly as it is — that is the money path that works today.

---

## 6. What remains on the partner side (not in this repository)

### 6.1 Vercel: forward SMS events only

```ts
// churchsys-ten.vercel.app/api/webhooks/najiki — inside the existing handler,
// AFTER the signature has already been verified.
if (body?.eventType === 'SMS_DELIVERY_UPDATE') {
  try {
    const newTs = Date.now().toString()
    const v = await hmacHex(NAJIKI_WEBHOOK_SECRET, `${newTs}.${rawBody}`)   // re-sign: the
    const res = await fetch(`${SUPABASE_URL}/functions/v1/najiki-webhook`, { // original t=
      method: 'POST',                                                       // expires in 5 min
      headers: {
        'content-type': 'application/json',
        'x-najiki-timestamp': newTs,
        'x-najiki-signature': `t=${newTs},v=${v}`,
        'x-najiki-notification': 'true',
      },
      body: rawBody,
    })
    if (!res.ok) return new Response('forward failed', { status: 502 })     // → Na'jiki retries
  } catch {
    return new Response('forward failed', { status: 502 })
  }
  return Response.json({ received: true })
}
// …payment handling continues untouched
```

Isolate the branch in its own `try/catch` so a forward error can never fail a
payment. Before deploying, check what the endpoint currently returns for
`SMS_DELIVERY_UPDATE`: if it is already 4xx/5xx, those rows are retrying today and
will start succeeding.

### 6.2 Supabase: the edge function

`verify_jwt = false` plus the HMAC check in §4. Then:

```ts
if (body.test === true) return Response.json({ received: true, test: true })
if (body.eventType !== 'SMS_DELIVERY_UPDATE') return Response.json({ received: true, ignored: true })

const status = String(body.status ?? '').toLowerCase()
if (status !== 'delivered' && status !== 'failed' && status !== 'unknown') {
  return Response.json({ received: true, ignored: status })     // never guess
}

// Final-state guard + idempotency in one statement.
await sql`
  UPDATE church.sms_queue q
     SET delivery_status      = ${status},
         delivery_provider_id = ${body.providerId ?? null},
         delivery_updated_at  = now()
   WHERE q.najiki_reference  = ${body.reference}
     AND COALESCE(q.delivery_status, '') NOT IN ('delivered','failed')
`
return Response.json({ received: true })
```

Deliveries are **at-least-once**. The guard above is what stops a late or repeated
event from rewriting a terminal row.

### 6.3 Supabase: the broadcast outbox

Reuse `church.sms_queue`; do not build a second queue. Four requirements:

1. `idempotency_key = "<jobId>:<memberId>"` (8–255 chars, unique per application).
   A retried request returns `202 { deduplicated: true }` with the original
   `reference` instead of sending again — that is what prevents a double charge.
2. Store the returned `reference` and `smsId`. `SMS_DELIVERY_UPDATE` carries
   both, plus `eventType`, `status`, `providerId`, `recipient`, `applicationCode`.
   Your queue id never appears in the webhook, so `reference` is the join key.
3. Keep send state and delivery state in **separate columns**. One column cannot
   carry two state machines.
4. Stagger `scheduled_at` at insert (~50/minute) and add `broadcast_session_id` so
   a report can be produced per broadcast. Pre-check the wallet covers the whole
   job before enqueuing.

#### Required DDL (against the **live** `church` schema)

The live `sms_queue.status` has a CHECK constraint allowing only
`pending, processing, sent, failed, cancelled`. It **cannot hold a delivery
outcome**, so the outcome needs its own column. Every statement below is
rerun-safe — the constraint is created inside a `DO` block because
`ADD CONSTRAINT` has no `IF NOT EXISTS`.

```sql
-- 1. Delivery outcome lives beside the send state, not inside it.
--    Two columns, not three: `notification_delivered_at` is deliberately NOT
--    added. On the Na'jiki side it records when the *partner* acknowledged a
--    notification — on the church side the church IS the partner, so nothing in
--    this integration would ever write it, and an always-null column invites
--    exactly the kind of false inference this document is trying to prevent.
ALTER TABLE church.sms_queue
  ADD COLUMN IF NOT EXISTS delivery_status     text,
  ADD COLUMN IF NOT EXISTS delivery_updated_at timestamptz;

-- 2. Re-runnable: ADD CONSTRAINT has no IF NOT EXISTS, so guard on the catalog.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname  = 'sms_queue_delivery_status_check'
       AND conrelid = 'church.sms_queue'::regclass
  ) THEN
    ALTER TABLE church.sms_queue
      ADD CONSTRAINT sms_queue_delivery_status_check
      CHECK (delivery_status IS NULL
             OR delivery_status IN ('delivered','failed','unknown'));
  END IF;
END
$$;
```

#### `najiki_reference` is not unique — check before relying on it

The proposed `UPDATE ... WHERE najiki_reference = $1` would touch **every**
matching row, and there is currently no unique index on that column. Report
first; do not remediate blind:

```sql
-- (a) Are there duplicates at all?
SELECT najiki_reference, count(*) AS rows, min(created_at), max(created_at)
  FROM church.sms_queue
 WHERE najiki_reference IS NOT NULL
 GROUP BY najiki_reference
HAVING count(*) > 1
 ORDER BY rows DESC;

-- (b) If yes, see what the duplicates are before choosing which row owns the outcome.
SELECT id, najiki_reference, najiki_sms_id, status, created_at
  FROM church.sms_queue q
 WHERE najiki_reference IN (
         SELECT najiki_reference FROM church.sms_queue
          WHERE najiki_reference IS NOT NULL
          GROUP BY najiki_reference HAVING count(*) > 1)
 ORDER BY najiki_reference, created_at;
```

Two plausible causes, with different repairs:

* **Reused reference after an idempotent retry.** Na'jiki returns the *original*
  `reference` with `202 { deduplicated: true }` — so if the dispatcher stored the
  returned reference on the retry row as well, two rows now share one reference.
  The fix is in the dispatcher (store the reference only on the row that minted
  it) and the duplicate attempt should be closed as `cancelled`, not deleted.
* **A genuine data error.** Keep the row whose `najiki_sms_id` matches, null the
  rest, then enforce uniqueness.

Only after (a) returns zero rows:

```sql
-- NULLs are distinct in Postgres, so rows that have not been dispatched yet are
-- unaffected. This makes the webhook's UPDATE unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS sms_queue_najiki_reference_key
  ON church.sms_queue (najiki_reference);
```

Until that index exists, the webhook `UPDATE` **must** match the `smsId` the
payload carries. It is a required predicate, not an optional one:

```sql
UPDATE church.sms_queue
   SET delivery_status        = $2,                    -- delivered | failed | unknown
       provider_message_id    = COALESCE($3, provider_message_id),
       last_error             = CASE WHEN $2 = 'failed' THEN $4 ELSE last_error END,
       delivery_updated_at    = CASE WHEN delivery_status IS DISTINCT FROM $2
                                     THEN now() ELSE delivery_updated_at END
 WHERE najiki_reference = $1
   AND najiki_sms_id    = $5                           -- $5 = body.smsId, REQUIRED
   AND COALESCE(delivery_status, '') NOT IN ('delivered','failed');
```

Three properties worth stating precisely:

* **`smsId` is required.** There is deliberately no `OR $5 IS NULL` fallback. A
  missing `smsId` in the payload is a contract violation, and falling back to
  reference-only matching would reintroduce exactly the multi-row hazard this is
  here to prevent. Reject the event and alert instead.
* **`delivery_updated_at` only advances when the value actually changes** — the
  `IS DISTINCT FROM` compares against the pre-update value — so a replayed event
  is a genuine no-op rather than a silent touch.
* **`unknown` is intentionally overwritable.** The terminal guard excludes only
  `delivered` and `failed`, so a late `delivered` can still correct an `unknown`.
  That mirrors Na'jiki's own rule (`applyDeliveryReport` accepts transitions from
  `pending` **or** `unknown`), so the two sides cannot disagree.

#### The caller must treat "not exactly one row" as an error

The `UPDATE` returning `0` or `>1` is a reconciliation case, **not** a success.
Check it explicitly rather than assuming:

```ts
const result = await sql`...the UPDATE above...`
if (result.count !== 1) {
  // 0  → the reference/smsId pair is unknown to this queue, or the row was
  //      already terminal (a replay). Distinguish before alerting: re-read the
  //      row and check delivery_status.
  // >1 → najiki_sms_id is not unique either. Stop, alert, do not guess.
  return Response.json({ received: true, reconciled: false, matched: result.count })
}
return Response.json({ received: true })
```

Returning **200** in the `0`/`>1` case keeps Na'jiki from retrying a logical error
ten times a minute forever; surface it in your own alerting instead.

#### What `smsId` actually is (and what your column must hold)

Verified in the gateway, because this is the one join key the whole webhook
depends on:

| Field | Source | Format | Example |
|---|---|---|---|
| `smsId` | `sms_messages.id`, minted by `newId()` (`src/lib/sms-store.ts:50`) | `sms_` + 20 lowercase hex | `sms_4d6f43b6ab43b4488ed6` |
| `reference` | `newReference()` (`src/lib/sms-store.ts:54`) | `MSG-<HEX>-<HEX>` | `MSG-1A186FB2774-8B94FA` |

The 202 response from `POST /api/messaging/send` returns **both**
(`smsId: smsRequest.id`, `reference: smsRequest.reference`), and the webhook
repeats both (`smsId: sms.id, reference: sms.reference` in
`src/lib/sms-queue.ts:116`) — the same `smsId` the caller was handed, so
`najiki_sms_id` must store **the 202 response's `smsId`**, not the `MSG-` reference.

Two traps:

* `sms_messages.id` is `@default(cuid())` in Prisma, but that default is never
  used — the application always supplies `newId()`. A row hand-inserted without
  an id would get a *cuid* instead, so match by exact equality, never by format.
* `smsId` and `reference` are not interchangeable. Storing the reference in
  `najiki_sms_id` makes every webhook fail the required predicate above.

#### Send state vs delivery state

Conflating these is how a broadcast report starts lying. They are different
questions with different repairs:

| What happened | `status` (yours) | `delivery_status` (new) |
|---|---|---|
| Na'jiki returned 202 | `sent` | `NULL` |
| Na'jiki `pending` (AT accepted) | `sent` | `NULL` |
| Na'jiki `delivered` | `sent` | `delivered` |
| Na'jiki `failed` (carrier rejected) | `sent` | `failed` |
| Na'jiki **403 / 401 / 429** — never dispatched | `failed` | `NULL` |
| Na'jiki `unknown` (no DLR in 48 h) | `sent` | `unknown` |

`status = 'failed'` means **our dispatcher could not get a 202** (wrong
`applicationCode`, bad key, rate limit, daily cap). `delivery_status = 'failed'`
means **the carrier rejected it** (e.g. `InvalidSenderId`). The first is an
integration fix, the second is a provider-account fix.

#### Cost caveat

`sms_messages.cost` has a database default of **0**, but `updateProviderCost()`
only overwrites rows sitting at the placeholder `50`:

```ts
// src/lib/sms-store.ts:368
where: { id, cost: SMS_COST_PLACEHOLDER },   // SMS_COST_PLACEHOLDER === 50
```

Any row inserted with the DB default (a script, a seed, a future code path that
omits the placeholder) therefore never receives the carrier's reported cost and
stays 0. Do not trust `SUM(cost)` over non-`delivered` rows, and treat aligning
the default with the placeholder as a separate fix.


---

## 6.4 How to check the claims in this document yourself

Every Na'jiki-side statement above is verifiable in the repository. Database
metadata alone cannot confirm them — the schema lives in `prisma/schema.prisma`,
and `@unique` is emitted as a bare `CREATE UNIQUE INDEX`, which is **invisible in
`information_schema.table_constraints`** (that view lists constraints only).

| Claim | Where |
|---|---|
| `sms_messages.reference` is unique | `prisma/schema.prisma:60` (`@unique`), `prisma/migrations/0_init/migration.sql:288` (`CREATE UNIQUE INDEX "sms_messages_reference_key"`) |
| `cost` DB default is 0 | `prisma/schema.prisma:70` |
| The real cost is only written over the placeholder 50 | `src/lib/sms-store.ts:48` and `:368` |
| Stale-pending threshold is 48 h | `src/lib/sms-store.ts:201` |
| The five statuses | `src/lib/sms-store.ts:19` |
| Account-level provider failures are classified | `src/lib/sms.ts:61` and `:77` |
| The application-code match is normalised | `src/lib/sms-policy.ts:70`, used at `src/app/api/messaging/send/route.ts:89` |
| The status endpoint's response fields | `src/app/api/messaging/sms/[reference]/route.ts:97–130` |
| `smsId` format (`sms_` + 20 hex) | `src/lib/sms-store.ts:50`; returned at `send/route.ts:163`, repeated at `sms-queue.ts:116` |
| No Prisma change on this branch | `git diff --stat main..HEAD -- prisma/` → empty |

Reproduce the test result rather than trusting the number:

```bash
npm ci && npm test        # 366 tests, 0 fail
npx eslint .              # clean
npx tsc --noEmit          # only the pre-existing src/lib/data.ts errors
```

For the live index question, `pg_indexes` is the right catalog:

```sql
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'sms_messages';
```


---

## 7. Still open

* `unknown` never closes a broadcast report unless `SMS_NOTIFY_UNKNOWN=true`.
* The SMS limiter fails open without `ENFORCE_REDIS_RATELIMIT=true`.
* `AFRICASTALKING_USERNAME` defaults to `sandbox` — a production deployment with
  the variable missing looks healthy and delivers nothing. This is a loud
  candidate for a boot-time guard; it was not added here because making it fatal
  could take the whole deployment (including payments) down on a config mistake.
* Refunding a wallet on `failed` is partner-side and depends on
  `reserve_sms_queue_debit` / `fail_sms_queue_item`, which are not in this
  repository. On the gateway side there is nothing to refund: it records cost, it
  does not hold a prepaid SMS balance.
