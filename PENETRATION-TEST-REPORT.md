# Na'jiki Finance — local security assessment

**Date:** 2026-10-17
**Scope:** Checkout on `arena/ef3370ad-najiki-finance2`; application code, API/auth flows, lockfile and local unit tests. **No production URL, credentials, database, or provider sandbox was supplied.** No live deployment, real payment/SMS provider, or third-party system was probed. This is a non-destructive code-assisted penetration assessment, **not** a certification of a deployed environment. Severities describe potential impact, not proof of exploitation in production.

## Executive summary

**Do not treat this checkout as ready for real-money traffic until the payment-state and tenant-account findings are resolved and tested against a staging database/provider.** The most consequential confirmed behavior is that a temporary provider HTTP failure is represented as a *terminal payment failure*. I also found an admin revocation gap, credential fallbacks that can mix tenant and platform accounts, an unsafe development-mode auth bypass if exposed, and availability/dependency risks.

## Findings

### F1 — High: provider status errors can permanently fail a real payment

**Evidence:** `src/lib/providers/livepay.ts:93-125` returns `{ success: false, status: 'failed' }` for a non-success HTTP/provider response. The pollers in `src/app/api/cron/sync-payments/route.ts:71-86` and `src/app/api/qstash/cron/route.ts:72-87`, plus `src/app/api/payments/[reference]/route.ts:123-135`, act on `status` without requiring `success === true`. `src/lib/payments.ts:192-202` then prevents a later success from replacing a terminal `failed` state.

**Safe local proof:** With `fetch` mocked to return HTTP 503 and JSON `{ "success": false, "message": "temporary provider outage" }`, calling `LivePayProvider.checkPaymentStatus('TEST-REFERENCE')` returned `{ success: false, status: 'failed', failureReason: 'temporary provider outage' }`. No external request was sent. End-to-end DB mutation was **not** tested.

**Impact:** A temporary status API outage or rejection may mark an in-flight collection failed, notify the partner of failure, and prevent the genuine later success from settling automatically.

**Fix:** Return a nonterminal/unknown result on transport, HTTP and provider-level errors; only accept terminal statuses from an explicitly successful, validated response. Make *all three* callers require `result.success` and validate reference/account/amount/currency where the provider supplies them. Add a regression test for HTTP 503 followed by a successful status or signed callback.

### F2 — High: tenant payments may use platform credentials on create/status checks

**Evidence:** `src/lib/payments.ts:18-31` accepts any encrypted credential blob as a usable tenant config, without checking that the decrypted `apiKey` and `accountNo` are present. `src/lib/providers/livepay.ts:21-25` substitutes platform environment credentials for **each missing tenant field**. The creation path uses that client at `src/lib/payments.ts:77-97`; `src/app/api/payments/route.ts:273-285` only verifies that some config row exists. Both cron pollers (`src/app/api/cron/sync-payments/route.ts:55-79`, `src/app/api/qstash/cron/route.ts:55-80`) and the partner status route (`src/app/api/payments/[reference]/route.ts:107-132`) also proceed with platform credentials if a previously configured tenant row has since been disabled/deleted.

**Safe local proof:** Instantiating `LivePayProvider({ apiKey: 'tenant-key', accountNo: 'tenant-account' })` with a platform webhook secret set selected the *platform* secret for the missing field. The same fallback applies to missing API key/account number; no provider call was made. Whether a cross-account status response can settle a particular reference depends on provider behavior and was **not** validated.

**Impact:** Collections or status checks can be routed to the wrong merchant account. A cross-account positive status, if accepted by the provider, could result in incorrect tenant wallet credit. Even without that, missing tenant credentials can break reconciliation silently.

**Fix:** For tenant-collected payments require a complete, decrypted tenant credential set before creation **and** before every status poll; reject rather than fall back. Make the provider constructor use either an explicitly selected platform config or a complete tenant config, never field-by-field mixing. Test credential removal between initiation and polling.

