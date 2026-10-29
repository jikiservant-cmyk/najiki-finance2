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
| `src/lib/sms.ts` | Provider's own status returned as `providerStatus` | additive field |
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
npm test        343 tests, 343 pass, 0 fail      (325 before, +18 new)
npx eslint      clean on every changed file
npx tsc --noEmit 12 errors, all pre-existing in src/lib/data.ts
```

The `src/lib/data.ts` errors and the `next build` type-check failure are
environmental: `prisma generate` cannot download its engine in this sandbox. They
are identical with these changes stashed (`git stash` → still 12). Webpack
compiles the new route successfully.

`tests/sms-partner-flow.test.ts` covers, driving the **real** route handlers:

* `CHURCH`, `Church`, ` church `, `CHURCH\n` all queue (202) and are billed to the
  stored code; `sacco` is still 403 **and the error names `church`**;
* omitted `applicationCode` still works; an unknown API key is still 401 and never
  reaches the code check;
* status read: own reference 200, another application's reference **404 not 403**,
  missing key 401, delivery report and partner-acknowledgement surfaced, recipient
  masked;
* the provider's status word survives `sendSmsViaProvider` → `failExplicitly`
  → `failure_reason`, and `processBatch` keeps its exact return shape;
* `unknown` notifications off by default, on with `SMS_NOTIFY_UNKNOWN=true`,
  while `delivered`/`failed` are unaffected.

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
   `reference`, never your queue id.
3. Keep send state (`pending/processing/sent/failed`) and delivery state
   (`delivery_status`) in **separate columns**. One column cannot carry two state
   machines.
4. Stagger `scheduled_at` at insert (~50/minute) and add `broadcast_session_id` so
   a report can be produced per broadcast. Pre-check the wallet covers the whole
   job before enqueuing.

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
