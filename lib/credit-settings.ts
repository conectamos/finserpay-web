import prisma from "@/lib/prisma";
import {
  DEFAULT_CREDIT_INSTALLMENTS,
  DEFAULT_FIANCO_SURETY_PERCENTAGE,
  DEFAULT_INITIAL_PAYMENT_PERCENTAGE,
  DEFAULT_LEGAL_CONSUMER_RATE_EA,
  DEFAULT_MAX_CREDIT_INSTALLMENTS,
  DEFAULT_PAYMENT_FREQUENCY,
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
  normalizePaymentFrequency,
} from "@/lib/credit-factory";

const CREDIT_SETTINGS_KEY = "GLOBAL";
const SEEDED_MULTI_CREDIT_DOCUMENT = "1023028341";

let creditSettingsTableReady = false;

export type CreditSettings = {
  tasaInteresEa: number;
  fianzaPorcentaje: number;
  cuotaInicialPorcentaje: number;
  plazoCuotas: number;
  plazoMaximoCuotas: number;
  iphoneCuotaInicialPorcentaje: number;
  iphonePlazoCuotas: number;
  iphonePlazoMaximoCuotas: number;
  frecuenciaPago: string;
  updatedAt: string | null;
};

export type CreditPlatform = "ANDROID" | "IPHONE";

export type CreditDocumentException = {
  id: number;
  documento: string;
  documentoNormalizado: string;
  tasaInteresEa: number | null;
  fianzaPorcentaje: number | null;
  cuotaInicialPorcentaje: number | null;
  plazoCuotas: number | null;
  plazoMaximoCuotas: number | null;
  frecuenciaPago: string | null;
  permiteMultiplesCreditos: boolean;
  permiteEntregaSinVerificacion: boolean;
  activo: boolean;
  observacion: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  effectiveSettings: CreditSettings;
};

export type EffectiveCreditSettings = {
  settings: CreditSettings;
  globalSettings: CreditSettings;
  documentException: CreditDocumentException | null;
};

function toNumber(value: unknown, fallback: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function toIsoString(value: unknown) {
  return value instanceof Date ? value.toISOString() : value ? String(value) : null;
}

function normalizePercentage(value: unknown, fallback: number) {
  const parsed = Number(String(value ?? "").replace(",", "."));

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(parsed * 100) / 100));
}

function normalizeOptionalPercentage(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  return normalizePercentage(value, 0);
}

function normalizeOptionalInstallmentLimit(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  return normalizeCreditInstallmentLimit(value, DEFAULT_MAX_CREDIT_INSTALLMENTS);
}

function normalizeOptionalInstallments(value: unknown, maxInstallments: number) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  return normalizeCreditInstallments(value, DEFAULT_CREDIT_INSTALLMENTS, maxInstallments);
}

function normalizeOptionalPaymentFrequency(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  return normalizePaymentFrequency(value);
}

export function normalizeCreditDocument(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 40);
}

export function normalizeCreditPlatform(value: unknown): CreditPlatform {
  const normalized = String(value ?? "").trim().toUpperCase();

  return normalized === "IPHONE" || normalized === "IOS" ? "IPHONE" : "ANDROID";
}

export function getPlatformCreditSettings(
  settings: CreditSettings,
  platform?: unknown
): CreditSettings {
  if (normalizeCreditPlatform(platform) !== "IPHONE") {
    return settings;
  }

  return {
    ...settings,
    cuotaInicialPorcentaje: settings.iphoneCuotaInicialPorcentaje,
    plazoCuotas: settings.iphonePlazoCuotas,
    plazoMaximoCuotas: settings.iphonePlazoMaximoCuotas,
  };
}

