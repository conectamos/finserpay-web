export const allySettlementDeliverySchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."AllySettlementDocument" (
    "settlementId" INTEGER PRIMARY KEY REFERENCES public."LiquidacionAliado"("id") ON DELETE RESTRICT,
    "pdf" BYTEA NOT NULL, "sha256" CHAR(64) NOT NULL, "filename" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS public."AllySettlementDelivery" (
    "settlementId" INTEGER NOT NULL REFERENCES public."LiquidacionAliado"("id") ON DELETE RESTRICT,
    "channel" TEXT NOT NULL CHECK ("channel" IN ('EMAIL','WHATSAPP')),
    PRIMARY KEY ("settlementId","channel")
  )`,
  `CREATE TABLE IF NOT EXISTS public."AllySettlementDeliveryAttempt" (
    "id" UUID PRIMARY KEY,
    "settlementId" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL CHECK ("sequence" > 0),
    "requestId" UUID NOT NULL UNIQUE,
    "recipient" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('QUEUED','PROCESSING','SENT','FAILED','UNCERTAIN')),
    "error" TEXT,
    "actorUserId" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "attemptedAt" TIMESTAMPTZ,
    "sentAt" TIMESTAMPTZ,
    "sendStartedAt" TIMESTAMPTZ,
    "leaseUntil" TIMESTAMPTZ,
    "claimToken" UUID,
    "providerId" TEXT,
    "providerEventAt" TIMESTAMPTZ,
    FOREIGN KEY ("settlementId","channel") REFERENCES public."AllySettlementDelivery"("settlementId","channel") ON DELETE RESTRICT,
    UNIQUE ("settlementId","channel","sequence")
  )`,
  `CREATE INDEX IF NOT EXISTS "AllySettlementDeliveryAttempt_queue_idx"
    ON public."AllySettlementDeliveryAttempt" ("status","createdAt")`,
  `CREATE TABLE IF NOT EXISTS public."AllySettlementDeliveryRequest" (
    "requestId" UUID PRIMARY KEY,
    "attemptId" UUID NOT NULL REFERENCES public."AllySettlementDeliveryAttempt"("id") ON DELETE RESTRICT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AllySettlementDeliveryAttempt_provider_idx"
    ON public."AllySettlementDeliveryAttempt" ("channel","providerId") WHERE "providerId" IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS public."AllySettlementDaptaClaim" (
    "attemptId" UUID PRIMARY KEY REFERENCES public."AllySettlementDeliveryAttempt"("id") ON DELETE RESTRICT,
    "recipient" TEXT NOT NULL,
    "claimedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "receiptAt" TIMESTAMPTZ,
    "receiptStatus" TEXT CHECK ("receiptStatus" IN ('SENT','FAILED','UNCERTAIN')),
    "providerId" TEXT,
    "errorCode" TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AllySettlementDaptaClaim_provider_idx"
    ON public."AllySettlementDaptaClaim" ("providerId") WHERE "providerId" IS NOT NULL`,
];
