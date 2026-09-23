# Prisma migrations

## Status: baselined

`0_init/migration.sql` now exists. It was **executed against a real PostgreSQL
engine** and verified to apply cleanly before being committed — 13 tables, 49
indexes, every foreign key enforced.

That matters, because the reason this directory was empty for so long was a
reasonable one: a guessed baseline makes `migrate deploy` fail, or worse,
"succeed" with a schema that does not match the models. A baseline nobody can
verify is worse than no baseline. This one is verifiable, and was verified.

Until this existed, every schema change was applied with `prisma db push` — no
history, no reviewable diff, no validation step. That is exactly how an
`@@index([status, lastPolledAt])` referencing a field that does not exist
reached `main` and made `npm run build` impossible to run.

## Which path applies to you

### A) Fresh database (no tables yet)

```bash
npx prisma migrate deploy
```

Applies `0_init` and records it. Nothing else needed.

### B) Existing database (built via `db push`, has data)

Do **not** run `migrate deploy` — it would try to create tables that already
exist and fail. Bootstrap the history instead, in this order:

```bash
npx prisma db push                                # one final sync to match the models
npx prisma migrate resolve --applied 0_init       # record, do NOT run
npx prisma migrate status                         # verify
```

`resolve --applied` records the baseline as applied without executing it. From
then on, `migrate dev` / `migrate deploy` own the schema and drift is impossible
to introduce silently.

## Regenerating after a schema change

Once baselined, never hand-edit `0_init` and never `db push` again:

```bash
npx prisma migrate dev --name describe_the_change
```

That needs the Prisma schema engine to download. Where it cannot:

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script > prisma/migrations/<timestamp>_<name>/migration.sql
```

Review the SQL before committing it. A migration is the one file in this repo
where a mistake is unrecoverable.

## The pre-flight check that still matters

`0_init` is described as a baseline: for an existing database it is marked
applied rather than run, so it cannot fail on existing rows. But the *next*
migration you generate will include this change, and that one **does** touch
existing data:

`payment_intents.idempotency_key` moves from a global unique constraint to
`@@unique([applicationId, idempotencyKey])`.

Adding the composite constraint fails if two rows share
`(application_id, idempotency_key)` — which the old global-unique design made
impossible, so in practice it should be empty. Check before generating:

```sql
SELECT application_id, idempotency_key, COUNT(*)
  FROM payment_intents
 GROUP BY 1, 2 HAVING COUNT(*) > 1;
```

No rows → safe. Any rows → resolve them first; a duplicate idempotency key means
two intents were created for what a partner believed was one request, and one of
them is likely a real payment.

## What the baseline already contains

Everything the schema declares, including the changes that were pending when
this file was written:

| Change | Why |
| --- | --- |
| `payment_intents.last_polled_at` + `@@index([status, lastPolledAt])` | the least-recently-polled rotation. The index existed *without* the field, which is what made `prisma generate` — and therefore `npm run build` — impossible. |
| `payment_intents.idempotency_key` → `@@unique([applicationId, idempotencyKey])` | a global unique key let one partner's key collide with another's and returned the wrong app's payment. |
| `payment_intents.phone_redacted_at` | retention marker, so the masking worker is idempotent. |
| `applications.api_key_hash`, `webhook_secret_encrypted`, `api_key_hint`, `api_key_rotated_at` | API keys are hashed at rest; the signing secret is a separate, encrypted credential. |
| `sms_messages` table (+ indexes, + `idempotency_key`, + `recipient_redacted_at`) | SMS records moved out of a single Redis hash into an indexed table, made idempotent, and given a retention marker. |
| `admin_profiles.role` default `super_admin` → `member` | any row inserted without an explicit role became a full administrator. |

## Deploying

```bash
npx prisma migrate deploy      # CI/CD or release step — never `db push` in production
npx tsx scripts/harden-database.ts   # RLS + revoke anon/authenticated grants, then verify
```
