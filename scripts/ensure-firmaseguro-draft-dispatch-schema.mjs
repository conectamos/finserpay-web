import pg from "pg";

// Keep these statements identical to the runtime schema; tests detect drift.
const statements = [
  `CREATE TABLE IF NOT EXISTS "FirmaSeguroDraftDispatch" (
      "id" UUID PRIMARY KEY,
      "draftId" INTEGER NOT NULL REFERENCES "CreditoBorrador"("id") ON DELETE RESTRICT,
      "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" TEXT NOT NULL,
      "reason" TEXT NOT NULL CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500),
      "expectedProcessUuid" TEXT,
      "processUuid" TEXT UNIQUE,
      "status" TEXT NOT NULL CHECK ("status" IN
        ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','FAILED_SAFE','UNCERTAIN')),
      "draftFolio" TEXT NOT NULL,
      "sourcePayload" JSONB NOT NULL,
      "updatedPayload" JSONB NOT NULL,
      "draftPayload" JSONB NOT NULL,
      "frozenCredit" JSONB NOT NULL,
      "documentBase64" TEXT NOT NULL,
      "documentHash" CHAR(64) NOT NULL CHECK ("documentHash" ~ '^[a-f0-9]{64}$'),
      "requestPayload" JSONB,
      "lastError" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "dispatchedAt" TIMESTAMP(3),
      "acknowledgedAt" TIMESTAMP(3),
      CONSTRAINT "FirmaSeguroDraftDispatch_process_check" CHECK
        ("status" <> 'AWAITING_SIGNATURE' OR "processUuid" IS NOT NULL)
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "FirmaSeguroDraftDispatch_one_unresolved"
      ON "FirmaSeguroDraftDispatch"("draftId")
      WHERE "status" IN ('PREPARING','DISPATCHING','UNCERTAIN')`,
  `CREATE INDEX IF NOT EXISTS "FirmaSeguroDraftDispatch_draft_created"
      ON "FirmaSeguroDraftDispatch"("draftId","createdAt" DESC,"id" DESC)`,
  `CREATE TABLE IF NOT EXISTS "FirmaSeguroDraftDispatchEvent" (
      "id" BIGSERIAL PRIMARY KEY,
      "dispatchId" UUID NOT NULL REFERENCES "FirmaSeguroDraftDispatch"("id") ON DELETE RESTRICT,
      "previousStatus" TEXT,
      "status" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  `CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP='INSERT' THEN
          INSERT INTO "FirmaSeguroDraftDispatchEvent"("dispatchId","status") VALUES (NEW."id",NEW."status");
        ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
          INSERT INTO "FirmaSeguroDraftDispatchEvent"("dispatchId","previousStatus","status")
          VALUES (NEW."id",OLD."status",NEW."status");
        END IF;
        RETURN NEW;
      END $$`,
  `CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatch_audit"
      AFTER INSERT OR UPDATE ON "FirmaSeguroDraftDispatch"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_audit()`,
  `CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_preserve()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'DRAFT_DISPATCH_IMMUTABLE' USING ERRCODE='23514';
        END IF;
        IF ROW(NEW."draftId",NEW."actorUserId",NEW."actorName",NEW."reason",
          NEW."expectedProcessUuid",NEW."draftFolio",NEW."sourcePayload",NEW."updatedPayload",
          NEW."draftPayload",NEW."frozenCredit",NEW."documentBase64",NEW."documentHash")
          IS DISTINCT FROM ROW(OLD."draftId",OLD."actorUserId",OLD."actorName",OLD."reason",
          OLD."expectedProcessUuid",OLD."draftFolio",OLD."sourcePayload",OLD."updatedPayload",
          OLD."draftPayload",OLD."frozenCredit",OLD."documentBase64",OLD."documentHash")
          OR (OLD."processUuid" IS NOT NULL AND NEW."processUuid" IS DISTINCT FROM OLD."processUuid")
          OR (OLD."requestPayload" IS NOT NULL AND NEW."requestPayload" IS DISTINCT FROM OLD."requestPayload")
          OR (OLD."dispatchedAt" IS NOT NULL AND NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt")
          OR (OLD."acknowledgedAt" IS NOT NULL AND NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt")
        THEN RAISE EXCEPTION 'DRAFT_DISPATCH_IMMUTABLE' USING ERRCODE='23514'; END IF;
        IF (OLD."status"='PREPARING' AND NEW."status" NOT IN ('PREPARING','DISPATCHING','FAILED_SAFE'))
          OR (OLD."status"='DISPATCHING' AND NEW."status" NOT IN ('DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN'))
          OR (OLD."status" IN ('AWAITING_SIGNATURE','FAILED_SAFE','UNCERTAIN')
            AND NEW."status" IS DISTINCT FROM OLD."status")
        THEN RAISE EXCEPTION 'DRAFT_DISPATCH_STATUS_INVALID' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$`,
  `CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatch_preserve"
      BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatch"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_preserve()`,
  `CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_event_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'DRAFT_DISPATCH_AUDIT_IMMUTABLE' USING ERRCODE='23514';
      END $$`,
  `CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatchEvent_immutable"
      BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatchEvent"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_event_immutable()`,
];

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para envios de FirmaSeguro para borradores.");
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  application_name: "finserpay-firmaseguro-draft-dispatch-schema",
});

try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-firmaseguro-draft-dispatch-schema'))");
  for (const statement of statements) await client.query(statement);
  await client.query("COMMIT");
  console.log("Esquema de envios de FirmaSeguro para borradores verificado.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