### F3 — High: removing an email from the super-admin allowlist does not revoke admin access

**Evidence:** `src/lib/auth.ts:98-129` promotes users listed in `SUPER_ADMIN_EMAILS`, but an already-created `AdminProfile` with role `super_admin` remains authorized when the email is removed. The final check only tests the stored role. This is relevant while the former admin still has a valid Supabase login; it is not an anonymous bypass.

**Impact:** An operator may believe removing an email from the environment variable revoked dashboard access, while the user can still manage applications and credentials.

**Fix:** Define whether the allowlist is a continuing access policy or only a bootstrap list. If it is a policy, enforce it on *every* admin request and provide a controlled exception/recovery mechanism. Revoke existing profiles and Supabase sessions when offboarding admins. Add an allowlist-removal regression test.

### F4 — High, conditional: development mode disables authentication when Supabase is absent

**Evidence:** `src/middleware.ts:46-55` passes all protected requests through in non-production mode without Supabase config; `src/lib/auth.ts:42-51,75-86` returns a synthetic authenticated/super-admin user. `src/lib/encryption.ts:15-25` also uses a predictable development fallback key when no key is supplied. Production-mode configuration explicitly fails closed; this finding requires a reachable non-production instance with auth unset.

**Impact:** Anyone who can reach such a development/staging deployment can use super-admin APIs (given a working DB), potentially access tenant data and modify payment configuration.

**Fix:** Bind insecure local development to a private interface/network, or require an explicit opt-in flag that is impossible to set in hosted environments. Prefer local test identities over an unconditional synthetic admin. Never expose a `next dev` instance publicly with real data or provider keys.

### F5 — Medium: the payment-status rate limiter fails open during Redis errors

**Evidence:** `src/app/api/payments/[reference]/route.ts:12-25,38-55` bypasses its limiter if initialization fails or a rate-limit operation times out/errors, including production. Unlike the shared limiter (`src/lib/rate-limit.ts:98-103`), this path does not fail closed. A valid partner API key is still required; this is **not** an authentication bypass.

**Impact:** Redis degradation removes the limit on DB status reads and potentially provider status polling, worsening an outage or allowing excessive traffic from a compromised key.

**Fix:** Use the shared `checkRateLimit` helper; reject with 503 on limiter failure in production. Prefer a coarse IP limit before key lookup and a separate authenticated per-key limit.

### F6 — Medium: unauthenticated SMS callbacks parse unbounded bodies before authorization

**Evidence:** `src/app/api/webhooks/africastalking/route.ts:46-59,77-104` calls `request.json()` or `request.text()` before checking the shared secret; it has no application-level byte cap or per-IP rate limit. The same handler is exposed at `/api/messaging/callback`. Platform ingress limits may reduce the practical impact, but none were verified here.

**Impact:** Repeated large or complex requests can consume memory/CPU on a public endpoint even when the secret is wrong.

**Fix:** Enforce a small streaming byte limit (for example 16–64 KiB) before parsing; rate-limit before body reading, and retain the secret check before all writes. Test chunked requests without `Content-Length`.

### F7 — Dependency advisory backlog (risk requires triage)

`npm audit --omit=dev` reported **10 high and 1 moderate affected packages** in the installed production dependency tree (full tree: **15 high, 1 moderate**). Examples include `africastalking` and transitive `axios`/`joi`, `sharp`, `postcss`, and `next`. This is an advisory inventory, **not evidence that each advisory is reachable in this app**. Notably, the SMS SDK runs on server-side outbound requests; assess applicability before assigning exploitability. Some suggested fixes are major-version upgrades.

**Fix:** Triage direct runtime dependencies first; upgrade compatible versions, assess breaking changes for major upgrades, re-run `npm audit --omit=dev`, build, and exercise payment/SMS regression tests. Add an automated dependency-audit policy to CI.

## Checks performed and limitations

