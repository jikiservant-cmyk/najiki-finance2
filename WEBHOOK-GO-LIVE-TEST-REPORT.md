# Webhook go-live test report — Church app

**Date:** 2026-10-28 · **Branch:** `arena/0ee5b699-najiki-finance2` · **Scope:** every webhook that touches the Church app, in both directions.

Nothing in `src/` was changed. The work in this branch is **test + verification only**: two new test suites, a read-only preflight script, and this report. No route, provider, schema or config file was modified.

---

## 1. What runs, and what I tested

There are four webhook surfaces, and all four were exercised:

| # | Direction | Endpoint | Tested by |
| --- | --- | --- | --- |
| 1 | **Inbound** — LivePay → this gateway | `POST /api/webhooks/livepay` (served by `src/app/api/webhooks/[provider]/route.ts`) | `tests/webhook-inbound.test.ts` (34 tests) |
| 2 | **Outbound** — this gateway → Church app | `POST {church baseUrl}{webhookPath}` (normally `/api/webhooks/najiki`) via `src/lib/payments.ts` | `tests/webhook-outbound.test.ts` (12 tests) |
| 3 | **Inbound** — Africa's Talking → this gateway (SMS receipts) | `POST /api/webhooks/africastalking` (also `/api/messaging/callback`) | `tests/webhook-inbound.test.ts` |
| 4 | **Admin diagnostics** (read-only) | `GET /api/webhooks` | reachability assertions |

**How they are tested.** The suites load the *real* source modules — the real route handler, the real LivePay HMAC verifier, the real idempotency hash/dedupe logic, the real body-size limiter, the real signature-URL candidate builder, the real SSRF guard, and the real outbound delivery/retry code. Only Prisma (an in-memory fake with the same semantics, including the `signatureHash` unique constraint) and the socket destination are substituted. For the outbound hop a **real HTTP server** runs inside the test, implementing the church's side of the contract independently, so a divergence between what we send and what a partner is told to verify fails the test.

```
tests/helpers/fake-db.ts        in-memory Prisma stand-in
tests/helpers/ts-load.ts        loads real repo modules with per-import stubs
tests/webhook-inbound.test.ts   hop 1 + Africa's Talking + reachability
tests/webhook-outbound.test.ts  hop 2, against a real HTTP verifier
scripts/webhook-preflight.ts    read-only launch check (npm run webhook:preflight)
```

## 2. Result

```
npm test   →  227 tests, 227 pass, 0 fail   (181 pre-existing + 46 new)
npx eslint .  →  clean
```

Plus a live smoke test against a booted dev server:

| Request | Result |
| --- | --- |
| `GET /api/webhooks/africastalking` | `200` — "Africa's Talking Webhook Active" |
| `POST /api/webhooks/africastalking` (no secret) | `401` — refused, fail-closed |
| `POST /api/webhooks/africastalking?key=<secret>` | reached the handler (500 here only because this sandbox has no database) |
| `POST /api/webhooks/livepay` | reached the handler — **not** blocked by the session middleware |
| `GET /api/webhooks` (no session) | `503`/`401` — correctly gated |
| `GET /dashboard` (no session) | `307` → `/login` |

## 3. Verified working

**Inbound (LivePay → gateway)**