function toCreditSettings(row?: Record<string, unknown> | null): CreditSettings {
  const plazoMaximoCuotas = normalizeCreditInstallmentLimit(
    row?.plazoMaximoCuotas,
    DEFAULT_MAX_CREDIT_INSTALLMENTS
  );
  const iphonePlazoMaximoCuotas = normalizeCreditInstallmentLimit(
    row?.iphonePlazoMaximoCuotas ?? plazoMaximoCuotas,
    plazoMaximoCuotas
  );
  const cuotaInicialPorcentaje = toNumber(
    row?.cuotaInicialPorcentaje,
    DEFAULT_INITIAL_PAYMENT_PERCENTAGE
  );

  return {
    tasaInteresEa: toNumber(row?.tasaInteresEa, DEFAULT_LEGAL_CONSUMER_RATE_EA),
    fianzaPorcentaje: toNumber(
      row?.fianzaPorcentaje,
      DEFAULT_FIANCO_SURETY_PERCENTAGE
    ),
    cuotaInicialPorcentaje,
    plazoCuotas: normalizeCreditInstallments(
      row?.plazoCuotas,
      DEFAULT_CREDIT_INSTALLMENTS,
      plazoMaximoCuotas
    ),
    plazoMaximoCuotas,
    iphoneCuotaInicialPorcentaje: toNumber(
      row?.iphoneCuotaInicialPorcentaje,
      cuotaInicialPorcentaje
    ),
    iphonePlazoCuotas: normalizeCreditInstallments(
      row?.iphonePlazoCuotas,
      DEFAULT_CREDIT_INSTALLMENTS,
      iphonePlazoMaximoCuotas
    ),
    iphonePlazoMaximoCuotas,
    frecuenciaPago: normalizePaymentFrequency(row?.frecuenciaPago),
    updatedAt: toIsoString(row?.updatedAt),
  };
}

function mergeDocumentSettings(
  globalSettings: CreditSettings,
  row?: Record<string, unknown> | null
): CreditSettings {
  const documentInitialPercentage = toNullableNumber(row?.cuotaInicialPorcentaje);
  const documentInstallments = toNullableNumber(row?.plazoCuotas);
  const documentMaxInstallments = toNullableNumber(row?.plazoMaximoCuotas);
  const plazoMaximoCuotas =
    documentMaxInstallments ?? globalSettings.plazoMaximoCuotas;
  const normalizedMax = normalizeCreditInstallmentLimit(
    plazoMaximoCuotas,
    globalSettings.plazoMaximoCuotas
  );
  const iphoneMax = normalizeCreditInstallmentLimit(
    documentMaxInstallments ?? globalSettings.iphonePlazoMaximoCuotas,
    globalSettings.iphonePlazoMaximoCuotas
  );

  return {
    ...globalSettings,
    tasaInteresEa:
      toNullableNumber(row?.tasaInteresEa) ?? globalSettings.tasaInteresEa,
    fianzaPorcentaje:
      toNullableNumber(row?.fianzaPorcentaje) ?? globalSettings.fianzaPorcentaje,
    cuotaInicialPorcentaje:
      documentInitialPercentage ?? globalSettings.cuotaInicialPorcentaje,
    plazoMaximoCuotas: normalizedMax,
    plazoCuotas: normalizeCreditInstallments(
      documentInstallments ?? globalSettings.plazoCuotas,
      globalSettings.plazoCuotas,
      normalizedMax
    ),
    iphoneCuotaInicialPorcentaje:
      documentInitialPercentage ?? globalSettings.iphoneCuotaInicialPorcentaje,
    iphonePlazoMaximoCuotas: iphoneMax,
    iphonePlazoCuotas: normalizeCreditInstallments(
      documentInstallments ?? globalSettings.iphonePlazoCuotas,
      globalSettings.iphonePlazoCuotas,
      iphoneMax
    ),
    frecuenciaPago: normalizePaymentFrequency(
      row?.frecuenciaPago || globalSettings.frecuenciaPago
    ),
    updatedAt: toIsoString(row?.updatedAt) || globalSettings.updatedAt,
  };
}

