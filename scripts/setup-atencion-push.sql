BEGIN;
SET LOCAL search_path = public;
CREATE TABLE IF NOT EXISTS "AttentionPushSubscription" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "recipientKey" text NOT NULL CHECK ("recipientKey" ~ '^(user|seller):[1-9][0-9]*$'),
  endpoint text NOT NULL UNIQUE,
  keys jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL DEFAULT now() + interval '90 days'
);
CREATE INDEX IF NOT EXISTS "AttentionPushSubscription_recipient" ON "AttentionPushSubscription"("recipientKey");
CREATE TABLE IF NOT EXISTS "AttentionPushDelivery" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "notificationId" uuid NOT NULL REFERENCES "AttentionWorkNotification"(id) ON DELETE CASCADE,
  "subscriptionId" uuid NOT NULL REFERENCES "AttentionPushSubscription"(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
  "leaseToken" uuid,
  "leaseUntil" timestamptz,
  "deliveredAt" timestamptz,
  "errorCode" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("notificationId","subscriptionId")
);
CREATE INDEX IF NOT EXISTS "AttentionPushDelivery_pending" ON "AttentionPushDelivery"("nextAttemptAt") WHERE "deliveredAt" IS NULL;
COMMIT;
