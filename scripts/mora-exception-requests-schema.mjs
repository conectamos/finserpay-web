export function moraExceptionRequestSchemaStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS "CreditMoraExceptionRequest" (
      "id" UUID PRIMARY KEY,
      "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
      "type" VARCHAR(16) NOT NULL CHECK ("type" IN ('EXCEPCION','PRORROGA')),
      "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED','EXPIRED','REPLACED','CANCELLED')),
      "source" VARCHAR(24) NOT NULL DEFAULT 'ANALYST_REQUEST' CHECK ("source" IN ('ANALYST_REQUEST','CENTRAL_DIRECT','SYSTEM_DIANA')),
      "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">0),
      "installmentNumber" INTEGER CHECK ("installmentNumber">0),
      "installmentDueDate" DATE,
      "expiresOn" DATE,
      "promiseAmount" NUMERIC(20,2) CHECK ("promiseAmount">0),
      "promiseDate" DATE,
      "reason" VARCHAR(500) NOT NULL,
      "observation" VARCHAR(2000) NOT NULL,
      "createdByUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "createdBySystemKey" VARCHAR(32),
      "createdByName" VARCHAR(180) NOT NULL,
      "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "decidedByUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "decidedBySystemKey" VARCHAR(32),
      "decidedByName" VARCHAR(180),
      "decidedAt" TIMESTAMPTZ,
      "decisionReason" VARCHAR(1000),
      "cooldownBypassed" BOOLEAN NOT NULL DEFAULT FALSE,
      "cooldownBypassReason" VARCHAR(1000),
      "createIdempotencyKey" UUID NOT NULL UNIQUE,
      "createRequestHash" CHAR(64) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ("promiseDate"<="expiresOn"),
      CHECK (("status"='PENDING' AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL)
        OR ("status"<>'PENDING' AND "decidedAt" IS NOT NULL)),
      CHECK (NOT "cooldownBypassed" OR NULLIF(BTRIM("cooldownBypassReason"),'') IS NOT NULL)
    )`,
    `ALTER TABLE "CreditMoraExceptionRequest"
      ADD COLUMN IF NOT EXISTS "source" VARCHAR(24) NOT NULL DEFAULT 'ANALYST_REQUEST'`,
    `ALTER TABLE "CreditMoraExceptionRequest"
      ALTER COLUMN "installmentNumber" DROP NOT NULL,
      ALTER COLUMN "installmentDueDate" DROP NOT NULL,
      ALTER COLUMN "expiresOn" DROP NOT NULL,
      ALTER COLUMN "promiseAmount" DROP NOT NULL,
      ALTER COLUMN "promiseDate" DROP NOT NULL`,
    `ALTER TABLE "CreditMoraExceptionRequest" DROP CONSTRAINT IF EXISTS "CreditMoraExceptionRequest_status_check"`,
    `ALTER TABLE "CreditMoraExceptionRequest" ADD CONSTRAINT "CreditMoraExceptionRequest_status_check"
      CHECK ("status" IN ('PENDING','APPROVED','REJECTED','EXPIRED','REPLACED','CANCELLED'))`,
    `ALTER TABLE "CreditMoraExceptionRequest" DROP CONSTRAINT IF EXISTS "CreditMoraExceptionRequest_source_check"`,
    `ALTER TABLE "CreditMoraExceptionRequest" DROP CONSTRAINT IF EXISTS "CreditMoraExceptionRequest_source_values"`,
    `ALTER TABLE "CreditMoraExceptionRequest" ADD CONSTRAINT "CreditMoraExceptionRequest_source_values"
      CHECK ("source" IN ('ANALYST_REQUEST','CENTRAL_DIRECT','SYSTEM_DIANA'))`,
    `ALTER TABLE "CreditMoraExceptionRequest"
      ALTER COLUMN "createdByUserId" DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS "createdBySystemKey" VARCHAR(32),
      ADD COLUMN IF NOT EXISTS "decidedBySystemKey" VARCHAR(32)`,
    `ALTER TABLE "CreditMoraExceptionRequest" DROP CONSTRAINT IF EXISTS "CreditMoraExceptionRequest_actor_identity"`,
    `ALTER TABLE "CreditMoraExceptionRequest" ADD CONSTRAINT "CreditMoraExceptionRequest_actor_identity" CHECK (
      (("createdByUserId" IS NOT NULL AND "createdBySystemKey" IS NULL)
        OR ("createdByUserId" IS NULL AND "createdBySystemKey" IS NOT NULL AND "createdBySystemKey"='SYSTEM_DIANA' AND "source"='SYSTEM_DIANA'))
      AND ("decidedBySystemKey" IS NULL OR ("decidedBySystemKey"='SYSTEM_DIANA' AND "decidedByUserId" IS NULL))
      AND ("source"<>'SYSTEM_DIANA' OR ("createdBySystemKey" IS NOT NULL AND "createdBySystemKey"='SYSTEM_DIANA'
        AND "decidedBySystemKey" IS NOT NULL AND "decidedBySystemKey"='SYSTEM_DIANA' AND "decidedByUserId" IS NULL
        AND "decidedAt" IS NOT NULL AND "type"='PRORROGA' AND "status" IN ('APPROVED','EXPIRED','REPLACED','CANCELLED'))))`,
    `ALTER TABLE "CreditMoraExceptionRequest" DROP CONSTRAINT IF EXISTS "CreditMoraExceptionRequest_source_fields"`,
    `ALTER TABLE "CreditMoraExceptionRequest" ADD CONSTRAINT "CreditMoraExceptionRequest_source_fields"
        CHECK (("source" IN ('ANALYST_REQUEST','SYSTEM_DIANA') AND "installmentNumber" IS NOT NULL AND "installmentDueDate" IS NOT NULL
          AND "expiresOn" IS NOT NULL AND "promiseAmount" IS NOT NULL AND "promiseDate" IS NOT NULL)
          OR ("source"='CENTRAL_DIRECT' AND "installmentNumber" IS NULL AND "installmentDueDate" IS NULL
            AND "promiseAmount" IS NULL AND "promiseDate" IS NULL AND "status" IN ('APPROVED','EXPIRED','REPLACED','CANCELLED')))`,
    `DROP INDEX IF EXISTS "CreditMoraExceptionRequest_one_pending"`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "CreditMoraExceptionRequest_one_open"
      ON "CreditMoraExceptionRequest" ("creditoId") WHERE "status" IN ('PENDING','APPROVED')`,
    `CREATE INDEX IF NOT EXISTS "CreditMoraExceptionRequest_list"
      ON "CreditMoraExceptionRequest" ("status","createdAt" DESC,"id" DESC)`,
    `CREATE INDEX IF NOT EXISTS "CreditMoraExceptionRequest_cooldown"
      ON "CreditMoraExceptionRequest" ("creditoId","type","expiresOn" DESC)
      WHERE "status" IN ('APPROVED','EXPIRED')`,
    `CREATE TABLE IF NOT EXISTS "CreditMoraSpecialPermission" (
      "userId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "permissionKey" VARCHAR(64) NOT NULL CHECK ("permissionKey" IN ('MORA_COOLDOWN_BYPASS')),
      "active" BOOLEAN NOT NULL DEFAULT TRUE,
      "reason" VARCHAR(1000) NOT NULL,
      "grantedByUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "grantedByName" VARCHAR(180) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("userId","permissionKey")
    )`,
    `CREATE TABLE IF NOT EXISTS "CreditMoraPermissionEvent" (
      "id" UUID PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "permissionKey" VARCHAR(64) NOT NULL CHECK ("permissionKey" IN ('MORA_COOLDOWN_BYPASS')),
      "active" BOOLEAN NOT NULL,
      "reason" VARCHAR(1000) NOT NULL,
      "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" VARCHAR(180) NOT NULL,
      "idempotencyKey" UUID NOT NULL UNIQUE,
      "requestHash" CHAR(64) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS "CreditMoraPermissionEvent_history"
      ON "CreditMoraPermissionEvent" ("userId","createdAt" DESC,"id" DESC)`,
    `CREATE TABLE IF NOT EXISTS "CreditMoraExceptionEvent" (
      "id" UUID PRIMARY KEY,
      "requestId" UUID NOT NULL REFERENCES "CreditMoraExceptionRequest"("id") ON DELETE RESTRICT,
      "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
      "version" INTEGER NOT NULL CHECK ("version">0),
      "action" VARCHAR(16) NOT NULL CHECK ("action" IN ('SUBMITTED','APPROVED','REJECTED','EXPIRED','OBSERVED','REPLACED','EDITED','CANCELLED')),
      "fromStatus" VARCHAR(16),
      "toStatus" VARCHAR(16) NOT NULL,
      "payload" JSONB NOT NULL,
      "actorUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorSystemKey" VARCHAR(32) CHECK ("actorSystemKey" IS NULL OR ("actorSystemKey"='SYSTEM_DIANA' AND "actorUserId" IS NULL)),
      "actorName" VARCHAR(180) NOT NULL,
      "idempotencyKey" UUID UNIQUE,
      "requestHash" CHAR(64) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("requestId","version")
    )`,
    `ALTER TABLE "CreditMoraExceptionEvent" DROP CONSTRAINT IF EXISTS "CreditMoraExceptionEvent_action_check"`,
    `ALTER TABLE "CreditMoraExceptionEvent" ADD COLUMN IF NOT EXISTS "actorSystemKey" VARCHAR(32)`,
    `ALTER TABLE "CreditMoraExceptionEvent" DROP CONSTRAINT IF EXISTS "CreditMoraExceptionEvent_system_actor"`,
    `ALTER TABLE "CreditMoraExceptionEvent" ADD CONSTRAINT "CreditMoraExceptionEvent_system_actor"
      CHECK ("actorSystemKey" IS NULL OR ("actorSystemKey"='SYSTEM_DIANA' AND "actorUserId" IS NULL))`,
    `ALTER TABLE "CreditMoraExceptionEvent" ADD CONSTRAINT "CreditMoraExceptionEvent_action_check"
      CHECK ("action" IN ('SUBMITTED','APPROVED','REJECTED','EXPIRED','OBSERVED','REPLACED','EDITED','CANCELLED'))`,
    `CREATE INDEX IF NOT EXISTS "CreditMoraExceptionEvent_history"
      ON "CreditMoraExceptionEvent" ("requestId","createdAt","id")`,
    `CREATE OR REPLACE FUNCTION public.mora_exception_history_immutable() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'El historial de excepciones de mora es inmutable' USING ERRCODE='23514'; END; $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS "CreditMoraExceptionEvent_immutable" ON "CreditMoraExceptionEvent"`,
    `CREATE TRIGGER "CreditMoraExceptionEvent_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
      ON "CreditMoraExceptionEvent" FOR EACH STATEMENT EXECUTE FUNCTION public.mora_exception_history_immutable()`,
    `DROP TRIGGER IF EXISTS "CreditMoraPermissionEvent_immutable" ON "CreditMoraPermissionEvent"`,
    `CREATE TRIGGER "CreditMoraPermissionEvent_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
      ON "CreditMoraPermissionEvent" FOR EACH STATEMENT EXECUTE FUNCTION public.mora_exception_history_immutable()`,
    `DROP TRIGGER IF EXISTS "CreditMoraExceptionRequest_no_delete" ON "CreditMoraExceptionRequest"`,
    `CREATE TRIGGER "CreditMoraExceptionRequest_no_delete" BEFORE DELETE OR TRUNCATE
      ON "CreditMoraExceptionRequest" FOR EACH STATEMENT EXECUTE FUNCTION public.mora_exception_history_immutable()`,
  ];
}

export async function installMoraExceptionRequestSchema(client) {
  await client.query("BEGIN");
  try {
    for (const sql of moraExceptionRequestSchemaStatements()) await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
