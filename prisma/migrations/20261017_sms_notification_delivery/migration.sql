-- The SMS cron retries terminal partner notifications. Do not replay old
-- delivered/failed rows when applying this migration to a live database.
ALTER TABLE "sms_messages" ADD COLUMN "notification_delivered_at" TIMESTAMP(3);
ALTER TABLE "sms_messages" ADD COLUMN "notification_attempted_at" TIMESTAMP(3);
UPDATE "sms_messages"
   SET "notification_delivered_at" = "updated_at"
 WHERE "status" IN ('delivered', 'failed');
CREATE INDEX "sms_messages_notification_pending_idx"
    ON "sms_messages" ("status", "notification_delivered_at");
