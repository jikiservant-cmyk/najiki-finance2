# Webhook go-live report — Church app

**Updated:** 2026-10-28 · **Branch:** `arena/0ee5b699-najiki-finance2`

Round 1 tested every webhook in both directions. Round 2 fixed the three warnings that came
out of it and verified the QStash cron control plane. Round 3 added the missing dashboard
interface, so the Church app's endpoints and signing secret can be configured and copied
without a terminal. Round 4 proves the secret works — by sending it a real request and a
deliberately forged one. Round 5 fixes credential rotation, which lost the new key.

```
npm test       309 tests, 309 pass, 0 fail
npx eslint .   clean
tsc --noEmit   clean (12 pre-existing errors in src/lib/data.ts — Prisma client
               cannot be generated in this sandbox; no file touched here is affected)
```

| Suite | Tests | What it covers |
| --- | --- | --- |
| `tests/webhook-inbound.test.ts` | 35 | LivePay → gateway, Africa's Talking receipts, reachability |
| `tests/webhook-outbound.test.ts` | 12 | gateway → Church app, against a real HTTP verifier |
| `tests/webhook-ops.test.ts` | 16 | rate limit, SSRF host normalisation, QStash schedules + signed publish |
| `tests/cron-workers.test.ts` | 16 | every worker endpoint: auth, retry, reconcile, stall detection |
| `tests/setup-webhooks.test.ts` | 15 | dashboard config: summary rules, edit, reveal, no secret leakage |
| `tests/webhook-secret-live.test.ts` | 15 | the signing secret against a real verifier, both ways, plus rotation |
| `tests/setup-rotation.test.ts` | 9 | API-key vs signing-secret rotation, and the copy/render fixes |
| rest (14 files) | 181 | pre-existing suites, unchanged |

---

## 0. Configuring the webhooks from the dashboard — new

The complaint was exact: the Setup page could **create** an application but not **edit** its
delivery endpoint, never showed the URL settlements are POSTed to, and had no way to read the
signing secret, so the values the partner needs lived only in a terminal. Worse, the page never
even displayed the webhook path it had stored.

**Setup → Applications now has, per application:**

- **The outbound webhook URL**, resolved exactly as the sender resolves it (`baseUrl` +
  `webhookPath`, including the legacy-path heal), with a **Copy** button.
- **Live validity, not a claim.** The same rules the sender and the preflight enforce are shown
  inline: a placeholder domain (`https://church.yourdomain.com`) is flagged **"Won't deliver"**
  because the outbound guard refuses it permanently; a missing or undecryptable signing secret is
  an error, because notifications would go out unsigned; plain HTTP and the legacy path are
  warnings. One module (`src/lib/application-webhook-status.ts`) now backs the page, the
  preflight script and the tests, so the dashboard cannot say "fine" about something that will
  not deliver.
- **The signing secret**, on demand: **Reveal → Copy**, decrypted for that single action and
  never included in the list payload. **Create / Rotate signing secret** issues a new one and
  shows it once, inline.
- **Edit endpoint**: `name`, `baseUrl`, `webhookPath`, `internalSecretRef`, `active` — saved
  through the `updateApplication` branch that already existed but had no UI calling it. The save
  reports back the URL that will actually be used.
- **The inbound URLs to give the providers** (new card at the top of the tab): the LivePay
  payment-status callback and the Africa's Talking delivery-report URL, built from
  `NEXTAUTH_URL` — the same origin the inbound signature is verified against. Copyable, and
  clearly showing "not configured" rather than a plausible-looking wrong URL.

**Two bugs found while wiring it, both fixed:**

1. **Every entity created from this page was stored `inactive`.** `Switch` is a Radix
   `role="switch"` *button*, which never participates in form submission, so
   `new FormData(form).get('isActive')` was always `null` → `false`. Applications, providers and
   tenants created through the UI were all deactivated, and the church app would have rejected
   every request until someone noticed the badge. The switches are controlled state now, and a
   source-level test keeps them that way.
