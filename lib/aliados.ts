import type { PrismaClient } from "@/app/generated/prisma/client";

export const ALIADO_CONECTAMOS = {
  nombre: "CONECTAMOS",
  codigo: "CONECTAMOS",
} as const;

export const ALIADO_FINSER_PAY = {
  nombre: "FINSER PAY",
  codigo: "FINSERPAY",
} as const;

export const DEFAULT_REDESCUENTO_PERCENTAGE = 10;

type AliadoClient = Pick<PrismaClient, "aliado">;
type AliadoBootstrapClient = Pick<PrismaClient, "aliado" | "sede">;
type AliadoSchemaClient = Pick<PrismaClient, "$executeRawUnsafe">;
type CentralAdminClient = Pick<PrismaClient, "aliado" | "sede" | "usuario">;

let aliadoSchemaPromise: Promise<void> | null = null;

async function runAliadoSchemaSetup(prisma: AliadoSchemaClient) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Aliado" (
      "id" SERIAL PRIMARY KEY,
      "nombre" TEXT NOT NULL,
      "codigo" TEXT,
      "activo" BOOLEAN NOT NULL DEFAULT true,
      "redescuentoPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT ${DEFAULT_REDESCUENTO_PERCENTAGE},
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Aliado"
      ADD COLUMN IF NOT EXISTS "redescuentoPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT ${DEFAULT_REDESCUENTO_PERCENTAGE}
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Aliado_nombre_key"
      ON "Aliado" ("nombre")
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Aliado_codigo_key"
      ON "Aliado" ("codigo")
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Aliado_activo_idx"
      ON "Aliado" ("activo")
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Sede"
      ADD COLUMN IF NOT EXISTS "aliadoId" INTEGER
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'Sede_aliadoId_fkey'
      ) THEN
        ALTER TABLE "Sede"
          ADD CONSTRAINT "Sede_aliadoId_fkey"
          FOREIGN KEY ("aliadoId") REFERENCES "Aliado"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END
    $$
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Sede_aliadoId_idx"
      ON "Sede" ("aliadoId")
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Sede" DROP CONSTRAINT IF EXISTS "Sede_nombre_key"
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Sede" DROP CONSTRAINT IF EXISTS "Sede_codigo_key"
  `);

  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "Sede_nombre_key"
  `);

  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "Sede_codigo_key"
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Sede_aliadoId_nombre_key"
      ON "Sede" ("aliadoId", "nombre")
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Sede_aliadoId_codigo_key"
      ON "Sede" ("aliadoId", "codigo")
  `);
}

export async function ensureAliadoSchema(prisma: AliadoSchemaClient) {
  if (!aliadoSchemaPromise) {
    aliadoSchemaPromise = runAliadoSchemaSetup(prisma).catch((error) => {
      aliadoSchemaPromise = null;
      throw error;
    });
  }

  await aliadoSchemaPromise;
}

export async function ensureAliadoConectamos(prisma: AliadoBootstrapClient) {
  const aliado = await prisma.aliado.upsert({
    where: {
      nombre: ALIADO_CONECTAMOS.nombre,
    },
    update: {
      codigo: ALIADO_CONECTAMOS.codigo,
      activo: true,
    },
    create: {
      nombre: ALIADO_CONECTAMOS.nombre,
      codigo: ALIADO_CONECTAMOS.codigo,
      activo: true,
    },
    select: {
      id: true,
      nombre: true,
      codigo: true,
      activo: true,
    },
  });

  await prisma.sede.updateMany({
    where: {
      aliadoId: null,
      nombre: {
        notIn: ["ADMIN FINSER PAY", "RECAUDO DIGITAL FINSER PAY"],
      },
      OR: [
        { codigo: null },
        { codigo: { notIn: ["ADMIN-FINSERPAY", "RECAUDO_DIGITAL"] } },
      ],
    },
    data: {
      aliadoId: aliado.id,
    },
  });

  return aliado;
}

export async function ensureAliadoFinserPay(prisma: AliadoClient) {
  return prisma.aliado.upsert({
    where: {
      nombre: ALIADO_FINSER_PAY.nombre,
    },
    update: {
      codigo: ALIADO_FINSER_PAY.codigo,
      activo: true,
    },
    create: {
      nombre: ALIADO_FINSER_PAY.nombre,
      codigo: ALIADO_FINSER_PAY.codigo,
      activo: true,
    },
    select: {
      id: true,
      nombre: true,
      codigo: true,
      activo: true,
    },
  });
}

export async function ensureFinserPayCentralAdmin(prisma: CentralAdminClient) {
  const aliado = await ensureAliadoFinserPay(prisma);

  const existing = await prisma.sede.findFirst({
    where: {
      OR: [
        { nombre: "ADMIN FINSER PAY" },
        { codigo: "ADMIN-FINSERPAY" },
      ],
    },
    select: {
      id: true,
    },
    orderBy: {
      id: "asc",
    },
  });

  const sede = existing
    ? await prisma.sede.update({
        where: {
          id: existing.id,
        },
        data: {
          aliadoId: aliado.id,
          codigo: "ADMIN-FINSERPAY",
          nombre: "ADMIN FINSER PAY",
          activa: true,
        },
        select: {
          id: true,
        },
      })
    : await prisma.sede.create({
        data: {
          nombre: "ADMIN FINSER PAY",
          codigo: "ADMIN-FINSERPAY",
          aliadoId: aliado.id,
          activa: true,
        },
        select: {
          id: true,
        },
      });

  await prisma.usuario.updateMany({
    where: {
      usuario: "admin",
      rol: {
        nombre: "ADMIN",
      },
    },
    data: {
      sedeId: sede.id,
      activo: true,
    },
  });

  return sede;
}

export function isFinserPayCentralAlly(codigo: string | null | undefined) {
  return String(codigo || "").trim().toUpperCase() === ALIADO_FINSER_PAY.codigo;
}

export function normalizeRedescuentoPercentage(value: unknown) {
  const normalized =
    typeof value === "string" ? value.replace(",", ".").trim() : value;
  const parsed = Number(normalized);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_REDESCUENTO_PERCENTAGE;
  }

  return Math.max(0, Math.min(100, Math.round(parsed * 100) / 100));
}

export function normalizeAllyName(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

export function normalizeAllyCode(value: unknown) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();

  return normalized || null;
}
