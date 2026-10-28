# Can this hold live money? — Church + SACCO go-live

**Date:** 2026-10-28 · **Branch:** `arena/0ee5b699-najiki-finance2`

---

## The short answer

**For collecting money: yes — after two fixes that are in this branch, and four
configuration steps that only you can do.** For *holding* customer money — balances,
payouts, refunds — **no. Do not use it that way.**

That distinction is not a dodge. It is how the system is built:

**This gateway never receives the money.** Each tenant has its own LivePay account number
and API key (`TenantProviderConfig.configJson`), and `collect-money` is called with
`accountNumber: <the tenant's account>`. The shillings land in the church's LivePay
account, not in an account this application controls. There is no payout endpoint, no
withdrawal path, and no way for this code to move money outward — by design.

What it does hold is a **shadow ledger**: `WalletAccount.balanceMinor` plus an immutable
`LedgerEntry` per collection. That ledger is a record of what this gateway collected. It
is **not** a custody balance and **not** an available-to-withdraw figure — see §4.

---

## 1. Two ways it would have lost money — found and fixed

Both are in the money path (`src/lib/payments.ts`), both are covered by new tests in
`tests/money-integrity.test.ts` (10 tests), and both would have shown up as *wrong money
in a wallet*, not as an error anyone notices.

### M-1 · A wallet could be credited twice for one payment

`completePayment()` incremented the wallet balance **before** writing the ledger entry,
and the ledger write was an `upsert { update: {} }`. So if the function ever ran twice for
the same intent — and the status guard that normally prevents that can be defeated, see
M-2, or by a restored backup, a manual status fix, or an older build still in rotation —
the second run incremented the balance again while the ledger entry silently did nothing.

Result: `balance` no longer equals the sum of its entries. The tenant is paid out more than
was ever collected, and the only thing that catches it is the 15-minute drift alert, after
the fact.

Fixed: the ledger entry is now the gate. If `${paymentIntentId}:payment_in` exists, the
balance is not touched. The entry is written with `create` (not `upsert`), so two genuine
concurrent completions make the unique key reject the loser and roll back its increment
with the rest of its transaction.

> Test: *"a wallet can never be incremented without its ledger entry"* — seeded a wallet
> at 5,000 with its entry already present, completed the payment, asserted the balance is
> still 5,000. Failed before the fix (10,000), passes after.

### M-2 · The initiate response could overwrite a payment the callback had already settled

The classic callback race, and this code had it in two places:

1. `processPayment()` awaited the provider's `collect-money` response and then wrote
   `status: providerResponse.status` **unconditionally** — usually `"pending"`.
2. Its error branch wrote `"processing"` (or `"failed"`) **unconditionally** on timeout.

If the member approves on their phone while the initiate call is still open, the webhook
settles the payment (status `success`, wallet credited, partner notified) and then the
initiate response writes `pending` straight over it. The intent now claims a paid payment
is unpaid. The next webhook — or the 2-minute reconciler — completes it *again*, which is
exactly the path that produced M-1's double credit.

Fixed: both writes are `updateMany` guarded by `status: { notIn: ['success', 'failed'] }`,
the same guard `completePayment()` already used. A settled payment cannot be moved back.

> Tests: *"an initiate response cannot overwrite a payment the callback already settled"*
> and *"an ambiguous initiate failure cannot overwrite a settled payment either"*. Both
> failed before the fix (`success` became `pending` / `processing`), both pass after.

### What is unchanged

No schema change, no API change, no behaviour change on the happy path. The failures were
"writes that should not happen", so the fix removes writes rather than adding any. All 290
pre-existing tests still pass (300 total now).

---

## 2. The invariants that were already right

Verified by reading the code and by tests, not assumed:

