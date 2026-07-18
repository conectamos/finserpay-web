import prisma from "@/lib/prisma";

let moraBlockExemptionsReady = false;

export type MoraBlockExemption = {
  id: number;
  documento: string;
  motivo: string;
  activa: boolean;
  fechaFin: Date | null;
  creadoPorUsuarioId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export function normalizeMoraExemptionDocument(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 20);
}

export async function ensureMoraBlockExemptionTable() {
  if (moraBlockExemptionsReady) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ExcepcionBloqueoMora" (
      id SERIAL PRIMARY KEY,
      documento TEXT NOT NULL,
      motivo TEXT NOT NULL,
      activa BOOLEAN NOT NULL DEFAULT TRUE,
      "fechaFin" TIMESTAMP(3),
      "creadoPorUsuarioId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "ExcepcionBloqueoMora_documento_key"
    ON "ExcepcionBloqueoMora" (documento)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "ExcepcionBloqueoMora_activa_fechaFin_idx"
    ON "ExcepcionBloqueoMora" (activa, "fechaFin")
  `);

  moraBlockExemptionsReady = true;
}

export async function listActiveMoraBlockExemptions(
  effectiveAt: Date = new Date()
) {
  await ensureMoraBlockExemptionTable();

  return prisma.$queryRaw<MoraBlockExemption[]>`
    SELECT
      id,
      documento,
      motivo,
      activa,
      "fechaFin",
      "creadoPorUsuarioId",
      "createdAt",
      "updatedAt"
    FROM "ExcepcionBloqueoMora"
    WHERE activa = TRUE
      AND ("fechaFin" IS NULL OR "fechaFin" >= ${effectiveAt})
    ORDER BY "createdAt" DESC, id DESC
  `;
}

export async function getActiveMoraBlockExemptionDocuments(
  effectiveAt: Date = new Date()
) {
  const rows = await listActiveMoraBlockExemptions(effectiveAt);
  return new Set(rows.map((row) => normalizeMoraExemptionDocument(row.documento)));
}

export async function isMoraBlockExempt(
  documento: unknown,
  effectiveAt: Date = new Date()
) {
  const normalized = normalizeMoraExemptionDocument(documento);

  if (!normalized) {
    return false;
  }

  await ensureMoraBlockExemptionTable();
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM "ExcepcionBloqueoMora"
      WHERE documento = ${normalized}
        AND activa = TRUE
        AND ("fechaFin" IS NULL OR "fechaFin" >= ${effectiveAt})
    ) AS "exists"
  `;

  return Boolean(rows[0]?.exists);
}

export async function upsertMoraBlockExemption(input: {
  documento: unknown;
  motivo: unknown;
  fechaFin?: Date | null;
  creadoPorUsuarioId?: number | null;
}) {
  const documento = normalizeMoraExemptionDocument(input.documento);
  const motivo = String(input.motivo ?? "").trim().slice(0, 500);

  if (documento.length < 5) {
    throw new Error("La cedula no es valida");
  }

  if (motivo.length < 3) {
    throw new Error("Indica el motivo del acuerdo");
  }

  await ensureMoraBlockExemptionTable();
  const rows = await prisma.$queryRaw<MoraBlockExemption[]>`
    INSERT INTO "ExcepcionBloqueoMora" (
      documento,
      motivo,
      activa,
      "fechaFin",
      "creadoPorUsuarioId",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${documento},
      ${motivo},
      TRUE,
      ${input.fechaFin ?? null},
      ${input.creadoPorUsuarioId ?? null},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (documento) DO UPDATE SET
      motivo = EXCLUDED.motivo,
      activa = TRUE,
      "fechaFin" = EXCLUDED."fechaFin",
      "creadoPorUsuarioId" = EXCLUDED."creadoPorUsuarioId",
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING
      id,
      documento,
      motivo,
      activa,
      "fechaFin",
      "creadoPorUsuarioId",
      "createdAt",
      "updatedAt"
  `;

  return rows[0];
}

export async function deactivateMoraBlockExemption(documento: unknown) {
  const normalized = normalizeMoraExemptionDocument(documento);

  if (!normalized) {
    throw new Error("La cedula no es valida");
  }

  await ensureMoraBlockExemptionTable();
  const rows = await prisma.$queryRaw<MoraBlockExemption[]>`
    UPDATE "ExcepcionBloqueoMora"
    SET activa = FALSE, "updatedAt" = CURRENT_TIMESTAMP
    WHERE documento = ${normalized}
    RETURNING
      id,
      documento,
      motivo,
      activa,
      "fechaFin",
      "creadoPorUsuarioId",
      "createdAt",
      "updatedAt"
  `;

  return rows[0] ?? null;
}
