# Security re-test — Na'jiki Finance

**Date:** 2026-10-17
**Scope:** Current checkout of `arena/ef3370ad-najiki-finance2`, re-testing findings F1–F7 in [PENETRATION-TEST-REPORT.md](./PENETRATION-TEST-REPORT.md). Local, non-destructive code review, unit tests, mocked HTTP route checks and dependency audit only. **No deployed URL, real database, Supabase session, provider sandbox or production credentials were available.** “Pass” below means the tested local behavior, not a verified production deployment.

| Finding | Re-test result | Evidence and remaining limit |
| --- | --- | --- |
| **F1 — provider errors becoming terminal payment failures** | **Pass locally** | The adapter returns nonterminal `pending` for failed status queries and `processing` for ambiguous initiation failures; all three status consumers require `isConfirmedTerminalStatus`, which rejects `success: false` and mismatched returned amount/currency/provider ID. Mocked HTTP 503 and a later successful status pass in `tests/security-regressions.test.ts`. No database transition or genuine signed callback was tested. |
| **F2 — platform credential fallback for tenant payments** | **Pass by code/unit inspection** | `loadTenantProviderCredentials` requires a complete active tenant set; creation, inbound provider callback, both cron pollers and partner status polling all use it. `LivePayProvider` refuses an incomplete explicit tenant config instead of filling fields from platform environment values. Unit tests cover incomplete/legacy inputs. Disabling credentials after initiation requires operator restoration for reconciliation; no real provider or DB test was run. |
| **F3 — stale super-admin access after allowlist removal** | **Pass by code/unit inspection** | `requireSuperAdmin` checks `SUPER_ADMIN_EMAILS` on every request, including for existing DB roles; removed emails fail the pure-policy regression test. A real Supabase session and persisted role were not exercised. |
| **F4 — missing Supabase permits dev admin** | **Pass by code/unit inspection, conditional risk remains** | The bypass now requires `NODE_ENV=development` **and** `ALLOW_INSECURE_DEV_AUTH=true`; it is off by default and never enabled by the flag in production. A publicly exposed development instance with that flag remains unsafe by design. |
| **F5 — payment-status rate limiter fails open** | **Pass by code/unit inspection** | The route uses the shared limiter for IP and key, and the helper returns 503 when production Redis is missing or a check fails. A regression test covers missing production Redis. A real Upstash outage was not simulated. |
| **F6 — unbounded unauthenticated SMS callback body** | **Pass with mocked route** | A streamed ~20 KiB callback without `Content-Length` returned **413**. A small callback with a rejected secret returned **401**. The mocked route made **zero SMS database lookups** across both calls; the body is capped at 16 KiB and the route checks its rate limit first. This did not exercise a real ingress/proxy or Redis. |
| **F7 — vulnerable dependencies** | **Partially resolved** | `npm audit --omit=dev` still exits nonzero: **3 high** affected package entries (`prisma`, `@prisma/config`, `deepmerge-ts`), **0 moderate/critical**. The full dev-inclusive audit shows **8 high** affected entries. A major Prisma upgrade plus database/build compatibility testing remains; do not treat the advisory count as proof of exploitability. |

## Fresh checks

- `npm test`: **154 passed, 0 failed**.
- `npm run lint`: **passed**.
- `npm audit --omit=dev`: **3 high, 0 moderate, 0 critical**; exit status **1**.
- `npm audit` (including development tooling): **8 high, 0 moderate, 0 critical**.
- `sharp` native smoke check: generated a 1×1 PNG successfully.
- `npm run typecheck`: **not green** because the Prisma client is not generated here; the errors are in `src/lib/data.ts` and `scripts/reconcile-ledger.ts`, the same locations as before the fixes. This is not evidence of a new failure in the changed files.
- `npm run build`: **blocked** before Next.js compilation: Prisma could not download `schema-engine` from `binaries.prisma.sh` in this restricted sandbox. Production build remains unverified.
- `git diff --check`: **passed**.

## Verdict / next steps

The original F1–F6 behaviors no longer reproduce in the available local tests and code paths. **This is not clearance for live financial traffic**: run the prior report's authorized staging scenarios against an actual database, Supabase session, Redis and provider sandbox, verify database RLS/grants, and complete a production build in an environment with the Prisma engine installed. In particular, validate the 503 → later success transition end to end and the response of every tenant route when its credentials are removed. Upgrade/triage the remaining Prisma advisory chain separately; avoid a blind major upgrade without migration tests.

No real payment, SMS, live target, or third-party system was touched in this re-test.