2. **`updateApplication` echoed secrets back to the browser.** It returned the row without
   `omit`, so every edit sent the stored `apiKey` and the `webhookSecretEncrypted` blob to the
   client. It now omits both (and `create` no longer returns the key hash). `webhookPath` is also
   validated as a path, because `https://host/hook` in that field produced
   `https://hosthttps://host/hook` at send time.

### 0a · Rotating credentials without losing them

"I rotate the API key and I cannot copy it." Three separate causes, all now fixed:

1. **The new key rendered above the tabs.** The banner lives at the top of the page; the
   *Rotate* button is at the bottom of a card. On any normal screen the key appeared
   off-screen, so the button looked like it did nothing. Each rotation now renders **on the
   card that produced it** and is scrolled into view.
2. **Copy lied.** `copyToClipboard` was a bare `navigator.clipboard.writeText()` with an
   unconditional "Copied to clipboard!". That API is undefined outside a secure context and
   rejects when the document is not focused or the permission is denied — so on a plain-HTTP
   or proxied dashboard it reported success while copying nothing, for a value shown exactly
   once. It is now awaited, falls back to a hidden textarea + `execCommand('copy')`, and on
   failure says so and tells the operator to select the text and press Ctrl+C.
3. **Rotating the secret also rotated the API key.** `{ rotateWebhookSecret: true }` was
   treated as "rotate both", so fixing a signature problem issued a new key at the same
   moment and the partner began getting 401s on its own requests. The two are independent
   now, and the confirmation says which one is being replaced.

| Action | API key | Signing secret | Confirmation says |
| --- | --- | --- | --- |
| **Rotate API key** | replaced | untouched | "The webhook signing secret is NOT affected." |
| **Rotate signing secret** | untouched | replaced | "The API key is NOT affected." |
| `POST { type:'rotateApplication', id }` (old runbooks) | replaced | untouched | — |
| both flags set | replaced | replaced | — |
| both flags `false` | refused, `400` | refused | "Nothing to rotate" |

The last row matters: a typo in the body used to return `200` having changed nothing, and the
operator would then hand the partner a key that no longer existed.

The banner also advertised `Authorization: Bearer nk_...` while every key is `njk_...`.

**Tests:** `tests/setup-rotation.test.ts` (9). The server half is driven for real — a secret
rotation leaves the key hash untouched and the partner's key still verifies; a key rotation
leaves the stored secret byte-identical; the old `{ id }` shape still means "new key"; and
"rotate nothing" is a 400. The two rendering fixes are guarded at the source level, since this
runner has no browser.

---

## 0b. Does the signing secret actually work? — tested, and testable from the browser

A local "sign then verify with the same string" check is worthless here: it proves our code
agrees with itself. What breaks a go-live is the partner holding a **different** secret, or not
checking at all. Neither is visible from our side except by sending a request and reading the
answer.

So Setup → Applications → **Test the signing secret** now sends two real requests to the real
endpoint, and the pair is the test:

| Button | What it sends | Pass looks like |
| --- | --- | --- |
| **Send signed test** | `event: "webhook.test"`, signed with the stored secret | `2xx` — endpoint accepted a signature made with *this* secret |
| **Send bad signature** | same shape, signed with a key that is not this application's | `401`/`403` — the endpoint verifies |

Each result is classified, not just shown as a status code:

| Verdict | What it means |
| --- | --- |
| `accepted` | Secret and path are correct; the partner verified our HMAC |
| `rejected-as-expected` | Bad key refused — the verifier is live, so `accepted` means something |
| `signature-rejected` | Partner is verifying with a different secret (typo, stale copy, a rotation it never heard about) |
| `signature-not-checked` | **Bad key accepted.** The endpoint is not verifying: anyone with the URL can forge a success notification |
| `endpoint-missing` | 404/405 — wrong path, no verifier was reached |
| `rate-limited` / `endpoint-error` | Not a secret problem; the partner side is throttling or failing |
| `unreachable` / `blocked` | No socket, or refused by the placeholder/SSRF guard before one was opened |

