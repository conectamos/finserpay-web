import pg from "pg";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL no está configurada para remisiones de garantía.");
const client = new pg.Client({
  application_name: "finserpay-replacement-remission-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

export const statements = [
  `CREATE TABLE IF NOT EXISTS "CreditDeviceReplacementRemission" (
    "id" UUID PRIMARY KEY,
    "replacementId" UUID NOT NULL REFERENCES "CreditDeviceReplacement"("id") ON DELETE RESTRICT,
    "version" INTEGER NOT NULL CHECK ("version" > 0),
    "status" TEXT NOT NULL CHECK ("status" IN ('PENDING_UPLOAD','PENDING_REVIEW','VERIFIED','REJECTED')),
    "requestedByUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE SET NULL,
    "requestedByName" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "photoMime" TEXT,
    "photoData" BYTEA,
    "photoSha256" CHAR(64),
    "uploadedByUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE SET NULL,
    "uploadedByName" TEXT,
    "uploadedAt" TIMESTAMPTZ,
    "reviewedByUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE SET NULL,
    "reviewedByName" TEXT,
    "reviewedAt" TIMESTAMPTZ,
    "reviewNote" TEXT,
    CONSTRAINT "CreditDeviceReplacementRemission_unique_version" UNIQUE ("replacementId","version"),
    CONSTRAINT "CreditDeviceReplacementRemission_photo_check" CHECK (
      ("status"='PENDING_UPLOAD' AND "photoData" IS NULL AND "photoMime" IS NULL AND "photoSha256" IS NULL
        AND "uploadedAt" IS NULL)
      OR ("status"<>'PENDING_UPLOAD' AND "photoData" IS NOT NULL
        AND "photoMime" IN ('image/jpeg','image/png')
        AND "photoSha256" ~ '^[a-f0-9]{64}$'
        AND OCTET_LENGTH("photoData") <= 10485760
        AND "uploadedAt" IS NOT NULL)
    ),
    CONSTRAINT "CreditDeviceReplacementRemission_review_check" CHECK (
      ("status" IN ('PENDING_UPLOAD','PENDING_REVIEW') AND "reviewedAt" IS NULL)
      OR ("status" IN ('VERIFIED','REJECTED') AND "reviewedAt" IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditDeviceReplacementRemission_latest"
    ON "CreditDeviceReplacementRemission"("replacementId","version" DESC)`,
  `CREATE TABLE IF NOT EXISTS "CreditDeviceReplacementRemissionEvent" (
    "id" UUID PRIMARY KEY,
    "remissionId" UUID NOT NULL REFERENCES "CreditDeviceReplacementRemission"("id") ON DELETE RESTRICT,
    "eventType" TEXT NOT NULL CHECK ("eventType" IN ('REQUESTED','UPLOADED','VERIFIED','REJECTED')),
    "actorUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE SET NULL,
    "actorName" TEXT NOT NULL,
    "photoSha256" CHAR(64),
    "note" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditDeviceReplacementRemissionEvent_history"
    ON "CreditDeviceReplacementRemissionEvent"("remissionId","createdAt","id")`,
  `CREATE OR REPLACE FUNCTION public.finser_remission_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'REMISSION_EVIDENCE_IMMUTABLE' USING ERRCODE='23514';
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditDeviceReplacementRemissionEvent_immutable"
    BEFORE UPDATE OR DELETE ON "CreditDeviceReplacementRemissionEvent"
    FOR EACH ROW EXECUTE FUNCTION public.finser_remission_immutable()`,
  `CREATE OR REPLACE FUNCTION public.finser_remission_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REMISSION_EVIDENCE_IMMUTABLE' USING ERRCODE='23514'; END IF;
      IF ROW(OLD."id",OLD."replacementId",OLD."version",OLD."requestedByUserId",OLD."requestedByName",OLD."requestedAt")
         IS DISTINCT FROM ROW(NEW."id",NEW."replacementId",NEW."version",NEW."requestedByUserId",NEW."requestedByName",NEW."requestedAt")
        OR (OLD."photoData" IS NOT NULL AND ROW(OLD."photoData",OLD."photoMime",OLD."photoSha256",OLD."uploadedByUserId",OLD."uploadedByName",OLD."uploadedAt")
         IS DISTINCT FROM ROW(NEW."photoData",NEW."photoMime",NEW."photoSha256",NEW."uploadedByUserId",NEW."uploadedByName",NEW."uploadedAt"))
      THEN RAISE EXCEPTION 'REMISSION_EVIDENCE_IMMUTABLE' USING ERRCODE='23514'; END IF;
      IF NOT ((OLD."status"='PENDING_UPLOAD' AND NEW."status"='PENDING_REVIEW')
        OR (OLD."status"='PENDING_REVIEW' AND NEW."status" IN ('VERIFIED','REJECTED')))
      THEN RAISE EXCEPTION 'REMISSION_STATE_INVALID' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditDeviceReplacementRemission_guard"
    BEFORE UPDATE OR DELETE ON "CreditDeviceReplacementRemission"
    FOR EACH ROW EXECUTE FUNCTION public.finser_remission_guard()`,
];

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))", ["finserpay-replacement-remission-schema"]);
  for (const statement of statements) await client.query(statement);
  await client.query("COMMIT");
  console.log("Esquema de remisiones por garantía verificado.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
