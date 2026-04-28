import prisma from "@/lib/prisma";
import {
  DEFAULT_FIANCO_SURETY_PERCENTAGE,
  DEFAULT_LEGAL_CONSUMER_RATE_EA,
} from "@/lib/credit-factory";

const CREDIT_SETTINGS_KEY = "GLOBAL";

let creditSettingsTableReady = false;

export type CreditSettings = {
  tasaInteresEa: number;
  fianzaPorcentaje: number;
  updatedAt: string | null;
};

function toNumber(value: unknown, fallback: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizePercentage(value: unknown, fallback: number) {
  const parsed = Number(String(value ?? "").replace(",", "."));

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(parsed * 100) / 100));
}

function toCreditSettings(row?: Record<string, unknown> | null): CreditSettings {
  return {
    tasaInteresEa: toNumber(row?.tasaInteresEa, DEFAULT_LEGAL_CONSUMER_RATE_EA),
    fianzaPorcentaje: toNumber(
      row?.fianzaPorcentaje,
      DEFAULT_FIANCO_SURETY_PERCENTAGE
    ),
    updatedAt:
      row?.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : row?.updatedAt
          ? String(row.updatedAt)
          : null,
  };
}

export async function ensureCreditSettingsTable() {
  if (creditSettingsTableReady) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CreditoConfiguracion" (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL UNIQUE,
      "tasaInteresEa" DOUBLE PRECISION NOT NULL DEFAULT ${DEFAULT_LEGAL_CONSUMER_RATE_EA},
      "fianzaPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT ${DEFAULT_FIANCO_SURETY_PERCENTAGE},
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CreditoConfiguracion"
      (nombre, "tasaInteresEa", "fianzaPorcentaje", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (nombre) DO NOTHING`,
    CREDIT_SETTINGS_KEY,
    DEFAULT_LEGAL_CONSUMER_RATE_EA,
    DEFAULT_FIANCO_SURETY_PERCENTAGE
  );

  creditSettingsTableReady = true;
}

export async function getCreditSettings() {
  await ensureCreditSettingsTable();

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "tasaInteresEa", "fianzaPorcentaje", "updatedAt"
     FROM "CreditoConfiguracion"
     WHERE nombre = $1
     LIMIT 1`,
    CREDIT_SETTINGS_KEY
  )) as Array<Record<string, unknown>>;

  return toCreditSettings(rows[0]);
}

export async function updateCreditSettings(params: {
  tasaInteresEa: unknown;
  fianzaPorcentaje: unknown;
}) {
  await ensureCreditSettingsTable();

  const tasaInteresEa = normalizePercentage(
    params.tasaInteresEa,
    DEFAULT_LEGAL_CONSUMER_RATE_EA
  );
  const fianzaPorcentaje = normalizePercentage(
    params.fianzaPorcentaje,
    DEFAULT_FIANCO_SURETY_PERCENTAGE
  );

  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE "CreditoConfiguracion"
     SET "tasaInteresEa" = $2,
         "fianzaPorcentaje" = $3,
         "updatedAt" = NOW()
     WHERE nombre = $1
     RETURNING "tasaInteresEa", "fianzaPorcentaje", "updatedAt"`,
    CREDIT_SETTINGS_KEY,
    tasaInteresEa,
    fianzaPorcentaje
  )) as Array<Record<string, unknown>>;

  return toCreditSettings(rows[0]);
}