The panel also prints the exact headers, body and a **copy curl**, so the same request can be
replayed or handed to the Church app's developer. The key itself is never in that output — the
signature is an HMAC over a timestamped body, not a credential.

### What was verified (`tests/webhook-secret-live.test.ts`, 15 tests)

Every case runs against a real HTTP server running an **independent** verifier written from the
published contract — no code shared with the gateway:

```
X-Najiki-Timestamp: <ms>
X-Najiki-Signature: t=<ms>,v=<hex hmac-sha256(secret, `${ms}.${rawBody}`)>
```

- a delivery signed with the secret the page **reveals** is accepted by that verifier, so "copy
  this into the Church app" is a true instruction, not an assumption;
- a **real settlement notification** from `payments.ts` verifies with the same revealed secret —
  the self-test signs exactly like production;
- a wrong key is refused, `signature-mismatch`, so the pass is real verification;
- an endpoint that returns 200 to a wrong key is reported as `signature-not-checked` and **fails**;
- a partner holding someone else's secret produces `signature-rejected` with the fix in the text;
- 404/405/429/500/503 are classified separately, and a placeholder host and a missing secret are
  refused before a socket is opened;
- **rotation revokes**: after "Rotate secret", a delivery signed with the previous secret is
  rejected by a verifier holding the new one.

### Testing it yourself, in a browser

1. Setup → Applications → Church app card.
2. Confirm the **Outbound webhook** line shows the real host (not `church.yourdomain.com`) and the
   card does not say *Won't deliver*.
3. Click **Send signed test**. `Accepted — HTTP 200` means the Church app took a correctly signed
   notification.
4. Click **Send bad signature**. `Correctly refused — HTTP 401` is the second half of the proof:
   the endpoint is actually checking.
5. Put the two together:
   - accepted + refused → **the secret works**;
   - accepted + accepted → it does not verify; do not go live;
   - refused + refused → the partner has a different secret. **Reveal → Copy** and paste it into
     their `NAJIKI_WEBHOOK_SECRET`, then repeat.
6. For a partner that is not deployed yet, point the base URL at any temporary endpoint that
   echoes requests (e.g. a webhook.site URL) and read the outcome: it will report `accepted` but
   its bad-signature twin will also be `accepted`, which is the correct reading — an echo service
   verifies nothing.

The Church app should ignore any delivery whose body has `event: "webhook.test"` — these carry no
`paymentIntentId` and must never credit anything. A minimal verifier for them:

```js
import crypto from 'crypto'

app.post('/api/webhooks/najiki', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = req.body.toString('utf8')          // the exact bytes, not re-serialised JSON
  const header = req.get('X-Najiki-Signature') || ''
  const m = /^t=(\d+),v=([0-9a-f]{64})$/.exec(header)
  if (!m) return res.status(401).json({ error: 'malformed signature' })
  if (Math.abs(Date.now() - Number(m[1])) > 5 * 60 * 1000)
    return res.status(401).json({ error: 'stale timestamp' })

  const expected = crypto.createHmac('sha256', process.env.NAJIKI_WEBHOOK_SECRET)
    .update(`${m[1]}.${raw}`).digest('hex')
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))
  if (!ok) return res.status(401).json({ error: 'bad signature' })

  const event = JSON.parse(raw)
  if (event.event === 'webhook.test' || event.test === true)
    return res.status(200).json({ received: true, test: true })   // nothing to credit

  // …credit the payment…
  res.status(200).json({ received: true })
})
```

---

## 1. The three warnings — fixed

### W-1 · Inbound rate limit was too tight for a Sunday ✅ fixed

`120 requests/min per source IP` was not survivable. Mobile-money providers deliver every
settlement from a small set of egress addresses, so a whole congregation shares one bucket:
a few hundred tithes inside one minute — or any Christmas/harvest spike — crossed it, the
provider got `429`, and the church's screens sat on "pending" until the retry landed.

