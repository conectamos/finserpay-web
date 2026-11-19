import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";

type CorrectionDb = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
let schemaReady: Promise<void> | null = null;

/** Separate from French amortization revisions; never stores a replacement receipt. */
export function ensureHistoricalPlanCorrectionSchema() {
  if (!schemaReady) schemaReady = (async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CreditHistoricalPlanCorrection" (
      "id" TEXT PRIMARY KEY,
      "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      "usuarioId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      "nombreUsuario" TEXT NOT NULL,
      "motivo" TEXT NOT NULL,
      "idempotencyKey" TEXT NOT NULL,
      "requestHash" TEXT NOT NULL,
      "previewHash" TEXT NOT NULL,
      "beforeSnapshot" JSONB NOT NULL,
      "afterSnapshot" JSONB NOT NULL,
      "resultado" JSONB NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("creditoId", "idempotencyKey")
    )`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditHistoricalPlanCorrection_creditoId_createdAt_idx"
      ON "CreditHistoricalPlanCorrection" ("creditoId", "createdAt", "id")`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION finser_historical_plan_correction_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Historical plan correction audit is immutable';
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "CreditHistoricalPlanCorrection_immutable"
      BEFORE UPDATE OR DELETE OR TRUNCATE ON "CreditHistoricalPlanCorrection"
      FOR EACH STATEMENT EXECUTE FUNCTION finser_historical_plan_correction_immutable()`);
  })().catch(error => { schemaReady = null; throw error; });
  return schemaReady;
}

export async function findHistoricalPlanCorrection(db: CorrectionDb, creditoId: number, key: string) {
  const rows = await db.$queryRawUnsafe<Array<{ id: string; requestHash: string; resultado: Record<string, unknown> }>>(
    `SELECT "id", "requestHash", "resultado" FROM "CreditHistoricalPlanCorrection"
     WHERE "creditoId"=$1 AND "idempotencyKey"=$2 LIMIT 1`, creditoId, key,
  );
  return rows[0] || null;
}

export async function persistHistoricalPlanCorrection(db: CorrectionDb, input: {
  creditoId: number; usuarioId: number; nombreUsuario: string; motivo: string;
  idempotencyKey: string; requestHash: string; previewHash: string;
  beforeSnapshot: unknown; afterSnapshot: unknown; resultado: unknown;
}) {
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "CreditHistoricalPlanCorrection"
      ("id","creditoId","usuarioId","nombreUsuario","motivo","idempotencyKey","requestHash","previewHash",
       "beforeSnapshot","afterSnapshot","resultado")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)`,
    id, input.creditoId, input.usuarioId, input.nombreUsuario, input.motivo,
    input.idempotencyKey, input.requestHash, input.previewHash,
    JSON.stringify(input.beforeSnapshot), JSON.stringify(input.afterSnapshot), JSON.stringify(input.resultado),
  );
  return id;
}