function toDocumentException(
  row: Record<string, unknown>,
  globalSettings: CreditSettings
): CreditDocumentException {
  return {
    id: Number(row.id || 0),
    documento: String(row.documento || ""),
    documentoNormalizado: String(row.documentoNormalizado || ""),
    tasaInteresEa: toNullableNumber(row.tasaInteresEa),
    fianzaPorcentaje: toNullableNumber(row.fianzaPorcentaje),
    cuotaInicialPorcentaje: toNullableNumber(row.cuotaInicialPorcentaje),
    plazoCuotas: toNullableNumber(row.plazoCuotas),
    plazoMaximoCuotas: toNullableNumber(row.plazoMaximoCuotas),
    frecuenciaPago: row.frecuenciaPago ? String(row.frecuenciaPago) : null,
    permiteMultiplesCreditos: Boolean(row.permiteMultiplesCreditos),
    permiteEntregaSinVerificacion: Boolean(row.permiteEntregaSinVerificacion),
    activo: row.activo === null || row.activo === undefined ? true : Boolean(row.activo),
    observacion: row.observacion ? String(row.observacion) : null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    effectiveSettings: mergeDocumentSettings(globalSettings, row),
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
      "cuotaInicialPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT ${DEFAULT_INITIAL_PAYMENT_PERCENTAGE},
      "plazoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_CREDIT_INSTALLMENTS},
      "plazoMaximoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_CREDIT_INSTALLMENTS},
      "iphoneCuotaInicialPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT ${DEFAULT_INITIAL_PAYMENT_PERCENTAGE},
      "iphonePlazoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_CREDIT_INSTALLMENTS},
      "iphonePlazoMaximoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_CREDIT_INSTALLMENTS},
      "frecuenciaPago" TEXT NOT NULL DEFAULT '${DEFAULT_PAYMENT_FREQUENCY}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracion"
    ADD COLUMN IF NOT EXISTS "cuotaInicialPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT ${DEFAULT_INITIAL_PAYMENT_PERCENTAGE}
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
    ADD COLUMN IF NOT EXISTS "iphoneCuotaInicialPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT ${DEFAULT_INITIAL_PAYMENT_PERCENTAGE}
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracion"
    ADD COLUMN IF NOT EXISTS "iphonePlazoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_CREDIT_INSTALLMENTS}
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracion"
    ADD COLUMN IF NOT EXISTS "iphonePlazoMaximoCuotas" INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_CREDIT_INSTALLMENTS}
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracion"
    ADD COLUMN IF NOT EXISTS "frecuenciaPago" TEXT NOT NULL DEFAULT '${DEFAULT_PAYMENT_FREQUENCY}'
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CreditoConfiguracionDocumento" (
      id SERIAL PRIMARY KEY,
      documento TEXT NOT NULL,
      "documentoNormalizado" TEXT NOT NULL UNIQUE,
      "tasaInteresEa" DOUBLE PRECISION,
      "fianzaPorcentaje" DOUBLE PRECISION,
      "cuotaInicialPorcentaje" DOUBLE PRECISION,
      "plazoCuotas" INTEGER,
      "plazoMaximoCuotas" INTEGER,
      "frecuenciaPago" TEXT,
      "permiteMultiplesCreditos" BOOLEAN NOT NULL DEFAULT FALSE,
      "permiteEntregaSinVerificacion" BOOLEAN NOT NULL DEFAULT FALSE,
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      observacion TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracionDocumento"
    ADD COLUMN IF NOT EXISTS "cuotaInicialPorcentaje" DOUBLE PRECISION
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracionDocumento"
    ADD COLUMN IF NOT EXISTS "permiteMultiplesCreditos" BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracionDocumento"
    ADD COLUMN IF NOT EXISTS "permiteEntregaSinVerificacion" BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoConfiguracionDocumento"
    ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "CreditoConfiguracionDocumento_activo_idx"
    ON "CreditoConfiguracionDocumento" (activo)
  `);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CreditoConfiguracion"
      (nombre, "tasaInteresEa", "fianzaPorcentaje", "cuotaInicialPorcentaje", "plazoCuotas", "plazoMaximoCuotas", "frecuenciaPago", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (nombre) DO NOTHING`,
    CREDIT_SETTINGS_KEY,
    DEFAULT_LEGAL_CONSUMER_RATE_EA,
    DEFAULT_FIANCO_SURETY_PERCENTAGE,
    DEFAULT_INITIAL_PAYMENT_PERCENTAGE,
    DEFAULT_CREDIT_INSTALLMENTS,
    DEFAULT_MAX_CREDIT_INSTALLMENTS,
    DEFAULT_PAYMENT_FREQUENCY
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CreditoConfiguracionDocumento"
      (documento, "documentoNormalizado", "permiteMultiplesCreditos", activo, observacion, "createdAt", "updatedAt")
     VALUES ($1, $1, TRUE, TRUE, $2, NOW(), NOW())
     ON CONFLICT ("documentoNormalizado") DO NOTHING`,
    SEEDED_MULTI_CREDIT_DOCUMENT,
    "Permite multiples creditos activos por autorizacion administrativa."
  );

  creditSettingsTableReady = true;
}

export async function getCreditSettings() {
  await ensureCreditSettingsTable();

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "tasaInteresEa", "fianzaPorcentaje", "cuotaInicialPorcentaje", "plazoCuotas", "plazoMaximoCuotas",
            "iphoneCuotaInicialPorcentaje", "iphonePlazoCuotas", "iphonePlazoMaximoCuotas",
            "frecuenciaPago", "updatedAt"
     FROM "CreditoConfiguracion"
     WHERE nombre = $1
     LIMIT 1`,
    CREDIT_SETTINGS_KEY
  )) as Array<Record<string, unknown>>;

  return toCreditSettings(rows[0]);
}