- New `src/lib/webhook-rate-limit.ts`; the ceiling is now **600/min per IP**, tunable with
  `WEBHOOK_INBOUND_RATE_LIMIT_PER_MINUTE` and clamped to `60 … 60000` so a blank, zero,
  negative or absurd value degrades to *a* limit instead of removing the guard.
- Proven on a live dev server: 250 + 400 sequential deliveries from one IP → **zero 429s**
  (the old ceiling would have throttled from the 121st). Re-run with the limit forced to 60 →
  exactly **60 passed, 90 throttled**, so the guard is still wired and still tunable.
- Tests: a 300-payment burst is not throttled; the ceiling still fires when exceeded; blank
  and out-of-range configuration never disables it.

The signature remains the integrity control — this is only an availability guard, and it is
still checked before any write.

### W-2 · Retry worker was scheduled daily, not per minute ✅ fixed

`vercel.json` cannot carry a sub-daily cron on Vercel's Hobby plan, so QStash is what
actually makes retries happen. The setup script was the weak link: it **deleted each schedule
before recreating it**, so a failure or network blip between the two calls left a worker with
no schedule at all — silently, because the script only printed what it did.

- `scripts/setup-cron-schedules.ts` now **updates in place** (`schedules.create({ scheduleId })`),
  so there is no window without a schedule. Duplicates are collapsed *after* the canonical
  schedule exists; nothing is ever deleted first.
- New `--verify` mode: reports a missing, paused, drifted or duplicated schedule and **exits
  non-zero**. `--dry-run` still works. This is the command to run before go-live and after any
  deploy that changes a path.
- The schedule list moved to `src/lib/cron-jobs.ts` — one source of truth for the registrar,
  the preflight check and the tests (they were duplicated before, which is how a worker ends up
  registered at one cadence and documented at another).
- `npm run webhook:preflight` now asks QStash directly and reports any worker that is missing,
  paused, drifted or duplicated.
- **Detection if it still goes wrong:** `/api/cron/alerts` has a new
  `notification-worker-stalled` check — if a retry has been due for more than
  `ALERT_RETRY_WORKER_LAG_MINUTES` (default 15), it alerts with the exact command to fix it.
  Every other alert is derived from data the workers produce, so a stopped worker looked
  exactly like a quiet system; this one looks at the schedule's observable effect instead.

### W-3 · SSRF guard missed bracketed IPv6 literals ✅ fixed

`new URL('http://[::1]/x').hostname` is `'[::1]'` — brackets included — and `net.isIP('[::1]')`
is `0`, so the literal check never matched. Those URLs fell through to the DNS branch, where a
lookup failure is tolerated, and were accepted:

```
http://[::1]/                     ← loopback
http://[::ffff:169.254.169.254]/  ← cloud metadata
http://[fd00::1]/                 ← unique-local
http://[fe80::1%25eth0]/          ← link-local, with zone id
```

`normalizeHostForIpCheck()` in `src/lib/safe-fetch.ts` strips the brackets (and any `%zone`
suffix) before the check, putting them through the same private-range logic that already
refused their unbracketed forms. Public IPv6 literals still work, so a partner on IPv6 is
unaffected. Tested against ten refused spellings and one allowed.

---

## 2. QStash — what I found

You were right to ask. The schedules themselves were fine; the machinery around them was not.

| Finding | Severity | Status |
| --- | --- | --- |
| Setup script deleted a schedule before recreating it — a failure in between left no retry schedule, silently | **high** | fixed (in-place update) |
| No way to tell whether the schedules existed at all | high | fixed (`--verify`, preflight, stall alert) |
| Signed payloads were published with `publishJSON`, which re-serialises the body. The bytes QStash forwards are only identical to the signed ones while `JSON.stringify` keeps the same key order — the failure mode is a silent 401 at the church | **medium** | fixed (`publish` with the exact signed string) |
| `/api/cron/sync-payments` (the registered poller) omitted `fallbackWebhookSecrets`, so a church verifying with its `internalSecretRef` got no fallback | medium | fixed |
| `/api/qstash/cron` is a stale duplicate of `/api/cron/sync-payments`: not registered in any schedule, an older implementation (no platform-credential resolution, missing `paymentTypeCode` and fallback secrets). Confusing at 3am | low | patched for correctness, **left in place** — flagged rather than deleted, see "left alone" below |

