import { Client } from "pg";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";

export type FirmaSeguroProcessRow = {
  id: number;
  creditoId: number | null;
  draftId: number | null;
  draftFolio: string | null;
  draftPayload: unknown;
  processUuid: string;
  status: string;
  requestPayload: unknown;
  createPayload: unknown;
  statusPayload: unknown;
  signaturesPayload: unknown;
  documentsPayload: unknown;
  signedDocumentBase64: string | null;
  signedDocumentFileName: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  supersededAt: Date | null;
  supersededByUserId: number | null;
  supersededReason: string | null;
};

type UpsertInput = {
  creditoId?: number | null;
  draftId?: number | null;
  draftFolio?: string | null;
  draftPayload?: unknown;
  processUuid: string;
  status?: string | null;
  requestPayload?: unknown;
  createPayload?: unknown;
  statusPayload?: unknown;
  signaturesPayload?: unknown;
  documentsPayload?: unknown;
  signedDocumentBase64?: string | null;
  signedDocumentFileName?: string | null;
  lastError?: string | null;
  completedAt?: Date | null;
};

type UpdateInput = {
  status?: string | null;
  statusPayload?: unknown;
  signaturesPayload?: unknown;
  documentsPayload?: unknown;
  signedDocumentBase64?: string | null;
  signedDocumentFileName?: string | null;
  lastError?: string | null;
  completedAt?: Date | null;
};

let firmaSeguroSchemaPromise: Promise<void> | null = null;
export const SOLICITUD_OPERATION_LOCK_NAMESPACE = 1_179_865_177;
export const FIRMASEGURO_DRAFT_LOCK_NAMESPACE =
  SOLICITUD_OPERATION_LOCK_NAMESPACE;

function assertSolicitudOperationLockId(draftId: number) {
  if (!Number.isSafeInteger(draftId) || draftId <= 0 || draftId > 2_147_483_647) {
    throw new Error("SOLICITUD_OPERATION_LOCK_INVALID");
  }
}

export async function lockSolicitudOperationMutation(
  database: Prisma.TransactionClient,
  draftId: number
) {
  assertSolicitudOperationLockId(draftId);
  const rows = await database.$queryRawUnsafe<Array<{ locked: number }>>(
    `
      SELECT 1::integer AS "locked"
      FROM pg_advisory_xact_lock($1::integer, $2::integer)
    `,
    SOLICITUD_OPERATION_LOCK_NAMESPACE,
    draftId
  );
  if (rows[0]?.locked !== 1) {
    throw new Error("SOLICITUD_OPERATION_LOCK_FAILED");
  }
}

export async function lockFirmaSeguroDraftMutation(
  database: Prisma.TransactionClient,
  draftId: number
) {
  return lockSolicitudOperationMutation(database, draftId);
}