- A correctly signed delivery settles the tithe exactly once: intent → `success`, wallet credit path invoked with the **stored** amount and currency, one outbound notification queued, audit row `signatureValid: true, processed: true`.
- Retries are idempotent: the second identical delivery returns `{success: true, duplicate: true}`, no second settlement, no second church notification.
- An attempt that died half-way (`processed: false` left behind) is **resumed**, not written off as a duplicate — the payment still settles.
- Rejected, each with no settlement: missing signature, wrong secret, body tampered after signing, timestamp older than 5 minutes, replayed event, oversized body (413), unknown reference (404), missing reference (400), unimplemented provider such as `mtn`/`airtel`/`pesapal` (400), deactivated provider row (404).
- A forged delivery **does not poison the dedupe hash**: the audit row uses an `unverified:<uuid>` key, so the genuine webhook that follows still settles.
- A correctly signed body cannot move money: amount mismatch → `422` + `disputed` transaction; currency mismatch → `422` + `disputed`; a callback signed by provider A cannot settle a payment created on provider B → `409`.
- A tenant whose LivePay webhook secret does not match is settled only through an authenticated provider status poll (`verifiedViaProviderPoll`) — the unverified body is never trusted. A tenant with unusable credentials is refused rather than silently falling back to the platform account.
- The signature verifies against the **configured public origin**, so deliveries still work behind a reverse proxy that rewrites the host (the proxy header is not trusted in production).
- Both LivePay payload shapes are accepted: flat `/api/transaction-status` and the nested `data` envelope.
- Machine-to-machine paths (`/api/webhooks/…`, `/api/messaging/callback`, `/api/cron/…`, `/api/qstash/…`, `/api/payments`) are confirmed **outside** the Supabase session gate by testing the middleware matcher itself — this is the class of bug that previously 401'd every Africa's Talking receipt in production.

**Outbound (gateway → Church app)**

- The church's independent verifier accepts our signature: `X-Najiki-Signature: t=<ms>,v=<hex HMAC-SHA256(secret, "<ms>.<rawBody>")>` with a matching `X-Najiki-Timestamp`.
- The payload carries what the church needs to credit the right member: `reference`, `status`, `amount`, `currency`, `providerPaymentId`, `tenantId`, `tenantCode` (`grace-church`), `paymentType`/`paymentTypeCode` (`tithe`), `externalEntityId`, `failureReason`, `metadata`.
- No secret ever travels in a header; `X-Najiki-Notification: true` marks the sender.
- A captured delivery cannot be replayed later or with a modified body.
- `404`/`405` on the legacy `/api/internal/payment-completed` path **self-heals** to `/api/webhooks/najiki` and still delivers.
- `401` retries with the application API key (partners that verify with `NAJIKI_API_KEY`), `5xx` schedules a backoff retry (`failed_retrying`, `attemptCount`, `nextRetryAt`), and the cron retry path re-signs with a fresh timestamp.
- An unsafe stored URL (cloud metadata, loopback, private RFC1918 ranges, placeholder domains) is refused with **no outbound request**.

## 4. Before the service — check these five things

These are configuration items, not code defects, but any one of them silently stops the church from receiving webhooks. Run `npm run webhook:preflight` against production to check all of them at once (read-only: no writes, no outbound requests).

**B-1 · The church `baseUrl` must not be the seeded placeholder.**
`scripts/seed.ts` writes `https://church.yourdomain.com` with path `/api/internal/payment-completed`. `validateSafeUrl()` refuses placeholder domains, so every notification is marked `failed_exhausted` and **never retried** — and nothing is sent to the church at all. Set the real host in `/setup`. (Test: *"an unconfigured placeholder URL is refused permanently"*.)

**B-2 · Point `webhookPath` at `/api/webhooks/najiki`.**
The legacy path is only healed when the partner answers `404`/`405`. If the church's deployment answers `200` there (a catch-all route, a marketing page), the event is recorded as delivered while the church stored nothing. Set it explicitly rather than relying on the heal.

**B-3 · `APP_ENCRYPTION_KEY` must be exactly 64 hex characters.**
Without it `webhookSecretFromRow()` returns `null` and `buildNotificationHeaders()` sends **unsigned** notifications. The church would then have no way to verify anything we send. Confirm it in the production environment (not just `.env.example`).

**B-4 · `LIVEPAY_WEBHOOK_SECRET` must be ≥16 chars and match the LivePay portal.**
The verifier fails closed on a short or missing secret. Note that for a tenant collection the **tenant's** stored `Webhook Secret` is what must match the portal — a platform-level secret does not verify tenant traffic. A mismatch is survivable only via the provider-poll fallback, which needs valid tenant `apiKey`/`accountNo`.

**B-5 · `NEXTAUTH_URL` must be the exact public HTTPS origin.**
The signed string starts with the URL LivePay was given at initiation, and our candidate list is built from `NEXTAUTH_URL`. If it differs from the observed origin (`http://` vs `https://`, `www` vs apex, trailing path), every inbound signature fails and the payment only survives through the provider-poll fallback.

