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
  `CREATE TABLE IF NOT EXISTS "FirmaSeguroDraftDispatchReceipt" (
      "dispatchId" UUID PRIMARY KEY REFERENCES "FirmaSeguroDraftDispatch"("id") ON DELETE RESTRICT,
      "processUuid" TEXT NOT NULL UNIQUE CHECK (LENGTH(BTRIM("processUuid")) BETWEEN 1 AND 200),
      "providerStatus" TEXT NOT NULL,
      "createPayload" JSONB NOT NULL,
      "source" TEXT NOT NULL CHECK ("source" IN ('send_response','provider_reconciliation')),
      "actorUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" TEXT,
      "evidence" JSONB NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "FirmaSeguroDraftDispatchReceipt_evidence_check" CHECK
        ("source" <> 'provider_reconciliation' OR
          ("actorUserId" IS NOT NULL AND "actorName" IS NOT NULL AND LENGTH(BTRIM("actorName")) > 0
            AND jsonb_typeof("evidence")='object' AND "evidence" <> '{}'::jsonb))
    )`,
  `CREATE TABLE IF NOT EXISTS "FirmaSeguroDraftDispatchReconciliation" (
      "id" BIGSERIAL PRIMARY KEY,
      "dispatchId" UUID NOT NULL REFERENCES "FirmaSeguroDraftDispatch"("id") ON DELETE RESTRICT,
      "processUuid" TEXT NOT NULL CHECK (LENGTH(BTRIM("processUuid")) BETWEEN 1 AND 200),
      "providerStatus" TEXT NOT NULL,
      "providerPayload" JSONB NOT NULL,
      "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" TEXT NOT NULL CHECK (LENGTH(BTRIM("actorName")) > 0),
      "evidence" JSONB NOT NULL CHECK (jsonb_typeof("evidence")='object' AND "evidence" <> '{}'::jsonb),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  `CREATE INDEX IF NOT EXISTS "FirmaSeguroDraftDispatchReconciliation_latest"
      ON "FirmaSeguroDraftDispatchReconciliation"("dispatchId","id" DESC)`,
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
          OR (OLD."status"='DISPATCHING' AND NEW."status" NOT IN ('DISPATCHING','AWAITING_SIGNATURE','FAILED_SAFE','UNCERTAIN'))
          OR (OLD."status"='UNCERTAIN' AND NEW."status" NOT IN ('UNCERTAIN','AWAITING_SIGNATURE','FAILED_SAFE'))
          OR (OLD."status" IN ('AWAITING_SIGNATURE','FAILED_SAFE')
            AND NEW."status" IS DISTINCT FROM OLD."status")
        THEN RAISE EXCEPTION 'DRAFT_DISPATCH_STATUS_INVALID' USING ERRCODE='23514'; END IF;
        IF NEW."status"='FAILED_SAFE' AND OLD."status" IN ('DISPATCHING','UNCERTAIN')
          AND NOT EXISTS (
            SELECT 1 FROM "FirmaSeguroDraftDispatchReceipt" receipt
            LEFT JOIN LATERAL (
              SELECT reconciliation."providerStatus"
              FROM "FirmaSeguroDraftDispatchReconciliation" reconciliation
              WHERE reconciliation."dispatchId"=NEW."id"
                AND reconciliation."processUuid"=receipt."processUuid"
              ORDER BY reconciliation."id" DESC LIMIT 1
            ) latest ON TRUE
            WHERE receipt."dispatchId"=NEW."id" AND receipt."processUuid"=NEW."processUuid"
              AND upper(btrim(COALESCE(latest."providerStatus",receipt."providerStatus"))) IN
                ('ABORTADA','ABORTADO','ABORTED','ANULADA','ANULADO','CANCELADA','CANCELADO',
                 'CANCELED','CANCELLED','DECLINADA','DECLINADO','DECLINED','EXPIRED','EXPIRADA',
                 'EXPIRADO','RECHAZADA','RECHAZADO','REJECTED','REVOKED')
          ) THEN RAISE EXCEPTION 'DRAFT_DISPATCH_TERMINAL_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
        IF NEW."status"='AWAITING_SIGNATURE' AND OLD."status" IS DISTINCT FROM NEW."status"
          AND NOT EXISTS (
            SELECT 1 FROM "FirmaSeguroDraftDispatchReceipt" receipt
            LEFT JOIN LATERAL (
              SELECT reconciliation."providerStatus"
              FROM "FirmaSeguroDraftDispatchReconciliation" reconciliation
              WHERE reconciliation."dispatchId"=NEW."id"
                AND reconciliation."processUuid"=receipt."processUuid"
              ORDER BY reconciliation."id" DESC LIMIT 1
            ) latest ON TRUE
            JOIN "FirmaSeguroProcess" process ON process."processUuid"=receipt."processUuid"
            JOIN "CreditoBorrador" draft ON draft."id"=NEW."draftId"
            WHERE receipt."dispatchId"=NEW."id" AND receipt."processUuid"=NEW."processUuid"
              AND upper(COALESCE(latest."providerStatus",receipt."providerStatus")) ~
                '(^|[^A-Z0-9])(CREATED|CREADO|PENDING|WAITING|SENT|IN_PROGRESS|IN_PROCESS|INITIATED|STARTED|AWAITING_SIGNATURE|PENDING_SIGNATURE|EN_PROCESO|ENVIADO|COMPLETED|COMPLETE|COMPLETADO|FINALIZED|FINALIZADO|FINISHED|SIGNED|FIRMADO|APROBADO|APROBADA|EXITOSO|EXITOSA|SUCCESS|SUCCESSFUL)([^A-Z0-9]|$)'
              AND upper(COALESCE(latest."providerStatus",receipt."providerStatus")) !~
                '(^|[^A-Z0-9])(NOT|NO|SIN|ABORTADA|ABORTADO|ABORTED|ANULADA|ANULADO|CANCELADA|CANCELADO|CANCELED|CANCELLED|DECLINADA|DECLINADO|DECLINED|ERROR|EXPIRED|EXPIRADA|EXPIRADO|FAILED|FAILURE|RECHAZADA|RECHAZADO|REJECTED|REVOKED)([^A-Z0-9]|$)'
              AND process."draftId"=NEW."draftId" AND process."creditoId" IS NULL
              AND process."draftFolio"=NEW."draftFolio" AND process."draftPayload"=NEW."draftPayload"
              AND process."supersededAt" IS NULL AND draft."estado"='ABIERTO'
              AND draft."creditoId" IS NULL AND draft."payload"=NEW."updatedPayload"
              AND draft."currentStep" IN (3,4)
              AND COALESCE(draft."expiresAt",draft."createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP
          ) THEN RAISE EXCEPTION 'DRAFT_DISPATCH_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
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
  `CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_receipt_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'DRAFT_DISPATCH_RECEIPT_IMMUTABLE' USING ERRCODE='23514';
      END $$`,
  `CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatchReceipt_immutable"
      BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatchReceipt"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_receipt_immutable()`,
  `CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_reconciliation_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'DRAFT_DISPATCH_RECONCILIATION_IMMUTABLE' USING ERRCODE='23514';
      END $$`,
  `CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatchReconciliation_immutable"
      BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatchReconciliation"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_reconciliation_immutable()`,
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