export async function getCreditDocumentException(documento: unknown) {
  await ensureCreditSettingsTable();
  const documentoNormalizado = normalizeCreditDocument(documento);

  if (!documentoNormalizado) {
    return null;
  }

  const globalSettings = await getCreditSettings();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, documento, "documentoNormalizado", "tasaInteresEa", "fianzaPorcentaje", "cuotaInicialPorcentaje",
            "plazoCuotas", "plazoMaximoCuotas", "frecuenciaPago",
            "permiteMultiplesCreditos", "permiteEntregaSinVerificacion",
            activo, observacion, "createdAt", "updatedAt"
     FROM "CreditoConfiguracionDocumento"
     WHERE "documentoNormalizado" = $1
     LIMIT 1`,
    documentoNormalizado
  )) as Array<Record<string, unknown>>;

  return rows[0] ? toDocumentException(rows[0], globalSettings) : null;
}

export async function getEffectiveCreditSettings(
  documento?: unknown,
  platform?: unknown
): Promise<EffectiveCreditSettings> {
  const globalSettings = await getCreditSettings();
  const documentException = documento
    ? await getCreditDocumentException(documento)
    : null;
  const activeException = documentException?.activo ? documentException : null;
  const activeSettings = activeException?.effectiveSettings || globalSettings;
  const platformSettings = getPlatformCreditSettings(activeSettings, platform);

  return {
    settings: platformSettings,
    globalSettings: getPlatformCreditSettings(globalSettings, platform),
    documentException: activeException
      ? {
          ...activeException,
          effectiveSettings: platformSettings,
        }
      : null,
  };
}

export async function listCreditDocumentExceptions() {
  await ensureCreditSettingsTable();
  const globalSettings = await getCreditSettings();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, documento, "documentoNormalizado", "tasaInteresEa", "fianzaPorcentaje", "cuotaInicialPorcentaje",
            "plazoCuotas", "plazoMaximoCuotas", "frecuenciaPago",
            "permiteMultiplesCreditos", "permiteEntregaSinVerificacion",
            activo, observacion, "createdAt", "updatedAt"
     FROM "CreditoConfiguracionDocumento"
     ORDER BY "updatedAt" DESC, id DESC`
  )) as Array<Record<string, unknown>>;

  return rows.map((row) => toDocumentException(row, globalSettings));
}

