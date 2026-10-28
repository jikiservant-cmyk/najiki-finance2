# Webhook go-live report — Church app

**Updated:** 2026-10-28 · **Branch:** `arena/0ee5b699-najiki-finance2`

Round 1 tested every webhook in both directions. Round 2 fixed the three warnings that came
out of it and verified the QStash cron control plane. Round 3 added the missing dashboard
interface, so the Church app's endpoints and signing secret can be configured and copied
without a terminal.

```
npm test       275 tests, 275 pass, 0 fail
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
  never included in the list payload. **Create / Rotate secret** issues a new one and shows it
  once. The rotation also returns the new API key rather than silently invalidating it.
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
