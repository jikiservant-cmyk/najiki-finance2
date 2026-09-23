-- Baseline migration for the Na'jiki Tech Payment & Messaging Gateway.
--
-- This project had NO migration history: `prisma/migrations/` held only a
-- README, and every schema change had been applied with `prisma db push`. That
-- is exactly how an `@@index([status, lastPolledAt])` on a field that does not
-- exist reached main undetected — no migration, no validation, no reviewable
-- diff. This file establishes the baseline.
--
-- ============================================================================
-- WHICH PATH APPLIES TO YOU
-- ============================================================================
--
-- A) FRESH DATABASE (no tables yet)
--      npx prisma migrate deploy
--    Applies this file and records it. Done.
--
-- B) EXISTING DATABASE (already has the tables, built via `db push`)
--    Do NOT run `migrate deploy` — it would try to create tables that already
--    exist and fail. Bootstrap the history instead, in this order:
--
--      npx prisma db push          # one final sync, so the DB matches this schema
--      npx prisma migrate resolve --applied 0_init
--
--    `resolve --applied` records the baseline as applied WITHOUT running it.
--    From then on, `migrate dev` / `migrate deploy` own the schema and this can
--    never happen silently again.
--
-- VERIFY EITHER PATH WITH:
--      npx prisma migrate status
--
-- ============================================================================
-- GENERATED FROM prisma/schema.prisma
-- ============================================================================
-- Hand-written to match the schema exactly, and executed against a real
-- PostgreSQL engine to confirm it applies cleanly. If the schema changes,
-- regenerate with:
--
--   npx prisma migrate diff --from-empty \
--     --to-schema-datamodel prisma/schema.prisma --script > <migration>/migration.sql
--
-- (that command needs the Prisma schema engine, which does not download in a
-- sandboxed environment — hence this file being written out by hand).

