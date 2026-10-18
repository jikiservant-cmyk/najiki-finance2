-- An authenticated DLR can arrive before the provider-send response has
-- attached its provider ID to sms_messages. Persist it for later correlation.
CREATE TABLE "sms_delivery_reports" (
    "provider_message_id" VARCHAR(255) NOT NULL,
    "status" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    CONSTRAINT "sms_delivery_reports_pkey" PRIMARY KEY ("provider_message_id")
);
CREATE INDEX "sms_delivery_reports_applied_at_last_checked_at_idx"
    ON "sms_delivery_reports" ("applied_at", "last_checked_at");
CREATE INDEX "sms_delivery_reports_received_at_idx"
    ON "sms_delivery_reports" ("received_at");

-- Prisma uses the table owner; browser/Data API roles must not read even this
-- metadata. Harden the new public table at creation, not only on a later run.
ALTER TABLE "sms_delivery_reports" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE "sms_delivery_reports" FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE "sms_delivery_reports" FROM authenticated;
    END IF;
END $$;
