import prisma from "@/lib/prisma";
import {
  DEFAULT_CREDIT_INSTALLMENTS,
  DEFAULT_FIANCO_SURETY_PERCENTAGE,
  DEFAULT_LEGAL_CONSUMER_RATE_EA,
  DEFAULT_PAYMENT_FREQUENCY,
  MAX_CREDIT_INSTALLMENTS,
  normalizePaymentFrequency,
} from "@/lib/credit-factory";

const CREDIT_SETTINGS_KEY = "GLOBAL";

let creditSettingsTableReady = false;

export type CreditSettings = {
  tasaInteresEa: number;
  fianzaPorcentaje: number;
  plazoCuotas: number;
  frecuenciaPago: string;
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

function normalizeInstallments(value: unknown, fallback = DEFAULT_CREDIT_INSTALLMENTS) {
  const parsed = Math.trunc(Number(value));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1, Math.min(MAX_CREDIT_INSTALLMENTS, parsed));
}

function toCreditSettings(row?: Record<string, unknown> | null): CreditSettings {
  return {
    tasaInteresEa: toNumber(row?.tasaInteresEa, DEFAULT_LEGAL_CONSUMER_RATE_EA),
    fianzaPorcentaje: toNumber(
      row?.fianzaPorcentaje,
      DEFAULT_FIANCO_SURETY_PERCENTAGE
    ),
    plazoCuotas: normalizeInstallments(row?.plazoCuotas),
    frecuenciaPago: normalizePaymentFrequency(row?.frecuenciaPago),
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
      "plazoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_CREDIT_INSTALLMENTS},
      "frecuenciaPago" TEXT NOT NULL DEFAULT '${DEFAULT_PAYMENT_FREQUENCY}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracion"
    ADD COLUMN IF NOT EXISTS "plazoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_CREDIT_INSTALLMENTS}
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracion"
    ADD COLUMN IF NOT EXISTS "frecuenciaPago" TEXT NOT NULL DEFAULT '${DEFAULT_PAYMENT_FREQUENCY}'
  `);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CreditoConfiguracion"
      (nombre, "tasaInteresEa", "fianzaPorcentaje", "plazoCuotas", "frecuenciaPago", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (nombre) DO NOTHING`,
    CREDIT_SETTINGS_KEY,
    DEFAULT_LEGAL_CONSUMER_RATE_EA,
    DEFAULT_FIANCO_SURETY_PERCENTAGE,
    DEFAULT_CREDIT_INSTALLMENTS,
    DEFAULT_PAYMENT_FREQUENCY
  );

  creditSettingsTableReady = true;
}

export async function getCreditSettings() {
  await ensureCreditSettingsTable();

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "tasaInteresEa", "fianzaPorcentaje", "plazoCuotas", "frecuenciaPago", "updatedAt"
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
  plazoCuotas?: unknown;
  frecuenciaPago?: unknown;
}) {
  await ensureCreditSettingsTable();
  const current = await getCreditSettings();

  const tasaInteresEa = normalizePercentage(
    params.tasaInteresEa,
    current.tasaInteresEa
  );
  const fianzaPorcentaje = normalizePercentage(
    params.fianzaPorcentaje,
    current.fianzaPorcentaje
  );
  const plazoCuotas = normalizeInstallments(params.plazoCuotas, current.plazoCuotas);
  const frecuenciaPago = normalizePaymentFrequency(
    params.frecuenciaPago || current.frecuenciaPago
  );

  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE "CreditoConfiguracion"
     SET "tasaInteresEa" = $2,
         "fianzaPorcentaje" = $3,
         "plazoCuotas" = $4,
         "frecuenciaPago" = $5,
         "updatedAt" = NOW()
     WHERE nombre = $1
     RETURNING "tasaInteresEa", "fianzaPorcentaje", "plazoCuotas", "frecuenciaPago", "updatedAt"`,
    CREDIT_SETTINGS_KEY,
    tasaInteresEa,
    fianzaPorcentaje,
    plazoCuotas,
    frecuenciaPago
  )) as Array<Record<string, unknown>>;

  return toCreditSettings(rows[0]);
}