-- CreateEnum
CREATE TYPE "admin_role_enum" AS ENUM ('doctor', 'nurse', 'pharmacist', 'admin', 'member', 'pastor', 'sacco_admin', 'super_admin', 'school_admin');

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "webhook_path" TEXT NOT NULL DEFAULT '/api/internal/payment-completed',
    "internal_secret_ref" TEXT NOT NULL,
    "api_key" TEXT,
    "api_key_hash" TEXT,
    "webhook_secret_encrypted" TEXT,
    "api_key_hint" TEXT,
    "api_key_rotated_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credentials_ref" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_provider_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_types" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "payment_type_id" TEXT,
    "external_entity_id" TEXT,
    "reference" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UGX',
    "phone_number" TEXT,
    "provider_id" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "last_polled_at" TIMESTAMP(3),
    "phone_redacted_at" TIMESTAMP(3),

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "raw_provider_response" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_logs" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "payment_intent_id" TEXT,
    "payload" TEXT NOT NULL,
    "headers" TEXT,
    "signature_hash" TEXT,
    "signature_valid" BOOLEAN NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processing_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_notifications" (
    "id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "last_attempt_at" TIMESTAMP(3),
    "next_retry_at" TIMESTAMP(3),
    "last_response_status" INTEGER,
    "last_response_body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_profiles" (
    "id" TEXT NOT NULL,
    "role" "admin_role_enum" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_provider_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "credentials_ref" TEXT,
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_accounts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "app_code" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UGX',
    "balance_minor" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "payment_intent_id" TEXT,
    "direction" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UGX',
    "entry_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "balance_after_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_messages" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "application_id" TEXT,
    "application_code" TEXT NOT NULL,
    "provider_code" TEXT NOT NULL,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "sender_id" TEXT,
    "idempotency_key" TEXT,
    "recipient_redacted_at" TIMESTAMP(3),
    "provider_message_id" TEXT,
    "failure_reason" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "applications_code_key" ON "applications"("code");
CREATE UNIQUE INDEX "applications_api_key_key" ON "applications"("api_key");
CREATE UNIQUE INDEX "applications_api_key_hash_key" ON "applications"("api_key_hash");
CREATE UNIQUE INDEX "providers_code_key" ON "providers"("code");
CREATE UNIQUE INDEX "tenants_application_id_code_key" ON "tenants"("application_id", "code");
CREATE UNIQUE INDEX "payment_types_application_id_code_key" ON "payment_types"("application_id", "code");
CREATE UNIQUE INDEX "payment_intents_reference_key" ON "payment_intents"("reference");
CREATE UNIQUE INDEX "payment_intents_application_id_idempotency_key_key" ON "payment_intents"("application_id", "idempotency_key");
CREATE INDEX "payment_intents_status_last_polled_at_idx" ON "payment_intents"("status", "last_polled_at");
CREATE INDEX "payment_intents_application_id_idx" ON "payment_intents"("application_id");
CREATE INDEX "payment_intents_tenant_id_idx" ON "payment_intents"("tenant_id");
CREATE INDEX "payment_intents_status_idx" ON "payment_intents"("status");
CREATE INDEX "payment_intents_created_at_idx" ON "payment_intents"("created_at");
CREATE INDEX "payment_intents_provider_payment_id_idx" ON "payment_intents"("provider_payment_id");
CREATE INDEX "payment_intents_application_id_status_created_at_idx" ON "payment_intents"("application_id", "status", "created_at");
CREATE INDEX "payment_transactions_payment_intent_id_idx" ON "payment_transactions"("payment_intent_id");
CREATE INDEX "payment_transactions_created_at_idx" ON "payment_transactions"("created_at");
CREATE UNIQUE INDEX "webhook_logs_signature_hash_key" ON "webhook_logs"("signature_hash");
CREATE INDEX "webhook_logs_provider_id_idx" ON "webhook_logs"("provider_id");
CREATE INDEX "webhook_logs_payment_intent_id_idx" ON "webhook_logs"("payment_intent_id");
CREATE INDEX "webhook_logs_created_at_idx" ON "webhook_logs"("created_at");
CREATE INDEX "internal_notifications_payment_intent_id_idx" ON "internal_notifications"("payment_intent_id");
CREATE INDEX "internal_notifications_status_next_retry_at_idx" ON "internal_notifications"("status", "next_retry_at");
CREATE UNIQUE INDEX "tenant_provider_configs_tenant_id_provider_id_key" ON "tenant_provider_configs"("tenant_id", "provider_id");
CREATE INDEX "tenant_provider_configs_tenant_id_is_active_idx" ON "tenant_provider_configs"("tenant_id", "is_active");
CREATE INDEX "tenant_provider_configs_tenant_id_provider_id_idx" ON "tenant_provider_configs"("tenant_id", "provider_id");
CREATE UNIQUE INDEX "wallet_accounts_tenant_id_app_code_currency_key" ON "wallet_accounts"("tenant_id", "app_code", "currency");
CREATE INDEX "wallet_accounts_tenant_id_idx" ON "wallet_accounts"("tenant_id");
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_key" ON "ledger_entries"("idempotency_key");
CREATE INDEX "ledger_entries_wallet_id_created_at_idx" ON "ledger_entries"("wallet_id", "created_at");
CREATE UNIQUE INDEX "sms_messages_reference_key" ON "sms_messages"("reference");
CREATE INDEX "sms_messages_status_next_attempt_at_idx" ON "sms_messages"("status", "next_attempt_at");
CREATE INDEX "sms_messages_provider_message_id_idx" ON "sms_messages"("provider_message_id");
CREATE INDEX "sms_messages_recipient_created_at_idx" ON "sms_messages"("recipient", "created_at");
CREATE INDEX "sms_messages_application_code_created_at_idx" ON "sms_messages"("application_code", "created_at");
CREATE UNIQUE INDEX "sms_messages_application_id_idempotency_key_key" ON "sms_messages"("application_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_provider_id_fkey" FOREIGN KEY ("default_provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_types" ADD CONSTRAINT "payment_types_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_type_id_fkey" FOREIGN KEY ("payment_type_id") REFERENCES "payment_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "internal_notifications" ADD CONSTRAINT "internal_notifications_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "internal_notifications" ADD CONSTRAINT "internal_notifications_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_provider_configs" ADD CONSTRAINT "tenant_provider_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_provider_configs" ADD CONSTRAINT "tenant_provider_configs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