Verified working, each driven through the real route handler:

- **all five workers refuse an unauthenticated call** (`401`) and accept `Authorization: Bearer
  <CRON_SECRET>`; live server check: 5/5 returned `401` unauthenticated;
- **`/api/cron/notifications`** retries a due webhook, reschedules a transient failure
  (`failed_retrying`), does not retry a permanent one, honours its time budget instead of being
  killed mid-run, and accepts both `GET` (Vercel) and `POST` (QStash);
- **`/api/cron/sync-payments`** resolves a stuck payment, notifies the church with the same
  payload shape as the live webhook path, leaves a mismatched amount unsettled, and stamps
  `lastPolledAt` so one payment cannot monopolise the batch;
- **`/api/cron/alerts`** reports the stalled retry worker and pushes the finding to
  `ALERT_WEBHOOK_URL`, not just the response body;
- **`/api/qstash/sms-cron`** and **`/api/cron/retention`** are authenticated and report what they did;
- **the registrar** creates all five at the right cadence, is a no-op when correct, repairs a
  drifted cron in place, resumes a paused schedule, collapses duplicates, and refuses to run
  without a token or a public origin.

Run this against production before you open the doors:

```bash
npx tsx scripts/setup-cron-schedules.ts --verify   # exit 0 = every worker is live
npm run webhook:preflight                          # includes the same check, plus config
```

---

## 3. Inbound (LivePay → gateway) — unchanged and still good

- Correctly signed delivery settles the tithe exactly once, with the **stored** amount and
  currency; retries return `{duplicate: true}` and never re-settle; a half-finished attempt is
  **resumed**.
- Rejected with no settlement: missing/wrong signature, tampered body, stale (>5 min) replay,
  oversized body (413), unknown reference (404), missing reference (400), unimplemented provider
  (400), deactivated provider (404).
- A forged delivery does not poison the dedupe hash — the genuine one that follows still settles.
- Signed-but-wrong amount → `422` + `disputed`; wrong currency → `422`; provider A cannot settle
  provider B's payment (`409`).
- A mismatched tenant secret settles only through an authenticated provider poll; unusable tenant
  credentials are refused rather than falling back to the platform account.
- Signature verifies against the configured public origin, so it works behind a proxy that
  rewrites the host.
- Africa's Talking receipts: URL secret, header secret or IP allow-list; wrong/absent secret
  `401`; production with nothing configured fails closed; "buffered" never changes a message's
  state.

## 4. Outbound (gateway → Church app) — unchanged and still good

- The church's independent verifier accepts our
  `X-Najiki-Signature: t=<ms>,v=<hex HMAC-SHA256(secret, "<ms>.<rawBody>")>`.
- Payload carries `reference`, `status`, `amount`, `currency`, `providerPaymentId`, `tenantId`,
  `tenantCode`, `paymentType`/`paymentTypeCode`, `externalEntityId`, `failureReason`, `metadata`.
- No secret in any header; replay and tampering rejected.
- Legacy `/api/internal/payment-completed` self-heals on 404/405; `401` retries with the API key;
  `5xx` schedules backoff.
- Placeholder, loopback, private-range and (now) bracketed-IPv6 targets are refused with no
  outbound request.

---

## 5. Still to check before the first service

These are configuration, not code. `npm run webhook:preflight` checks all of them at once
(read-only: no writes, no outbound webhook).

1. **Church `baseUrl` must not be the seeded placeholder.** `scripts/seed.ts` writes
   `https://church.yourdomain.com`; the SSRF guard refuses placeholder domains, so every
   notification is marked `failed_exhausted` and never retried. Set the real host in `/setup`.