function jsonValue(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

async function runFirmaSeguroSchemaSetup() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FirmaSeguroProcess" (
      "id" SERIAL PRIMARY KEY,
      "creditoId" INTEGER,
      "draftId" INTEGER,
      "draftFolio" TEXT,
      "draftPayload" JSONB,
      "processUuid" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'CREATED',
      "requestPayload" JSONB,
      "createPayload" JSONB,
      "statusPayload" JSONB,
      "signaturesPayload" JSONB,
      "documentsPayload" JSONB,
      "signedDocumentBase64" TEXT,
      "signedDocumentFileName" TEXT,
      "lastError" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "completedAt" TIMESTAMP(3),
      "supersededAt" TIMESTAMPTZ,
      "supersededByUserId" INTEGER,
      "supersededReason" TEXT
    )
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "FirmaSeguroProcess"
      ALTER COLUMN "creditoId" DROP NOT NULL
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "FirmaSeguroProcess"
      ADD COLUMN IF NOT EXISTS "draftId" INTEGER,
      ADD COLUMN IF NOT EXISTS "draftFolio" TEXT,
      ADD COLUMN IF NOT EXISTS "draftPayload" JSONB,
      ADD COLUMN IF NOT EXISTS "supersededAt" TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS "supersededByUserId" INTEGER,
      ADD COLUMN IF NOT EXISTS "supersededReason" TEXT
    `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'FirmaSeguroProcess_creditoId_fkey'
      ) THEN
        ALTER TABLE "FirmaSeguroProcess"
          ADD CONSTRAINT "FirmaSeguroProcess_creditoId_fkey"
          FOREIGN KEY ("creditoId") REFERENCES "Credito"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END
    $$
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "FirmaSeguroProcess_processUuid_key"
      ON "FirmaSeguroProcess" ("processUuid")
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "FirmaSeguroProcess_creditoId_createdAt_idx"
      ON "FirmaSeguroProcess" ("creditoId", "createdAt" DESC)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "FirmaSeguroProcess_draftId_createdAt_idx"
      ON "FirmaSeguroProcess" ("draftId", "createdAt" DESC)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "FirmaSeguroProcess_status_idx"
      ON "FirmaSeguroProcess" ("status")
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "FirmaSeguroProcess_draft_active_idx"
      ON "FirmaSeguroProcess" ("draftId", "createdAt" DESC, "id" DESC)
      WHERE "supersededAt" IS NULL
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SolicitudImeiCorrectionAudit" (
      "id" UUID PRIMARY KEY,
      "correlationId" UUID NOT NULL,
      "draftId" INTEGER NOT NULL,
      "eventType" TEXT NOT NULL,
      "previousImei" TEXT NOT NULL,
      "newImei" TEXT NOT NULL,
      "reason" TEXT NOT NULL,
      "actorUserId" INTEGER NOT NULL,
      "actorName" TEXT NOT NULL,
      "previousProcessUuid" TEXT,
      "newProcessUuid" TEXT,
      "archivedEvidence" JSONB,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SolicitudImeiCorrectionAudit_event_check"
        CHECK ("eventType" IN ('CORRECTED', 'REISSUED')),
      CONSTRAINT "SolicitudImeiCorrectionAudit_previous_imei_check"
        CHECK ("previousImei" ~ '^[0-9]{15}$'),
      CONSTRAINT "SolicitudImeiCorrectionAudit_new_imei_check"
        CHECK ("newImei" ~ '^[0-9]{15}$'),
      CONSTRAINT "SolicitudImeiCorrectionAudit_reason_check"
        CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500)
    )
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "SolicitudImeiCorrectionAudit"
      ADD COLUMN IF NOT EXISTS "archivedEvidence" JSONB
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "SolicitudImeiCorrectionAudit_event_key"
      ON "SolicitudImeiCorrectionAudit" ("correlationId", "eventType")
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "SolicitudImeiCorrectionAudit_draft_created_idx"
      ON "SolicitudImeiCorrectionAudit" ("draftId", "createdAt" DESC)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION "FinserRejectImeiCorrectionAuditMutation"()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'Solicitud IMEI correction audit records are immutable';
    END;
    $$ LANGUAGE plpgsql
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        ${SOLICITUD_OPERATION_LOCK_NAMESPACE}::integer,
        2::integer
      );
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'SolicitudImeiCorrectionAudit_immutable'
          AND tgrelid = '"SolicitudImeiCorrectionAudit"'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER "SolicitudImeiCorrectionAudit_immutable"
          BEFORE UPDATE OR DELETE ON "SolicitudImeiCorrectionAudit"
          FOR EACH ROW EXECUTE FUNCTION "FinserRejectImeiCorrectionAuditMutation"();
      END IF;
    END
    $$
  `);
}

export async function ensureFirmaSeguroSchema() {
  if (!firmaSeguroSchemaPromise) {
    firmaSeguroSchemaPromise = runFirmaSeguroSchemaSetup().catch((error) => {
      firmaSeguroSchemaPromise = null;
      throw error;
    });
  }

  await firmaSeguroSchemaPromise;
}