| Invariant | Where | Evidence |
| --- | --- | --- |
| The provider's amount is checked against the stored intent; a mismatch is refused with 422 and recorded as `disputed` | `api/webhooks/[provider]/route.ts` | existing inbound tests |
| The **stored** amount is what gets credited — the provider's number is never used | same, "authoritative stored amount" | `webhook-inbound` |
| Currency is checked, case-insensitively, and normalised at the boundary | same + `money.ts` | `money.test.ts`, `currency-exponents.test.ts` |
| UGX has no minor unit — 5,000 UGX credits 5,000 minor units, not 500,000 | `money.ts` | *"a 5,000 UGX collection credits 5,000 minor units"* |
| Completing the same payment twice credits once | `payments.ts` | *"completing the same payment twice credits once"* |
| A failed payment credits nothing and writes no ledger entry | `payments.ts` | *"a failed payment credits nothing…"* |
| A payment already marked failed is never resurrected as a success | `payments.ts` | *"…never resurrected…"* |
| Payment creation requires an `Idempotency-Key` (min 8 chars), unique per application, with the `P2002` race handled | `schemas.ts`, `payment-intent-handler.ts` | `unit.test.ts` |
| LivePay inbound webhooks are HMAC-verified over URL + timestamp + sorted params, timing-safe, fail-closed | `providers/livepay.ts` | `webhook-inbound` (35) |
| Duplicate provider deliveries are deduped by `signatureHash` unique | `webhook_logs` | `webhook-dedupe.test.ts` |
| Partner notifications are signed, retried with backoff, and alerted when exhausted | `payments.ts`, `cron/alerts` | `webhook-outbound`, `webhook-ops` |
| Missed callbacks are recovered by polling `pending`/`processing` every 2 minutes, with the same amount/currency gates | `reconcile-payments.ts` | `cron-workers` |
| **Wallet drift is alerted on** — every 15 min the balances are recomputed from their entries | `cron/alerts` + `ledger.ts` | `ALERT_WALLET_DRIFT_WALLETS`, `cron-workers` |
| Payments stuck in `pending`/`processing` over an hour are alerted | `cron/alerts` | `ALERT_STUCK_PAYMENT_MINUTES` |
| "Simulate webhook" cannot be used in production: feature flag off by default (404), super-admin, non-terminal only, audit row | `api/webhooks/simulate` | `security-regressions` |
| Dashboard is fail-closed: no session ⇒ no access, auth outage ⇒ 503, not a bypass | `middleware.ts`, `auth.ts` | `security-regressions` |
| API keys are stored hashed; partner secrets encrypted (AES-256-GCM) and reveal-on-demand | `api-keys.ts`, `encryption.ts` | `api-keys.test.ts`, `setup-webhooks.test.ts` |

---

## 3. What is not in the system

These are not bugs — they are scope. Knowing them is what keeps a go-live calm.

- **No refunds, reversals, or chargebacks.** Money in only. If LivePay reverses a
  collection, nothing in this codebase notices: the intent stays `success` and the wallet
  stays credited. Reversals must be handled by your finance process, outside the gateway.
- **No payouts or withdrawals.** The ledger is credit-only — the only write anywhere is
  `direction: 'credit'`. There is no debit, payout or fee entry type in use.
- **No provider statement reconciliation.** The ledger knows only about payments that
  passed through *this* gateway. If the church's LivePay account also receives money from
  a different source, the ledger will not know.
- **Platform-fee payments are not credited to any wallet.** A payment whose type is a
  platform fee is deliberately excluded from the tenant wallet; nothing records platform
  revenue in the ledger. Count it from `payment_intents` instead.
- **A late success after a `failed` is refused** (deliberate, fail-closed). If a provider
  reports failure and then success, the payment stays failed and no money is credited —
  a human has to decide. See §6 for the procedure.
- **Only LivePay is implemented.** Other provider codes are refused at the boundary with
  the list of usable ones.

---

## 4. Read the wallet balance correctly

`WalletAccount.balanceMinor` is **money collected through this gateway, gross, ever** —
not money owed to the tenant and not money available to withdraw. Because there are no
debits in the ledger, it only ever grows.

Use it as: *"what has this tenant collected here"*. Do not use it as: *"what can we pay
out"*. If you start paying tenants out of it, the payout is invisible to this system and
the number stops meaning anything.

The control that makes the number trustworthy is `npm run ledger:reconcile` (and the
every-15-minutes version in the alerts worker): it recomputes every balance from its
entries and reports drift. Run it after the first payment today; it should print zero
drift.

---

## 5. Today's go-live checklist

Do these in order. 1–4 are configuration, 5–8 are verification.

