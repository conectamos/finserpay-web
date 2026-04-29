import prisma from "@/lib/prisma";
import {
  DEFAULT_CREDIT_INSTALLMENTS,
  DEFAULT_FIANCO_SURETY_PERCENTAGE,
  DEFAULT_LEGAL_CONSUMER_RATE_EA,
  DEFAULT_MAX_CREDIT_INSTALLMENTS,
  DEFAULT_PAYMENT_FREQUENCY,
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
  normalizePaymentFrequency,
} from "@/lib/credit-factory";

const CREDIT_SETTINGS_KEY = "GLOBAL";

let creditSettingsTableReady = false;

export type CreditSettings = {
  tasaInteresEa: number;
  fianzaPorcentaje: number;
  plazoCuotas: number;
  plazoMaximoCuotas: number;
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

function toCreditSettings(row?: Record<string, unknown> | null): CreditSettings {
  const plazoMaximoCuotas = normalizeCreditInstallmentLimit(
    row?.plazoMaximoCuotas,
    DEFAULT_MAX_CREDIT_INSTALLMENTS
  );

  return {
    tasaInteresEa: toNumber(row?.tasaInteresEa, DEFAULT_LEGAL_CONSUMER_RATE_EA),
    fianzaPorcentaje: toNumber(
      row?.fianzaPorcentaje,
      DEFAULT_FIANCO_SURETY_PERCENTAGE
    ),
    plazoCuotas: normalizeCreditInstallments(
      row?.plazoCuotas,
      DEFAULT_CREDIT_INSTALLMENTS,
      plazoMaximoCuotas
    ),
    plazoMaximoCuotas,
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
      "plazoMaximoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_CREDIT_INSTALLMENTS},
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
    ADD COLUMN IF NOT EXISTS "plazoMaximoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_CREDIT_INSTALLMENTS}
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracion"
    ADD COLUMN IF NOT EXISTS "frecuenciaPago" TEXT NOT NULL DEFAULT '${DEFAULT_PAYMENT_FREQUENCY}'
  `);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CreditoConfiguracion"
      (nombre, "tasaInteresEa", "fianzaPorcentaje", "plazoCuotas", "plazoMaximoCuotas", "frecuenciaPago", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (nombre) DO NOTHING`,
    CREDIT_SETTINGS_KEY,
    DEFAULT_LEGAL_CONSUMER_RATE_EA,
    DEFAULT_FIANCO_SURETY_PERCENTAGE,
    DEFAULT_CREDIT_INSTALLMENTS,
    DEFAULT_MAX_CREDIT_INSTALLMENTS,
    DEFAULT_PAYMENT_FREQUENCY
  );

  creditSettingsTableReady = true;
}

export async function getCreditSettings() {
  await ensureCreditSettingsTable();

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "tasaInteresEa", "fianzaPorcentaje", "plazoCuotas", "plazoMaximoCuotas", "frecuenciaPago", "updatedAt"
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
  plazoMaximoCuotas?: unknown;
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
  const plazoMaximoCuotas = normalizeCreditInstallmentLimit(
    params.plazoMaximoCuotas,
    current.plazoMaximoCuotas
  );
  const plazoCuotas = normalizeCreditInstallments(
    params.plazoCuotas,
    current.plazoCuotas,
    plazoMaximoCuotas
  );
  const frecuenciaPago = normalizePaymentFrequency(
    params.frecuenciaPago || current.frecuenciaPago
  );

  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE "CreditoConfiguracion"
     SET "tasaInteresEa" = $2,
         "fianzaPorcentaje" = $3,
         "plazoCuotas" = $4,
         "plazoMaximoCuotas" = $5,
         "frecuenciaPago" = $6,
         "updatedAt" = NOW()
     WHERE nombre = $1
     RETURNING "tasaInteresEa", "fianzaPorcentaje", "plazoCuotas", "plazoMaximoCuotas", "frecuenciaPago", "updatedAt"`,
    CREDIT_SETTINGS_KEY,
    tasaInteresEa,
    fianzaPorcentaje,
    plazoCuotas,
    plazoMaximoCuotas,
    frecuenciaPago
  )) as Array<Record<string, unknown>>;

  return toCreditSettings(rows[0]);
}