export async function upsertFirmaSeguroProcess(input: UpsertInput) {
  await ensureFirmaSeguroSchema();

  const rows = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      INSERT INTO "FirmaSeguroProcess" (
        "creditoId",
        "draftId",
        "draftFolio",
        "draftPayload",
        "processUuid",
        "status",
        "requestPayload",
        "createPayload",
        "statusPayload",
        "signaturesPayload",
        "documentsPayload",
        "signedDocumentBase64",
        "signedDocumentFileName",
        "lastError",
        "completedAt"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::jsonb,
        $5,
        COALESCE($6, 'CREATED'),
        $7::jsonb,
        $8::jsonb,
        $9::jsonb,
        $10::jsonb,
        $11::jsonb,
        $12,
        $13,
        $14,
        $15
      )
      ON CONFLICT ("processUuid") DO UPDATE SET
        "creditoId" = COALESCE(EXCLUDED."creditoId", "FirmaSeguroProcess"."creditoId"),
        "draftId" = COALESCE(EXCLUDED."draftId", "FirmaSeguroProcess"."draftId"),
        "draftFolio" = COALESCE(EXCLUDED."draftFolio", "FirmaSeguroProcess"."draftFolio"),
        "draftPayload" = COALESCE(EXCLUDED."draftPayload", "FirmaSeguroProcess"."draftPayload"),
        "status" = EXCLUDED."status",
        "requestPayload" = COALESCE(EXCLUDED."requestPayload", "FirmaSeguroProcess"."requestPayload"),
        "createPayload" = COALESCE(EXCLUDED."createPayload", "FirmaSeguroProcess"."createPayload"),
        "statusPayload" = COALESCE(EXCLUDED."statusPayload", "FirmaSeguroProcess"."statusPayload"),
        "signaturesPayload" = COALESCE(EXCLUDED."signaturesPayload", "FirmaSeguroProcess"."signaturesPayload"),
        "documentsPayload" = COALESCE(EXCLUDED."documentsPayload", "FirmaSeguroProcess"."documentsPayload"),
        "signedDocumentBase64" = COALESCE(EXCLUDED."signedDocumentBase64", "FirmaSeguroProcess"."signedDocumentBase64"),
        "signedDocumentFileName" = COALESCE(EXCLUDED."signedDocumentFileName", "FirmaSeguroProcess"."signedDocumentFileName"),
        "lastError" = EXCLUDED."lastError",
        "completedAt" = COALESCE(EXCLUDED."completedAt", "FirmaSeguroProcess"."completedAt"),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "FirmaSeguroProcess"."supersededAt" IS NULL
        AND "FirmaSeguroProcess"."draftId" IS NOT DISTINCT FROM EXCLUDED."draftId"
        AND "FirmaSeguroProcess"."creditoId" IS NOT DISTINCT FROM EXCLUDED."creditoId"
      RETURNING *
    `,
    input.creditoId || null,
    input.draftId || null,
    input.draftFolio || null,
    jsonValue(input.draftPayload),
    input.processUuid,
    input.status || null,
    jsonValue(input.requestPayload),
    jsonValue(input.createPayload),
    jsonValue(input.statusPayload),
    jsonValue(input.signaturesPayload),
    jsonValue(input.documentsPayload),
    input.signedDocumentBase64 || null,
    input.signedDocumentFileName || null,
    input.lastError || null,
    input.completedAt || null
  );

  return rows[0] || null;
}

export async function linkFirmaSeguroProcessToCredit(
  processUuid: string,
  creditoId: number,
  draftId: number,
  database: Prisma.TransactionClient | typeof prisma = prisma
) {
  await ensureFirmaSeguroSchema();

  const rows = await database.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      UPDATE "FirmaSeguroProcess"
      SET
        "creditoId" = $2,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "processUuid" = $1
        AND "draftId" = $3
        AND "supersededAt" IS NULL
        AND ("creditoId" IS NULL OR "creditoId" = $2)
      RETURNING *
    `,
    processUuid,
    creditoId,
    draftId
  );

  return rows[0] || null;
}

export async function getLatestFirmaSeguroProcessByCredit(creditoId: number) {
  await ensureFirmaSeguroSchema();

  const rows = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      SELECT *
      FROM "FirmaSeguroProcess"
      WHERE "creditoId" = $1
        AND "supersededAt" IS NULL
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 1
    `,
    creditoId
  );

  return rows[0] || null;
}

export async function getLatestSignedFirmaSeguroProcessByCredit(
  creditoId: number
) {
  await ensureFirmaSeguroSchema();

  const rows = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      SELECT *
      FROM "FirmaSeguroProcess"
      WHERE "creditoId" = $1
        AND "supersededAt" IS NULL
        AND COALESCE("signedDocumentBase64", '') <> ''
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 1
    `,
    creditoId
  );

  return rows[0] || null;
}

