-- Reviewed source only: run explicitly against an approved database.
-- Additive commission tables; no credit/customer/payment rows are modified.
BEGIN;
SELECT pg_advisory_xact_lock(721041, 0);
CREATE TABLE IF NOT EXISTS "CommissionPeriod" (
  "sellerId" integer NOT NULL REFERENCES "Vendedor"(id),
  "period" varchar(7) NOT NULL CHECK ("period" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' AND "period" >= '2026-10'),
  "creditCount" integer NOT NULL DEFAULT 0 CHECK ("creditCount" >= 0),
  "rate" integer NOT NULL DEFAULT 0 CHECK ("rate" IN (0,20000,25000,30000)),
  "generated" bigint NOT NULL DEFAULT 0 CHECK ("generated" >= 0),
  "credits" jsonb NOT NULL DEFAULT '[]',
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("sellerId", "period")
);
CREATE TABLE IF NOT EXISTS "CommissionRequest" (
  "id" uuid PRIMARY KEY,
  "sellerId" integer NOT NULL REFERENCES "Vendedor"(id),
  "period" varchar(7) NOT NULL,
  "amount" bigint NOT NULL CHECK ("amount" > 0),
  "nequi" varchar(10) NOT NULL CHECK ("nequi" ~ '^3[0-9]{9}$'),
  "status" varchar(10) NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','REJECTED','PAID')),
  "idempotencyKey" varchar(100) NOT NULL,
  "credits" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rejectionReason" text,
  "reviewedAt" timestamptz,
  "reviewedBy" integer REFERENCES "Usuario"(id),
  "paidAt" timestamptz,
  UNIQUE ("sellerId", "idempotencyKey"),
  FOREIGN KEY ("sellerId", "period") REFERENCES "CommissionPeriod"("sellerId", "period"),
  CHECK (("status" = 'REJECTED') = ("rejectionReason" IS NOT NULL)),
  CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "CommissionRequest_seller_period" ON "CommissionRequest"("sellerId", "period", "status");
CREATE TABLE IF NOT EXISTS "CommissionPayment" (
  "requestId" uuid PRIMARY KEY REFERENCES "CommissionRequest"(id),
  "actorId" integer NOT NULL REFERENCES "Usuario"(id),
  "amount" bigint NOT NULL CHECK ("amount" > 0),
  "receiptFileName" varchar(160) NOT NULL,
  "receiptMimeType" varchar(30) NOT NULL CHECK ("receiptMimeType" IN ('application/pdf','image/png','image/jpeg')),
  "receiptBase64" text NOT NULL CHECK (length("receiptBase64") > 0 AND length("receiptBase64") <= 6990508),
  "receiptHash" varchar(64) NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CommissionAudit" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "sellerId" integer NOT NULL REFERENCES "Vendedor"(id),
  "period" varchar(7),
  "requestId" uuid REFERENCES "CommissionRequest"(id),
  "actorId" integer REFERENCES "Usuario"(id),
  "action" varchar(40) NOT NULL,
  "payload" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "CommissionAudit_seller_period" ON "CommissionAudit"("sellerId", "period", "createdAt");
CREATE TABLE IF NOT EXISTS "CommissionCreditSource" (
  "creditId" integer PRIMARY KEY REFERENCES "Credito"(id) ON DELETE RESTRICT,
  "sellerId" integer REFERENCES "Vendedor"(id),
  "finalizedAt" timestamptz,
  "eligible" boolean NOT NULL,
  "isTest" boolean NOT NULL,
  "operationKey" text NOT NULL,
  "identityKey" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "CommissionCreditSource_seller_date" ON "CommissionCreditSource"("sellerId", "finalizedAt");

-- Optional database installation captures every future credit mutation in the
-- auditable journal. First completion is immutable across cancellation/reopen.
CREATE OR REPLACE FUNCTION finser_commission_credit_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  is_complete boolean;
  is_test boolean;
  finalized timestamptz;
  prior "CommissionCreditSource"%ROWTYPE;
  source_snapshot jsonb;
  operation_key text;
  identity_key text;
  old_seller integer;
  origin_branch integer;
  origin_ally integer;
BEGIN
  -- One short global lock also serializes deduplication across sellers.
  PERFORM pg_advisory_xact_lock(721042, 1);
  old_seller := CASE WHEN TG_OP = 'UPDATE' THEN OLD."vendedorId" ELSE NULL END;
  IF old_seller IS NOT NULL AND (NEW."vendedorId" IS NULL OR old_seller < NEW."vendedorId") THEN
    PERFORM pg_advisory_xact_lock(721041, old_seller);
  END IF;
  IF NEW."vendedorId" IS NOT NULL THEN PERFORM pg_advisory_xact_lock(721041, NEW."vendedorId"); END IF;
  IF old_seller IS NOT NULL AND old_seller > COALESCE(NEW."vendedorId", old_seller) THEN
    PERFORM pg_advisory_xact_lock(721041, old_seller);
  END IF;
  SELECT * INTO prior FROM "CommissionCreditSource" WHERE "creditId" = NEW.id;
  is_complete := NEW."contratoAceptadoAt" IS NOT NULL AND NEW."pagareAceptadoAt" IS NOT NULL
    AND (NEW."deliverableReady" OR prior."finalizedAt" IS NOT NULL) AND NEW."montoCredito" > 0
    AND (upper(NEW.estado) IN ('ENTREGABLE','ENTREGADO','FINALIZADO','ACTIVO','AL_DIA','MORA','MORA_BLOQUEADO','ROBO_BLOQUEADO','PAGADO','PAZ_Y_SALVO')
      OR (upper(NEW.estado) IN ('GENERADO','INSCRITO') AND prior."finalizedAt" IS NOT NULL));
  is_test := COALESCE(prior."isTest", false)
    OR COALESCE(NEW."contratoSnapshot"#>>'{comisiones,isTest}', 'false') = 'true'
    OR COALESCE(NEW."contratoSnapshot"->>'isTest', 'false') = 'true'
    OR COALESCE(NEW."contratoSnapshot"->>'testMode', 'false') = 'true'
    OR COALESCE(NEW."contratoSnapshot"->>'modoPrueba', 'false') = 'true'
    OR COALESCE(NEW."contratoSnapshot"->>'duplicateOfCreditId', '') <> ''
    OR upper(NEW."clienteNombre") ~ '(^|[^A-Z])(PRUEBA[S]?|TEST|DEMO)([^A-Z]|$)'
    OR COALESCE(NEW."observacionAdmin", '') ILIKE '%modo prueba%';
  finalized := prior."finalizedAt";
  IF finalized IS NULL AND is_complete THEN
    IF TG_OP = 'UPDATE' AND OLD."contratoAceptadoAt" IS NOT NULL AND OLD."pagareAceptadoAt" IS NOT NULL AND OLD."deliverableReady" THEN
      finalized := GREATEST(OLD."createdAt",OLD."contratoAceptadoAt",OLD."pagareAceptadoAt") AT TIME ZONE 'UTC';
    ELSE finalized := CURRENT_TIMESTAMP; END IF;
  END IF;
  operation_key := COALESCE('solicitud:'||NULLIF(NEW."contratoSnapshot"#>>'{comisiones,solicitudId}', ''),
    'solicitud:'||NULLIF(NEW."contratoSnapshot"->>'solicitudId', ''),'firma:'||NULLIF(NEW."contratoSnapshot"#>>'{firma,procesoUuid}', ''),
    'assessment:'||NULLIF(NEW."contratoSnapshot"#>>'{comisiones,dataCreditoAssessmentId}', ''),'folio:'||NEW.folio);
  identity_key := regexp_replace(COALESCE(NEW."clienteDocumento", ''), '[^0-9]', '', 'g') || ':' || NEW.imei;
  origin_branch := COALESCE((prior.snapshot->>'originBranchId')::integer,(prior.snapshot->>'branchId')::integer,NEW."sedeId");
  origin_ally := COALESCE((prior.snapshot->>'originAllyId')::integer,(SELECT "aliadoId" FROM "Sede" WHERE id=origin_branch));
  source_snapshot := jsonb_build_object('id',NEW.id,'code',NEW.folio,'branchId',NEW."sedeId",
    'originBranchId',origin_branch,'originAllyId',origin_ally,
    'sellerId',NEW."vendedorId",'state',NEW.estado,'eligible',is_complete,'isTest',is_test,
    'finalizedAt',finalized,'operationKey',operation_key,'identityKey',identity_key);
  INSERT INTO "CommissionCreditSource" ("creditId","sellerId","finalizedAt","eligible","isTest","operationKey","identityKey","snapshot")
  VALUES (NEW.id,NEW."vendedorId",finalized,is_complete,is_test,operation_key,identity_key,source_snapshot)
  ON CONFLICT ("creditId") DO UPDATE SET "sellerId"=EXCLUDED."sellerId","finalizedAt"=EXCLUDED."finalizedAt",
    "eligible"=EXCLUDED."eligible","isTest"=EXCLUDED."isTest","operationKey"=EXCLUDED."operationKey",
    "identityKey"=EXCLUDED."identityKey","snapshot"=EXCLUDED."snapshot","updatedAt"=CURRENT_TIMESTAMP;
  IF prior.snapshot IS DISTINCT FROM source_snapshot THEN
    IF NEW."vendedorId" IS NOT NULL THEN
      INSERT INTO "CommissionAudit"("sellerId","period","action","payload")
      VALUES(NEW."vendedorId",to_char(finalized AT TIME ZONE 'America/Bogota','YYYY-MM'),'CREDIT_CHANGED',
        jsonb_build_object('previous',prior.snapshot,'current',source_snapshot));
    END IF;
    IF old_seller IS NOT NULL AND old_seller IS DISTINCT FROM NEW."vendedorId" THEN
      INSERT INTO "CommissionAudit"("sellerId","period","action","payload")
      VALUES(old_seller,to_char(finalized AT TIME ZONE 'America/Bogota','YYYY-MM'),'CREDIT_REASSIGNED',
        jsonb_build_object('previous',prior.snapshot,'current',source_snapshot));
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finser_commission_credit_source_trigger ON "Credito";
CREATE TRIGGER finser_commission_credit_source_trigger AFTER INSERT OR UPDATE ON "Credito"
FOR EACH ROW EXECUTE FUNCTION finser_commission_credit_source();

CREATE OR REPLACE FUNCTION finser_commission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Commission audit and payments are immutable'; END $$;
DROP TRIGGER IF EXISTS finser_commission_audit_immutable ON "CommissionAudit";
CREATE TRIGGER finser_commission_audit_immutable BEFORE UPDATE OR DELETE ON "CommissionAudit"
FOR EACH ROW EXECUTE FUNCTION finser_commission_immutable();
DROP TRIGGER IF EXISTS finser_commission_payment_immutable ON "CommissionPayment";
CREATE TRIGGER finser_commission_payment_immutable BEFORE UPDATE OR DELETE ON "CommissionPayment"
FOR EACH ROW EXECUTE FUNCTION finser_commission_immutable();
COMMIT;
