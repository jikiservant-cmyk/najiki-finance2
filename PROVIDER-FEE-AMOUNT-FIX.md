# Provider fees: why UGX 17,510 was refused, and what changed

**Status:** fixed in code, verified by tests. Not yet deployed.
**Date:** 2026-10-28
**Evidence:** the user's live production payment, plus the LivePay merchant dashboard.

---

## 1. What actually happened

A real UGX 17,000 church payment (`CHURCH-ACC-82A982D1-E1121A6875`, tenant `sdfg`,
LivePay tx `c14be48a-3590-46af-af1d-3106c6aa1862`, 2026-10-28T13:18:29Z) took this path:

| Hop | Outcome |
| --- | --- |
| LivePay → `/api/webhooks/livepay` | arrived, `signatureValid: true`, `processed: true` |
| Amount gate | **rejected** — `AMOUNT_MISMATCH expected=17000 reported=17510`, recorded `disputed` |
| Ledger | untouched — no `payment_in` entry |
| Hop 2 → Church app | **never fired** — no `internal_notifications` row was ever created |
| Intent | stuck in `processing` |

Nothing was lost: the money reached the merchant account. What broke is that the
gateway **refused to acknowledge money it had actually received**, so the church's
books say the member never paid while his phone says he did.

### The number that explains it

```
we requested ................... UGX 17,000      (PaymentIntent.amount)
LivePay webhook ................ amount 17510, charge 510
LivePay dashboard "Revenue 7d" . UGX 17,510      (gross)
LivePay dashboard "Balance" .... UGX 17,000      (net = amount - charge)
```

510 is exactly 3 % of 17,000 — LivePay's Airtel collection fee, added on top of
what we asked for. The gateway compared the intent to the **gross** and ignored
`charge` completely (`charge` was not even parsed out of the payload).

The SACCO partner hit the identical bug on 22 Oct: `expected=5000 reported=5150`.

---

## 2. The two conventions LivePay uses

`charge` is not always inside `amount`. Two shapes exist in the wild:

| Shape | Payload | Meaning |
| --- | --- | --- |
| fee **inside** `amount` (production, 28 Oct) | `amount: 17510, charge: 510` | merchant nets 17,000 |
| fee **beside** `amount` (LivePay's documented flat payload) | `amount: 5000, charge: 150` | merchant nets 5,000 |

A fix that assumes only one of them would either keep refusing real payments or
start inventing fees. Both are honoured, and nothing else.

---

## 3. The rule now

`src/lib/provider-amount.ts` → `checkProviderAmount({ expected, reported, charge })`

```
ok  ⇔  reported === expected                 (GROSS convention, exact)
    ∨  reported - charge === expected        (NET convention, exact)
```

Explicitly **not** a tolerance band. Every one of these still fails:

* `expected 20,000 / reported 100` — the original attack this gate exists for
* `expected 20,000 / reported 19,999` — one shilling short is short
* `expected 17,000 / reported 17,510 / charge 100` — net 17,410, unexplained surplus
* `expected 17,000 / reported 17,510 / charge 1,510` — net 16,000
* `charge` negative or non-numeric — rejected, because a negative fee would make
  a small payment look like a large one
* `amount` non-numeric — rejected, never thrown

The ledger always credits the **intent amount**, never the provider's figure. LivePay's
fee is LivePay's income, not the partner's.

---

## 4. What changed (files)

| File | Change |
| --- | --- |
| `src/lib/provider-amount.ts` | **new** — the gross/net rule, plus `parseProviderCharge` |
| `src/lib/providers/types.ts` | `charge?: number` on `ParsedWebhook` and `PaymentStatusResponse` |
| `src/lib/providers/livepay.ts` | parses `charge` from both webhook shapes and from `/api/transaction-status` |
| `src/app/api/webhooks/[provider]/route.ts` | amount gate uses the rule; audit note records reported/charge/net |
| `src/lib/payment-security.ts` | `isConfirmedTerminalStatus` uses the rule — **this was the second half of the bug** |
| `src/lib/constants.ts` | `RECONCILE_MAX_AGE_DAYS` (default 30, clamped 1…180), `reconcileCreatedAfter()` |
| `src/lib/reconcile-payments.ts` | configurable window + `strandedBeyondWindow` count in the result |
| `src/app/api/cron/sync-payments/route.ts`, `src/app/api/qstash/cron/route.ts` | same window + `maxAgeDays` / `strandedBeyondWindow` in the response |
| `scripts/reconcile-payment.ts` | **new** — `npm run payments:repair`, one reference, dry-run by default |
| `.env.example` | documents `RECONCILE_MAX_AGE_DAYS` |
| `tests/provider-fee-amount.test.ts` | **new**, 13 tests |
| `tests/reconcile-window.test.ts` | **new**, 3 tests |

### Why the payment-security change matters as much as the webhook one

With only the webhook gate fixed, an already-refused payment still could not heal:
the status poll and the reconcile sweep used their own exact-gross comparison, so
LivePay's `17510` never confirmed against `17000` either. It would have sat in
`processing` forever. Both paths now use the same rule.

### Why the window change matters

Both cron routes looked back 7 days and the dashboard sweep 14. Anything older was
never polled again — that is exactly how intents from September were still
`processing` in October, with no signal anywhere. The window is now one env value
(default 30 days) and, critically, intents **outside** it are counted and returned
as `strandedBeyondWindow` instead of being silently skipped.

---

## 5. Deploying and repairing

1. **Deploy** this branch.
2. `GET /api/payments/CHURCH-ACC-82A982D1-E1121A6875` (or open the payment in the
   dashboard). This polls LivePay through the fixed gate; if LivePay reports the
   fee, the intent settles, the ledger is credited 17,000 and hop 2 is attempted.
3. If LivePay's status payload omits `charge` — so the poll cannot prove the net —
   the script refuses to move money and prints the evidence:

   ```bash
   npm run payments:repair -- --reference=CHURCH-ACC-82A982D1-E1121A6875
   ```

   After confirming 17,510 gross / 17,000 net in the LivePay portal:

   ```bash
   npm run payments:repair -- \
     --reference=CHURCH-ACC-82A982D1-E1121A6875 \
     --force --net-amount=17000 \
     --reason="LivePay portal: 17,510 gross, 17,000 available balance" \
     --apply
   ```

   `--force` requires `--net-amount` to equal the intent amount and a `--reason`;
   without `--apply` it only prints what it would do.

4. Same for `SACCO-ACC-64AA62AF-91945CE1CE` (5,000 / 5,150).
5. Drain the rest of the backlog deliberately:
   `RECONCILE_MAX_AGE_DAYS=120` then `GET /api/cron/sync-payments`, and watch
   `strandedBeyondWindow` in the response go to zero.

---

## 6. Verification

```
npm test                    325 / 325 pass   (309 before this change; 16 added)
npx eslint <changed files>  clean
npx tsc --noEmit            clean except the pre-existing src/lib/data.ts errors
                            (prisma generate cannot run in this sandbox)
```

The headline test drives the **real** webhook route with the real LivePay HMAC
verifier and the production numbers:

> `provider fee: a fee-bearing LivePay delivery SETTLES the 17,000 intent (production regression)`
> — `amount: 17510, charge: 510` → HTTP 200, `completePayment` called once with
> `status: 'success'` and `amount: 17000`, nothing recorded as `disputed`.

---

## 7. Still open (not fixed here)

* **`disputed` is overloaded.** An amount mismatch is recorded with the same status
  as a genuine chargeback-style dispute. It should be `amount_mismatch` so a real
  dispute is visible. Deferred because the dashboard surfaces the string today.
* **Hop 2 delivery.** 75 of 101 notifications have failed historically, including
  old `401 {"error":"Invalid signature"}` and `405` on legacy
  `/api/internal/payment-completed` URLs. That is a separate, larger piece of work:
  those partners must verify `X-Najiki-Signature` with the secret shown in Setup.
* **`getPaymentByReference` truncation.** LivePay reference queries are truncated
  to 30 characters (`checkPaymentStatus`); `CHURCH-ACC-82A982D1-E1121A6875` is 32.
  Harmless today (the `providerPaymentId` fallback covers it) but worth checking
  against a real status call.