1. **Environment.** `APP_ENCRYPTION_KEY` exactly 64 hex characters and *never* rotated
   casually (rotating it makes every stored webhook secret undecryptable — the dashboard
   will show `secret-undecryptable`), `NEXTAUTH_URL` the exact public HTTPS origin,
   `CRON_SECRET`, the QStash token + both signing keys, `ALERT_WEBHOOK_URL` pointing at a
   channel you will actually watch, and per-tenant LivePay credentials (API key, account
   number, webhook secret ≥16 chars, base URL).
2. **Database.** `npm run db:deploy` (no drift), point-in-time recovery/backups **on**,
   `npm run db:check`, and note that `DATABASE_URL` uses the pooler (6543) while
   `DIRECT_URL` uses 5432.
3. **Preflight.** `npm run webhook:preflight` — read-only; it checks the go-live blockers
   for both applications and does not send anything.
4. **Both apps in Setup.** For church *and* sacco: real `baseUrl` (not
   `*.yourdomain.com`), path `/api/webhooks/najiki`, a signing secret, then **Reveal →
   Copy** into the partner. Press **Send signed test** and **Send bad signature** on each
   (see `WEBHOOK-GO-LIVE-TEST-REPORT.md` §0b): you want `Accepted` + `Correctly refused`.
5. **One real payment per app, small amount** (e.g. UGX 500, real phone, real PIN). For
   each one confirm all four: intent `success`; a `payment_transactions` row; exactly one
   `ledger_entries` row with the right `amountMinor`; the partner received the signed
   notification and credited the member.
6. **`npm run ledger:reconcile`** — expect zero drift. Run it again after the first
   service.
7. **Prove the alerts work.** Point `ALERT_WEBHOOK_URL` at the channel, trigger a test
   alert, and confirm it arrives. An alert nobody receives is the same as no alert.
8. **Watch for the first hour:** `pending` older than 15 minutes, `failed_exhausted`
   notifications, 401s in the partner's logs (wrong secret), and wallet drift. The alerts
   worker reports all four.

## 6. If something looks wrong during the service

- **Money collected, partner not notified** — `internal_notifications` shows the row, its
  attempt count and the last response body. The retry worker runs every minute and re-sends
  the *real* notification; the **Send signed test** button in Setup sends a separate
  `webhook.test` event and does not replace it.
- **Member says they paid, gateway says `failed`** — do *not* edit the status by hand.
  Check the provider's dashboard for that reference first. If the provider confirms
  success, that is a late-success-after-failure, which this system deliberately refuses;
  the safe correction is a new intent with the provider's transaction id in `metadata`,
  not mutating the old one.
- **Wallet balance looks too high** — `npm run ledger:reconcile` names the wallet, the
  stored balance, the ledger sum and the drift. Do not "fix" the balance by editing it;
  the entries are the truth.
- **Provider says the signature is wrong** — Setup shows the secret and the two test
  buttons; a `signature-rejected` result means the partner has a different value.

**Rollback.** Reverting this deploy is safe for data (every write is additive and
idempotent), but reverting past `083b49d`-era builds **reintroduces M-1 and M-2**. Prefer
rolling forward.

---

## 7. Honest limits of this review

- **No database was available.** Everything above was verified by reading the code and by
  tests against an in-memory Prisma stand-in. The optimistic wallet lock
  (`update where {id, version}`) and the `$transaction` boundaries have not been executed
  against Postgres in this environment. The one-real-payment step in §5 is what exercises
  them; do not skip it.
- **Nothing here is a penetration test of the new deployment.** The existing reports
  (`PENETRATION-TEST-REPORT.md`, `SECURITY-RETEST-2026-10-17.md`) cover the code as it was,
  and the security regressions they found are covered by tests.
- **Infrastructure is out of scope**: backups, PITR, TLS, WAF, secrets management, log
  retention and access control on the database console are yours to confirm. They matter
  more than any single line of this codebase.
- **Concurrency was tested deterministically, not under load.** The guards are
  compare-and-set, which is the right shape, but nobody has hammered the live endpoint with
  parallel callbacks for the same intent. Do that once in staging if you can.

---

## Verification

```
npm test       300 tests, 300 pass, 0 fail   (10 new money-integrity tests)
npx eslint .   clean
tsc --noEmit   clean except 12 pre-existing errors in src/lib/data.ts
               (Prisma client cannot be generated in this sandbox; no file
               touched here is affected)
```
