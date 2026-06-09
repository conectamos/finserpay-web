import prisma from "@/lib/prisma";

export type FirmaSeguroProcessRow = {
  id: number;
  creditoId: number;
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
};

type UpsertInput = {
  creditoId: number;
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

function jsonValue(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

async function runFirmaSeguroSchemaSetup() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FirmaSeguroProcess" (
      "id" SERIAL PRIMARY KEY,
      "creditoId" INTEGER NOT NULL,
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
      "completedAt" TIMESTAMP(3)
    )
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
    CREATE INDEX IF NOT EXISTS "FirmaSeguroProcess_status_idx"
      ON "FirmaSeguroProcess" ("status")
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
        COALESCE($3, 'CREATED'),
        $4::jsonb,
        $5::jsonb,
        $6::jsonb,
        $7::jsonb,
        $8::jsonb,
        $9,
        $10,
        $11,
        $12
      )
      ON CONFLICT ("processUuid") DO UPDATE SET
        "creditoId" = EXCLUDED."creditoId",
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
      RETURNING *
    `,
    input.creditoId,
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

export async function getLatestFirmaSeguroProcessByCredit(creditoId: number) {
  await ensureFirmaSeguroSchema();

  const rows = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `
      SELECT *
      FROM "FirmaSeguroProcess"
      WHERE "creditoId" = $1
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 1
    `,
    creditoId
  );

  return rows[0] || null;
}

export async function getFirmaSeguroProcessByUuid(processUuid: string) {
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
        "signedDocumentBase64" = COALESCE($6, "signedDocumentBase64"),
        "signedDocumentFileName" = COALESCE($7, "signedDocumentFileName"),
        "lastError" = $8,
        "completedAt" = COALESCE($9, "completedAt"),
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
