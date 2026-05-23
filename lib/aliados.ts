import type { PrismaClient } from "@/app/generated/prisma/client";

export const ALIADO_CONECTAMOS = {
  nombre: "CONECTAMOS",
  codigo: "CONECTAMOS",
} as const;

type AliadoClient = Pick<PrismaClient, "aliado">;
type AliadoSchemaClient = Pick<PrismaClient, "$executeRawUnsafe">;

let aliadoSchemaPromise: Promise<void> | null = null;

async function runAliadoSchemaSetup(prisma: AliadoSchemaClient) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Aliado" (
      "id" SERIAL PRIMARY KEY,
      "nombre" TEXT NOT NULL,
      "codigo" TEXT,
      "activo" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
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

export async function ensureAliadoConectamos(prisma: AliadoClient) {
  return prisma.aliado.upsert({
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