2. **Point `webhookPath` at `/api/webhooks/najiki`.** The legacy path is only healed on
   404/405 — if the church answers `200` there, we record a delivery the church never stored.
3. **`APP_ENCRYPTION_KEY` = exactly 64 hex chars**, or notifications go out **unsigned**.
4. **`LIVEPAY_WEBHOOK_SECRET` ≥16 chars and matching the portal** — for tenant traffic it is the
   *tenant's* secret that must match.
5. **`NEXTAUTH_URL` = the exact public HTTPS origin** — it is the first element of the signed string.
   Setup → Applications now prints the inbound URLs it produces, so a mismatch is visible there.
6. **Press both test buttons on the Church app card** (see §0b). You are looking for
   `Accepted` from the signed test and `Correctly refused` from the bad-signature one. Two
   `Accepted`s mean the Church app does not verify, and that has to be fixed before the first
   settlement — not after.

## 6. Remaining warnings

- **W-4 · Outbound delivery is synchronous inside the inbound request.** Each attempt has a 10 s
  timeout, and a heal or fallback doubles the attempts, so a slow church endpoint delays the
  acknowledgement LivePay waits for. Idempotency makes the resulting retry safe, but a
  persistently slow church generates retry traffic.
- **W-5 · Malformed JSON inbound returns `401`, not `400`.** The verifier parses the body before
  it can compute the HMAC, so it fails closed as an invalid signature. Intentional.
- **W-6 · `/api/qstash/cron` is an unregistered duplicate** of `/api/cron/sync-payments`. I made it
  correct rather than removing it: deleting a live endpoint is the kind of change that should be
  a decision, not a side effect of a test run. It appears in no schedule. Say the word and I will
  delete it, or make it a re-export of the maintained one.

## 7. What the Church app must implement

```
POST {NAJIKI_GATEWAY}/api/webhooks/najiki
Content-Type: application/json
X-Najiki-Notification: true
X-Najiki-Timestamp: 1761600000000
X-Najiki-Signature:  t=1761600000000,v=<hex>

signing string = "<X-Najiki-Timestamp>." + <exact raw request body>
signature      = HMAC-SHA256(key = NAJIKI_WEBHOOK_SECRET, message = signing string), hex
```

Constant-time compare, reject timestamps beyond ±5 minutes, reply `2xx` quickly. Reply `401`
only when the signature genuinely does not match — that makes the gateway retry with the
application API key. Anything slower than 10 s is a timeout on our side.

```json
{
  "paymentIntentId": "pi_…", "reference": "CHURCH-0001",
  "status": "success", "amount": 20000, "currency": "UGX",
  "providerPaymentId": "LP_TX_9001", "failureReason": null,
  "externalEntityId": "member_42", "tenantId": "tenant_…",
  "tenantCode": "grace-church",
  "paymentType": "tithe", "paymentTypeCode": "tithe",
  "metadata": { "paymentTypeCode": "tithe" }
}
```

## 8. Honest limits of this run

- **No production database and no real LivePay call.** The Prisma engine could not be downloaded
  here, so `prisma generate` / `npm run build` could not run and settlement maths were exercised
  through the route's contract rather than against real rows.
- **The real church endpoint was not contacted.** Delivering before launch would create a real
  settlement event on the church's side. The outbound tests use a local server implementing the
  church's verifier instead.
- **QStash itself was faked, not called.** This sandbox can only reach GitHub and the npm
  registry, so `qstash.upstash.io` is unreachable. The schedule handling was verified against a
  fake that mirrors the QStash API surface (including `scheduleId` in-place update), plus the real
  `@upstash/qstash` types. **Running `--verify` against production is the step that closes this.**
- **Order for go-live:** `npm run webhook:preflight` → fix what it flags →
  `npx tsx scripts/setup-cron-schedules.ts --verify` → take one minimum-value tithe through
  LivePay → watch `GET /api/webhooks` (`hop1_livepayToNajiki` → `hop2_najikiToPartnerApps`) for a
  `200` and `deliveryStatus: "delivered"`.