export async function updateCreditSettings(params: {
  tasaInteresEa: unknown;
  fianzaPorcentaje: unknown;
  cuotaInicialPorcentaje?: unknown;
  plazoCuotas?: unknown;
  plazoMaximoCuotas?: unknown;
  iphoneCuotaInicialPorcentaje?: unknown;
  iphonePlazoCuotas?: unknown;
  iphonePlazoMaximoCuotas?: unknown;
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
  const cuotaInicialPorcentaje =
    params.cuotaInicialPorcentaje === undefined
      ? current.cuotaInicialPorcentaje
      : normalizePercentage(
          params.cuotaInicialPorcentaje,
          current.cuotaInicialPorcentaje
        );
  const iphonePlazoMaximoCuotas = normalizeCreditInstallmentLimit(
    params.iphonePlazoMaximoCuotas,
    current.iphonePlazoMaximoCuotas
  );
  const iphonePlazoCuotas = normalizeCreditInstallments(
    params.iphonePlazoCuotas,
    current.iphonePlazoCuotas,
    iphonePlazoMaximoCuotas
  );
  const iphoneCuotaInicialPorcentaje =
    params.iphoneCuotaInicialPorcentaje === undefined
      ? current.iphoneCuotaInicialPorcentaje
      : normalizePercentage(
          params.iphoneCuotaInicialPorcentaje,
          current.iphoneCuotaInicialPorcentaje
        );

  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE "CreditoConfiguracion"
     SET "tasaInteresEa" = $2,
         "fianzaPorcentaje" = $3,
         "cuotaInicialPorcentaje" = $4,
         "plazoCuotas" = $5,
         "plazoMaximoCuotas" = $6,
         "frecuenciaPago" = $7,
         "iphoneCuotaInicialPorcentaje" = $8,
         "iphonePlazoCuotas" = $9,
         "iphonePlazoMaximoCuotas" = $10,
         "updatedAt" = NOW()
     WHERE nombre = $1
     RETURNING "tasaInteresEa", "fianzaPorcentaje", "cuotaInicialPorcentaje", "plazoCuotas", "plazoMaximoCuotas",
       "iphoneCuotaInicialPorcentaje", "iphonePlazoCuotas", "iphonePlazoMaximoCuotas",
       "frecuenciaPago", "updatedAt"`,
    CREDIT_SETTINGS_KEY,
    tasaInteresEa,
    fianzaPorcentaje,
    cuotaInicialPorcentaje,
    plazoCuotas,
    plazoMaximoCuotas,
    frecuenciaPago,
    iphoneCuotaInicialPorcentaje,
    iphonePlazoCuotas,
    iphonePlazoMaximoCuotas
  )) as Array<Record<string, unknown>>;

  return toCreditSettings(rows[0]);
}

export async function upsertCreditDocumentException(params: {
  documento: unknown;
  tasaInteresEa?: unknown;
  fianzaPorcentaje?: unknown;
  cuotaInicialPorcentaje?: unknown;
  plazoCuotas?: unknown;
  plazoMaximoCuotas?: unknown;
  frecuenciaPago?: unknown;
  permiteMultiplesCreditos?: unknown;
  permiteEntregaSinVerificacion?: unknown;
  activo?: unknown;
  observacion?: unknown;
}) {
  await ensureCreditSettingsTable();
  const globalSettings = await getCreditSettings();
  const documentoNormalizado = normalizeCreditDocument(params.documento);

  if (!documentoNormalizado) {
    throw new Error("Debes ingresar una cedula valida.");
  }

  const plazoMaximoCuotas =
    normalizeOptionalInstallmentLimit(params.plazoMaximoCuotas) ??
    globalSettings.plazoMaximoCuotas;
  const plazoCuotas = normalizeOptionalInstallments(
    params.plazoCuotas,
    plazoMaximoCuotas
  );
  const frecuenciaPago = normalizeOptionalPaymentFrequency(params.frecuenciaPago);
  const observacion = String(params.observacion ?? "").trim().slice(0, 240) || null;
  const activo =
    params.activo === null || params.activo === undefined ? true : Boolean(params.activo);

  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO "CreditoConfiguracionDocumento"
      (documento, "documentoNormalizado", "tasaInteresEa", "fianzaPorcentaje", "cuotaInicialPorcentaje",
       "plazoCuotas", "plazoMaximoCuotas", "frecuenciaPago",
       "permiteMultiplesCreditos", "permiteEntregaSinVerificacion",
       activo, observacion, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
     ON CONFLICT ("documentoNormalizado")
     DO UPDATE SET
       documento = EXCLUDED.documento,
       "tasaInteresEa" = EXCLUDED."tasaInteresEa",
       "fianzaPorcentaje" = EXCLUDED."fianzaPorcentaje",
       "cuotaInicialPorcentaje" = EXCLUDED."cuotaInicialPorcentaje",
       "plazoCuotas" = EXCLUDED."plazoCuotas",
       "plazoMaximoCuotas" = EXCLUDED."plazoMaximoCuotas",
       "frecuenciaPago" = EXCLUDED."frecuenciaPago",
       "permiteMultiplesCreditos" = EXCLUDED."permiteMultiplesCreditos",
       "permiteEntregaSinVerificacion" = EXCLUDED."permiteEntregaSinVerificacion",
       activo = EXCLUDED.activo,
       observacion = EXCLUDED.observacion,
       "updatedAt" = NOW()
     RETURNING id, documento, "documentoNormalizado", "tasaInteresEa", "fianzaPorcentaje", "cuotaInicialPorcentaje",
       "plazoCuotas", "plazoMaximoCuotas", "frecuenciaPago",
       "permiteMultiplesCreditos", "permiteEntregaSinVerificacion",
       activo, observacion, "createdAt", "updatedAt"`,
    documentoNormalizado,
    documentoNormalizado,
    normalizeOptionalPercentage(params.tasaInteresEa),
    normalizeOptionalPercentage(params.fianzaPorcentaje),
    normalizeOptionalPercentage(params.cuotaInicialPorcentaje),
    plazoCuotas,
    normalizeOptionalInstallmentLimit(params.plazoMaximoCuotas),
    frecuenciaPago,
    Boolean(params.permiteMultiplesCreditos),
    Boolean(params.permiteEntregaSinVerificacion),
    activo,
    observacion
  )) as Array<Record<string, unknown>>;

  return toDocumentException(rows[0], globalSettings);
}

export async function deleteCreditDocumentException(documento: unknown) {
  await ensureCreditSettingsTable();
  const documentoNormalizado = normalizeCreditDocument(documento);

  if (!documentoNormalizado) {
    throw new Error("Debes indicar una cedula valida.");
  }

  await prisma.$executeRawUnsafe(
    `DELETE FROM "CreditoConfiguracionDocumento"
     WHERE "documentoNormalizado" = $1`,
    documentoNormalizado
  );
}
