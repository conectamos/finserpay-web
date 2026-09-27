CREATE TABLE IF NOT EXISTS public."MerchantApplication" (
  "id" UUID PRIMARY KEY,
  "contentHash" TEXT NOT NULL,
  "contactEmail" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "notificationStatus" TEXT NOT NULL DEFAULT 'PENDING'
    CHECK ("notificationStatus" IN ('PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'REVIEW')),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "mailPayload" JSONB,
  "providerEmailId" UUID UNIQUE,
  "firstAttemptAt" TIMESTAMPTZ,
  "ambiguousAttempt" BOOLEAN NOT NULL DEFAULT FALSE,
  "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMPTZ,
  "lastErrorCode" TEXT,
  "acceptedAt" TIMESTAMPTZ,
  "deliveredAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public."MerchantApplicationRequest" (
  "requestId" UUID PRIMARY KEY,
  "applicationId" UUID NOT NULL REFERENCES public."MerchantApplication"("id") ON DELETE CASCADE,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "MerchantApplication_pending_idx"
  ON public."MerchantApplication" ("notificationStatus", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "MerchantApplication_content_idx"
  ON public."MerchantApplication" ("contentHash", "createdAt");
CREATE INDEX IF NOT EXISTS "MerchantApplication_contact_idx"
  ON public."MerchantApplication" ("contactEmail", "createdAt");
CREATE INDEX IF NOT EXISTS "MerchantApplicationRequest_application_idx"
  ON public."MerchantApplicationRequest" ("applicationId");
