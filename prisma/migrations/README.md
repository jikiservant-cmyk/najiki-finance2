# Prisma migrations

There is deliberately **no hand-written SQL in this directory**.

## Why

Applying a schema is the one step in this service where a mistake is
unrecoverable — `db push` can drop a column, and a guessed baseline migration
makes `migrate deploy` fail (or worse, "succeed" with a schema that does not
match the models). Generating the baseline requires the Prisma engines, so it
cannot be produced inside a sandboxed environment and committed as a blob that
nobody can verify.

Instead, generate it once on a machine with database access and commit the
result. From then on every schema change has a reviewable, ordered SQL file.

## Greenfield database (no data yet)

```bash
# 1. Point DATABASE_URL at the target database
# 2. Generate the baseline from the current models
npx prisma migrate dev --name init

# 3. Commit it
git add prisma/migrations && git commit -m "chore(db): baseline migration"
```

## Existing database (deployed with `db push`)

The database already matches the schema, so baseline it instead of replaying
the DDL:

```bash
# 1. Generate the SQL for a from-scratch database, into a new migration folder
mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_init
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/*_init/migration.sql

# 2. Mark it as already applied (the tables exist, we just want the history)
npx prisma migrate resolve --applied <migration-folder-name>

# 3. Confirm the history and the database agree
npx prisma migrate status
```

## Pending schema changes in this branch

Two schema changes are waiting on a migration:

| Change | Why |
| --- | --- |
| `payment_intents`: `idempotency_key` unique → `@@unique([applicationId, idempotencyKey])` | A global unique key let one partner app's idempotency key collide with another's, and the request returned the wrong app's payment. |
| `payment_intents`: new `lastPolledAt` + `@@index([status, lastPolledAt])` | Gives the status pollers a fair rotation so old pending payments cannot starve newer ones out of each batch. |
| new table `sms_messages` (+ indexes) | SMS records moved out of a single Redis hash (`HGETALL` per delivery report) into an indexed table. |
| `admin_profiles.role` default `super_admin` → `member` | Any row inserted without an explicit role became a full administrator. |

Apply them with a normal migration:

```bash
npx prisma migrate dev --name payment_idempotency_wallet_and_sms
```

> ⚠️ The `idempotency_key` change drops a unique constraint and adds a
> composite one. If existing data contains two rows with the same
> `(applicationId, idempotencyKey)` the migration will fail — check first:
>
> ```sql
> SELECT application_id, idempotency_key, COUNT(*)
>   FROM payment_intents
>  GROUP BY 1, 2 HAVING COUNT(*) > 1;
> ```

## Deploying

```bash
npx prisma migrate deploy      # CI/CD or release step — never `db push` in production
npx tsx scripts/harden-database.ts   # RLS + revoke anon/authenticated grants, then verify
```