export async function getCreditIdsWithSignedFirmaSeguroDocument(
  creditIds: number[]
) {
  const normalizedIds = Array.from(
    new Set(
      creditIds.filter(
        (creditId) => Number.isInteger(creditId) && creditId > 0
      )
    )
  );

  if (normalizedIds.length === 0) return [];

  await ensureFirmaSeguroSchema();
  const placeholders = normalizedIds
    .map((_, index) => `$${index + 1}`)
    .join(", ");
  const rows = await prisma.$queryRawUnsafe<Array<{ creditoId: number }>>(
    `
      SELECT DISTINCT "creditoId"
      FROM "FirmaSeguroProcess"
      WHERE "creditoId" IN (${placeholders})
        AND "supersededAt" IS NULL
        AND COALESCE("signedDocumentBase64", '') <> ''
    `,
    ...normalizedIds
  );

  return rows.map((row) => Number(row.creditoId));
}

export async function getLatestFirmaSeguroProcessByDraft(draftId: number) {
  await ensureFirmaSeguroSchema();

  const rows = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      SELECT *
      FROM "FirmaSeguroProcess"
      WHERE "draftId" = $1
        AND "supersededAt" IS NULL
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 1
    `,
    draftId
  );

  return rows[0] || null;
}

export async function tryAcquireSolicitudOperationLock(draftId: number) {
  assertSolicitudOperationLockId(draftId);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
  });
  let connected = false;
  let acquired = false;

  try {
    await client.connect();
    connected = true;
    const result = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired`,
      [SOLICITUD_OPERATION_LOCK_NAMESPACE, draftId]
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) {
      await client.end();
      return null;
    }
  } catch (error) {
    if (connected) await client.end().catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        if (acquired) {
          await client.query(
            `SELECT pg_advisory_unlock($1::integer, $2::integer)`,
            [SOLICITUD_OPERATION_LOCK_NAMESPACE, draftId]
          );
        }
      } catch (error) {
        console.error("ERROR LIBERANDO LOCK DE OPERACION DE SOLICITUD:", {
          draftId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

export async function tryAcquireFirmaSeguroDraftDispatchLock(draftId: number) {
  return tryAcquireSolicitudOperationLock(draftId);
}

export async function getFirmaSeguroProcessByUuid(processUuid: string) {
  await ensureFirmaSeguroSchema();

  const rows = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      SELECT *
      FROM "FirmaSeguroProcess"
      WHERE "processUuid" = $1
        AND "supersededAt" IS NULL
      LIMIT 1
    `,
    processUuid
  );

  return rows[0] || null;
}

export async function getFirmaSeguroProcessByUuidIncludingSuperseded(
  processUuid: string
) {
  await ensureFirmaSeguroSchema();

  const rows = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      SELECT *
      FROM "FirmaSeguroProcess"
      WHERE "processUuid" = $1
      LIMIT 1
    `,
    processUuid
  );

  return rows[0] || null;
}

export async function markFirmaSeguroDraftProcessesSuperseded(
  database: Prisma.TransactionClient,
  input: {
    draftId: number;
    actorUserId: number;
    reason: string;
  }
) {
  await ensureFirmaSeguroSchema();

  return database.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      UPDATE "FirmaSeguroProcess"
      SET "supersededAt" = CURRENT_TIMESTAMP,
          "supersededByUserId" = $2,
          "supersededReason" = $3
      WHERE "draftId" = $1
        AND "supersededAt" IS NULL
        AND "creditoId" IS NULL
      RETURNING *
    `,
    input.draftId,
    input.actorUserId,
    input.reason
  );
}

export async function updateFirmaSeguroProcess(
  processUuid: string,
  input: UpdateInput
) {
  await ensureFirmaSeguroSchema();

  const rows = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      UPDATE "FirmaSeguroProcess"
      SET
        "status" = COALESCE($2, "status"),
        "statusPayload" = COALESCE($3::jsonb, "statusPayload"),
        "signaturesPayload" = COALESCE($4::jsonb, "signaturesPayload"),
        "documentsPayload" = COALESCE($5::jsonb, "documentsPayload"),
        "signedDocumentBase64" = COALESCE(
          NULLIF("signedDocumentBase64", ''),
          $6
        ),
        "signedDocumentFileName" = COALESCE(
          NULLIF("signedDocumentFileName", ''),
          $7
        ),
        "lastError" = $8,
        "completedAt" = COALESCE("completedAt", $9),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "processUuid" = $1
      RETURNING *
    `,
    processUuid,
    input.status || null,
    jsonValue(input.statusPayload),
    jsonValue(input.signaturesPayload),
    jsonValue(input.documentsPayload),
    input.signedDocumentBase64 || null,
    input.signedDocumentFileName || null,
    input.lastError || null,
    input.completedAt || null
  );

  return rows[0] || null;
}