- `npm ci --no-audit --no-fund`: passed.
- `npm test`: **146/146 passed** (existing unit tests; not an end-to-end security suite).
- `npm run lint`: passed.
- `npm run verify`: blocked at TypeScript because the Prisma client was not generated in this checkout. `npx prisma generate` could not download its schema engine from `binaries.prisma.sh` in this sandbox; therefore TypeScript/build results are **inconclusive**, not a demonstrated source failure.
- `npm audit` and `npm audit --omit=dev`: completed; counts above are from this date's registry response.
- Static review covered middleware, session/API-key auth, payment initiation/status/webhooks, callback and cron auth, admin setup, SMS, outbound URL checks, and dependency manifest. No live exploit, database/RLS check, external host scan, or real callback replay was performed. In particular, production Supabase RLS, deployment environment, proxy IP handling, and provider response behavior remain **unverified**.

## Recommended next validation (authorized staging only)

1. Reproduce F1 against a fake provider returning HTTP 503, then a signed success response, and verify the DB remains reconcilable throughout.
2. Configure an incomplete tenant credential blob and then disable a valid blob after creating an intent; assert that **every** collection and poll path refuses platform fallback.
3. Remove a test admin from the allowlist and verify `/api/setup` and `/api/dashboard` return 403 with their still-valid Supabase session.
4. Exercise wrong-secret, oversized and chunked requests against the callback using small, non-disruptive limits; check 413/429 responses and memory behavior.
5. Verify Supabase table grants/RLS on the actual deployment using the documented `db:harden`/`db:check` process before handling real data.

**Priority:** F1 and F2 before money movement; F3/F4 before exposing a dashboard; then F5–F7.

## Remediation update — same branch

The findings above describe the **pre-fix checkout**. Follow-up code changes now:

- **F1:** Treat failed provider status queries as nonterminal; require an explicitly successful terminal status and check any returned amount/currency/provider ID before settling. A provider initiation HTTP 5xx or network error is also left reconcilable instead of immediately failed.
- **F2:** Load and validate a complete tenant credential set for creation, callbacks, API status reads and both pollers. A missing/disabled/incomplete row no longer falls back to the platform account. This intentionally rejects tenant collections that relied on platform credentials; operators must configure each tenant's own LivePay API key, account number and webhook secret. Platform-fee payments still use platform credentials. If tenant credentials disappear after an intent is created, restore them to resume reconciliation.
- **F3:** Check `SUPER_ADMIN_EMAILS` on every admin request; removed accounts can no longer use a stored super-admin role. Rotate/revoke Supabase sessions separately as an operational precaution.
- **F4:** Missing Supabase configuration denies dashboard access by default. `ALLOW_INSECURE_DEV_AUTH=true` is an explicit **development-only** escape hatch. Development encryption uses a random ephemeral key rather than a predictable default; local encrypted data will not survive a restart without `APP_ENCRYPTION_KEY`.
- **F5/F6:** Payment-status requests use the production fail-closed shared limiter; SMS callbacks are rate-limited and capped to 16 KiB while streaming, before parsing.
- **F7:** Updated lockfile, `sharp`, and constrained compatible `axios`, `joi`, `lodash`, and `postcss` transitive versions. `npm audit --omit=dev` is down from **10 high + 1 moderate** to **3 high, 0 moderate** affected package entries. Remaining advisories are the Prisma CLI/config/deepmerge-ts chain, whose recommended fix is a Prisma 7 major upgrade; that migration was **not** attempted without a working Prisma engine and database integration tests. The full dev-inclusive tree still reports additional lint-tool advisories. These are not claimed fixed.

Regression tests cover the provider 503 and initiation 503 with mocked fetch, credential completeness, allowlist/opt-in policy, rate-limiter failure and chunked oversized bodies. They do **not** replace the authorized staging validation listed above. Prisma generation, a full TypeScript check and production build still require access to the Prisma engine download host or a preinstalled engine.