## 5. Warnings — will work, but know about them

- **W-1 · Inbound rate limit is 120 requests/minute per source IP.** A Sunday giving spike that produces hundreds of settlements in one minute from LivePay's egress IPs will start returning `429`. LivePay retries at-least-once, so nothing is lost, but settlements arrive late. If the church expects mass giving, raise `tokens` in `src/app/api/webhooks/[provider]/route.ts` (line ~60) before launch.
- **W-2 · The retry worker is scheduled once a day.** `vercel.json` sets `/api/cron/notifications` to `0 5 * * *`, while the route's own documentation says "every minute" and the backoff (30s → 2m → 8m → 32m) is designed for that. A transient church outage is therefore recovered the next morning, not in 30 seconds. Change to `* * * * *` (needs a Vercel Pro plan) or accept the delay.
- **W-3 · The SSRF guard does not recognise bracketed IPv6 literals.** `new URL('http://[::1]/x').hostname` is `'[::1]'`, and `net.isIP('[::1]')` is `0`, so the literal check is skipped and DNS failure is tolerated — `http://[::1]/`, `http://[::ffff:169.254.169.254]/` and `http://[fd00::1]/` are accepted. Exposure is limited: webhook URLs are only settable by a super admin. The fix is one line in `src/lib/safe-fetch.ts` (`const host = hostname.replace(/^\[|\]$/g, '')` before `net.isIP`); I did **not** apply it, to keep this change test-only — say the word and I will.
- **W-4 · Outbound delivery is synchronous inside the inbound request.** Each attempt has a 10 s timeout, and a heal or fallback doubles the attempts. A slow church endpoint therefore delays the acknowledgement LivePay waits for; LivePay retries, and idempotency + resume make that safe, but a persistently slow church will generate retry traffic.
- **W-5 · Malformed JSON inbound returns `401`, not `400`.** The verifier parses the body before it can compute the HMAC, so a malformed body fails closed as an invalid signature. Intentional behaviour, documented here so it is not mistaken for a bug during incident triage.

## 6. What the Church app must implement

So it can be handed to the church team verbatim:

```
POST {NAJIKI_GATEWAY}/api/webhooks/najiki
Content-Type: application/json
X-Najiki-Notification: true
X-Najiki-Timestamp: 1761600000000
X-Najiki-Signature:  t=1761600000000,v=<hex>

signing string = "<X-Najiki-Timestamp>." + <exact raw request body>
signature      = HMAC-SHA256(key = NAJIKI_WEBHOOK_SECRET, message = signing string), hex
```

Verify with a constant-time compare, reject timestamps beyond ±5 minutes, and reply `2xx` quickly. Reply `401` only when the signature genuinely does not match — a `401` makes the gateway retry with the application API key, and a `5xx` schedules a backoff retry. Reply before doing slow work: anything above 10 s is a timeout on our side.

Body:

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

## 7. Honest limits of this run

- **No production database and no real LivePay call.** This sandbox has no Postgres and cannot reach `livepay.me`, so settlement maths were exercised through the route's contract (authoritative amount/currency, idempotent transitions) rather than against real rows. The Prisma engine binary could not be downloaded here, which also means `npm run build` / `prisma generate` could not be run; `tsc --noEmit` reports 12 pre-existing errors, all in `src/lib/data.ts`, all caused by that ungenerated client — none in the files touched here.
- **The real church endpoint was not contacted.** Delivering to it before launch would create a real settlement event on the church's side, which is exactly the kind of "break something" this run was told to avoid. The outbound tests use a local server that implements the church's verifier instead.
- **The first real signal is a small live payment.** Recommended order: run `npm run webhook:preflight`, fix anything it flags, then take one minimum-value tithe through LivePay and watch `GET /api/webhooks` (`hop1_livepayToNajiki` → `hop2_najikiToPartnerApps`) for a `200` and `deliveryStatus: "delivered"` before opening the service.
