import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";

export type ExactDecimalInput =
  | string
  | number
  | bigint
  | { toString(): string };

export type CreditAmortizationInstallmentPersistenceInput = {
  numero: number;
  fechaVencimiento: Date | string;
  saldoInicial: ExactDecimalInput;
  interes: ExactDecimalInput;
  abonoCapital: ExactDecimalInput;
  fianza: ExactDecimalInput;
  seguro: ExactDecimalInput;
  cuotaCredito: ExactDecimalInput;
  cuotaTotal: ExactDecimalInput;
  cuotaCobro: ExactDecimalInput;
  saldoFinal: ExactDecimalInput;
};

export type CreditAmortizationPersistenceInput = {
  calculoVersion?: string;
  frecuenciaPago: string;
  periodosPorAnio: number;
  numeroCuotas: number;
  valorVenta: ExactDecimalInput;
  cuotaInicial: ExactDecimalInput;
  valorFinanciado: ExactDecimalInput;
  tasaInteresEaPorcentaje: ExactDecimalInput;
  tasaPeriodo: ExactDecimalInput;
  fianzaCuotaPorcentaje: ExactDecimalInput;
  seguroCuotaPorcentaje: ExactDecimalInput;
  cuotaCreditoExacta: ExactDecimalInput;
  cuotaFianzaExacta: ExactDecimalInput;
  cuotaSeguroExacta: ExactDecimalInput;
  cuotaTotalExacta: ExactDecimalInput;
  cuotaComercial: ExactDecimalInput;
  totalInteres: ExactDecimalInput;
  totalFianza: ExactDecimalInput;
  totalSeguro: ExactDecimalInput;
  totalPagar: ExactDecimalInput;
  aprobadoAt?: Date | string;
  cuotas: readonly CreditAmortizationInstallmentPersistenceInput[];
};

export type CreditAmortizationDbClient = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

export type StoredCreditAmortization = Omit<
  CreditAmortizationPersistenceInput,
  "aprobadoAt" | "cuotas"
> & {
  id: number;
  creditoId: number;
  checksum: string;
  parametrosSnapshot: unknown;
  aprobadoAt: string;
  createdAt: string;
  cuotas: Array<
    CreditAmortizationInstallmentPersistenceInput & {
      id: number;
      amortizacionId: number;
      fechaVencimiento: string;
      saldoInicial: string;
      interes: string;
      abonoCapital: string;
      fianza: string;
      seguro: string;
      cuotaCredito: string;
      cuotaTotal: string;
      cuotaCobro: string;
      saldoFinal: string;
      createdAt: string;
    }
  >;
};

const defaultDb = prisma as unknown as CreditAmortizationDbClient;
let schemaReady: Promise<void> | null = null;
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "CreditoAmortizacion" (
     "id" SERIAL PRIMARY KEY,
     "creditoId" INTEGER NOT NULL,
     "calculoVersion" TEXT NOT NULL DEFAULT 'FRANCES_V1',
     "frecuenciaPago" TEXT NOT NULL,
     "periodosPorAnio" INTEGER NOT NULL CHECK ("periodosPorAnio" > 0),
     "numeroCuotas" INTEGER NOT NULL CHECK ("numeroCuotas" > 0),
     "valorVenta" NUMERIC(20,6) NOT NULL,
     "cuotaInicial" NUMERIC(20,6) NOT NULL,
     "valorFinanciado" NUMERIC(20,6) NOT NULL,
     "tasaInteresEaPorcentaje" NUMERIC(18,12) NOT NULL,
     "tasaPeriodo" NUMERIC(18,12) NOT NULL,
     "fianzaCuotaPorcentaje" NUMERIC(18,12) NOT NULL,
     "seguroCuotaPorcentaje" NUMERIC(18,12) NOT NULL,
     "cuotaCreditoExacta" NUMERIC(20,6) NOT NULL,
     "cuotaFianzaExacta" NUMERIC(20,6) NOT NULL,
     "cuotaSeguroExacta" NUMERIC(20,6) NOT NULL,
     "cuotaTotalExacta" NUMERIC(20,6) NOT NULL,
     "cuotaComercial" NUMERIC(20,2) NOT NULL,
     "totalInteres" NUMERIC(20,6) NOT NULL,
     "totalFianza" NUMERIC(20,6) NOT NULL,
     "totalSeguro" NUMERIC(20,6) NOT NULL,
     "totalPagar" NUMERIC(20,6) NOT NULL,
     "parametrosSnapshot" JSONB NOT NULL,
     "checksum" TEXT NOT NULL,
     "aprobadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "CreditoAmortizacion_creditoId_fkey"
       FOREIGN KEY ("creditoId") REFERENCES "Credito"("id")
       ON DELETE CASCADE ON UPDATE CASCADE
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditoAmortizacion_creditoId_key"
     ON "CreditoAmortizacion" ("creditoId")`,
  `CREATE INDEX IF NOT EXISTS "CreditoAmortizacion_checksum_idx"
     ON "CreditoAmortizacion" ("checksum")`,
  `CREATE INDEX IF NOT EXISTS "CreditoAmortizacion_createdAt_idx"
     ON "CreditoAmortizacion" ("createdAt")`,
  `CREATE TABLE IF NOT EXISTS "CreditoAmortizacionCuota" (
     "id" SERIAL PRIMARY KEY,
     "amortizacionId" INTEGER NOT NULL,
     "numero" INTEGER NOT NULL CHECK ("numero" > 0),
     "fechaVencimiento" DATE NOT NULL,
     "saldoInicial" NUMERIC(20,6) NOT NULL,
     "interes" NUMERIC(20,6) NOT NULL,
     "abonoCapital" NUMERIC(20,6) NOT NULL,
     "fianza" NUMERIC(20,6) NOT NULL,
     "seguro" NUMERIC(20,6) NOT NULL,
     "cuotaCredito" NUMERIC(20,6) NOT NULL,
     "cuotaTotal" NUMERIC(20,6) NOT NULL,
     "cuotaCobro" NUMERIC(20,2) NOT NULL,
     "saldoFinal" NUMERIC(20,6) NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "CreditoAmortizacionCuota_amortizacionId_fkey"
       FOREIGN KEY ("amortizacionId") REFERENCES "CreditoAmortizacion"("id")
       ON DELETE CASCADE ON UPDATE CASCADE
    )`,
  `ALTER TABLE "CreditoAmortizacionCuota"
     ADD COLUMN IF NOT EXISTS "cuotaCobro" NUMERIC(20,2)`,
  `UPDATE "CreditoAmortizacionCuota"
     SET "cuotaCobro" = ROUND("cuotaTotal", 2)
     WHERE "cuotaCobro" IS NULL`,
  `UPDATE "CreditoAmortizacionCuota" installment
     SET "cuotaCobro" = ROUND(
       header."totalPagar" - COALESCE((
         SELECT SUM(previous."cuotaCobro")
         FROM "CreditoAmortizacionCuota" previous
         WHERE previous."amortizacionId" = installment."amortizacionId"
           AND previous."numero" < installment."numero"
       ), 0),
       2
     )
     FROM "CreditoAmortizacion" header
     WHERE header."id" = installment."amortizacionId"
       AND installment."numero" = header."numeroCuotas"`,
  `ALTER TABLE "CreditoAmortizacionCuota"
     ALTER COLUMN "cuotaCobro" SET NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditoAmortizacionCuota_amortizacionId_numero_key"
     ON "CreditoAmortizacionCuota" ("amortizacionId", "numero")`,
  `CREATE INDEX IF NOT EXISTS "CreditoAmortizacionCuota_fechaVencimiento_idx"
     ON "CreditoAmortizacionCuota" ("fechaVencimiento")`,
] as const;

async function runSchemaSetup() {
  for (const statement of SCHEMA_STATEMENTS) {
    await defaultDb.$executeRawUnsafe(statement);
  }
}

export async function ensureCreditAmortizationSchema() {
  if (!schemaReady) {
    schemaReady = runSchemaSetup().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }

  await schemaReady;
}

function positiveInteger(value: unknown, field: string) {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} debe ser un entero positivo`);
  }

  return parsed;
}

function requiredText(value: unknown, field: string, max = 80) {
  const normalized = String(value ?? "").trim();

  if (!normalized || normalized.length > max) {
    throw new Error(`${field} no es valido`);
  }

  return normalized;
}

function decimalText(value: ExactDecimalInput | unknown, field: string) {
  const normalized = String(value ?? "").trim();
  const numeric = Number(normalized);

  if (!DECIMAL_RE.test(normalized) || !Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${field} debe ser un decimal no negativo`);
  }

  return normalized;
}

function dateKey(value: Date | string | unknown, field: string) {
  const raw = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));

    if (
      check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === day
    ) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }
  }

  const parsed = value instanceof Date ? new Date(value) : new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} no es una fecha valida`);
  }

  return parsed.toISOString().slice(0, 10);
}

function instant(value: Date | string | undefined, field: string) {
  const parsed = value ? new Date(value) : new Date();

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} no es una fecha valida`);
  }

  return parsed;
}

function jsonSafe(value: unknown) {
  const serialized = JSON.stringify(value ?? {}, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item
  );

  if (!serialized) {
    return {};
  }

  return JSON.parse(serialized) as unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function normalizeInstallments(
  plan: CreditAmortizationPersistenceInput,
  numeroCuotas: number
) {
  const cuotas = [...plan.cuotas]
    .map((item) => ({
      numero: positiveInteger(item.numero, "cuota.numero"),
      fechaVencimiento: dateKey(item.fechaVencimiento, "cuota.fechaVencimiento"),
      saldoInicial: decimalText(item.saldoInicial, "cuota.saldoInicial"),
      interes: decimalText(item.interes, "cuota.interes"),
      abonoCapital: decimalText(item.abonoCapital, "cuota.abonoCapital"),
      fianza: decimalText(item.fianza, "cuota.fianza"),
      seguro: decimalText(item.seguro, "cuota.seguro"),
      cuotaCredito: decimalText(item.cuotaCredito, "cuota.cuotaCredito"),
      cuotaTotal: decimalText(item.cuotaTotal, "cuota.cuotaTotal"),
      cuotaCobro: decimalText(item.cuotaCobro, "cuota.cuotaCobro"),
      saldoFinal: decimalText(item.saldoFinal, "cuota.saldoFinal"),
    }))
    .sort((left, right) => left.numero - right.numero);

  if (
    cuotas.length !== numeroCuotas ||
    cuotas.some((item, index) => item.numero !== index + 1)
  ) {
    throw new Error(
      "La tabla de amortizacion debe contener todas las cuotas en secuencia"
    );
  }

  return cuotas;
}

function normalizePlan(plan: CreditAmortizationPersistenceInput) {
  const numeroCuotas = positiveInteger(plan.numeroCuotas, "numeroCuotas");

  return {
    calculoVersion: requiredText(
      plan.calculoVersion || "FRANCES_V1",
      "calculoVersion"
    ),
    frecuenciaPago: requiredText(
      plan.frecuenciaPago,
      "frecuenciaPago"
    ).toUpperCase(),
    periodosPorAnio: positiveInteger(plan.periodosPorAnio, "periodosPorAnio"),
    numeroCuotas,
    valorVenta: decimalText(plan.valorVenta, "valorVenta"),
    cuotaInicial: decimalText(plan.cuotaInicial, "cuotaInicial"),
    valorFinanciado: decimalText(plan.valorFinanciado, "valorFinanciado"),
    tasaInteresEaPorcentaje: decimalText(
      plan.tasaInteresEaPorcentaje,
      "tasaInteresEaPorcentaje"
    ),
    tasaPeriodo: decimalText(plan.tasaPeriodo, "tasaPeriodo"),
    fianzaCuotaPorcentaje: decimalText(
      plan.fianzaCuotaPorcentaje,
      "fianzaCuotaPorcentaje"
    ),
    seguroCuotaPorcentaje: decimalText(
      plan.seguroCuotaPorcentaje,
      "seguroCuotaPorcentaje"
    ),
    cuotaCreditoExacta: decimalText(
      plan.cuotaCreditoExacta,
      "cuotaCreditoExacta"
    ),
    cuotaFianzaExacta: decimalText(
      plan.cuotaFianzaExacta,
      "cuotaFianzaExacta"
    ),
    cuotaSeguroExacta: decimalText(
      plan.cuotaSeguroExacta,
      "cuotaSeguroExacta"
    ),
    cuotaTotalExacta: decimalText(
      plan.cuotaTotalExacta,
      "cuotaTotalExacta"
    ),
    cuotaComercial: decimalText(plan.cuotaComercial, "cuotaComercial"),
    totalInteres: decimalText(plan.totalInteres, "totalInteres"),
    totalFianza: decimalText(plan.totalFianza, "totalFianza"),
    totalSeguro: decimalText(plan.totalSeguro, "totalSeguro"),
    totalPagar: decimalText(plan.totalPagar, "totalPagar"),
    aprobadoAt: instant(plan.aprobadoAt, "aprobadoAt"),
    cuotas: normalizeInstallments(plan, numeroCuotas),
  };
}

function isoInstant(value: unknown, field: string) {
  return instant(value as Date | string, field).toISOString();
}

async function loadByCreditId(
  creditoId: number,
  db: CreditAmortizationDbClient
): Promise<StoredCreditAmortization | null> {
  const headers = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM "CreditoAmortizacion" WHERE "creditoId" = $1 LIMIT 1`,
    creditoId
  );
  const row = headers[0];

  if (!row) return null;

  const amortizacionId = Number(row.id);
  const installments = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM "CreditoAmortizacionCuota"
     WHERE "amortizacionId" = $1 ORDER BY "numero" ASC`,
    amortizacionId
  );
  const amount = (key: string) => decimalText(row[key], key);

  return {
    id: amortizacionId,
    creditoId: Number(row.creditoId),
    calculoVersion: String(row.calculoVersion),
    frecuenciaPago: String(row.frecuenciaPago),
    periodosPorAnio: Number(row.periodosPorAnio),
    numeroCuotas: Number(row.numeroCuotas),
    valorVenta: amount("valorVenta"),
    cuotaInicial: amount("cuotaInicial"),
    valorFinanciado: amount("valorFinanciado"),
    tasaInteresEaPorcentaje: amount("tasaInteresEaPorcentaje"),
    tasaPeriodo: amount("tasaPeriodo"),
    fianzaCuotaPorcentaje: amount("fianzaCuotaPorcentaje"),
    seguroCuotaPorcentaje: amount("seguroCuotaPorcentaje"),
    cuotaCreditoExacta: amount("cuotaCreditoExacta"),
    cuotaFianzaExacta: amount("cuotaFianzaExacta"),
    cuotaSeguroExacta: amount("cuotaSeguroExacta"),
    cuotaTotalExacta: amount("cuotaTotalExacta"),
    cuotaComercial: amount("cuotaComercial"),
    totalInteres: amount("totalInteres"),
    totalFianza: amount("totalFianza"),
    totalSeguro: amount("totalSeguro"),
    totalPagar: amount("totalPagar"),
    checksum: String(row.checksum),
    parametrosSnapshot: row.parametrosSnapshot,
    aprobadoAt: isoInstant(row.aprobadoAt, "aprobadoAt"),
    createdAt: isoInstant(row.createdAt, "createdAt"),
    cuotas: installments.map((item) => ({
      id: Number(item.id),
      amortizacionId: Number(item.amortizacionId),
      numero: Number(item.numero),
      fechaVencimiento: dateKey(item.fechaVencimiento, "fechaVencimiento"),
      saldoInicial: decimalText(item.saldoInicial, "saldoInicial"),
      interes: decimalText(item.interes, "interes"),
      abonoCapital: decimalText(item.abonoCapital, "abonoCapital"),
      fianza: decimalText(item.fianza, "fianza"),
      seguro: decimalText(item.seguro, "seguro"),
      cuotaCredito: decimalText(item.cuotaCredito, "cuotaCredito"),
      cuotaTotal: decimalText(item.cuotaTotal, "cuotaTotal"),
      cuotaCobro: decimalText(item.cuotaCobro, "cuotaCobro"),
      saldoFinal: decimalText(item.saldoFinal, "saldoFinal"),
      createdAt: isoInstant(item.createdAt, "createdAt"),
    })),
  } as StoredCreditAmortization;
}

async function insertHeader(
  tx: CreditAmortizationDbClient,
  creditoId: number,
  plan: ReturnType<typeof normalizePlan>,
  snapshot: unknown,
  checksum: string
) {
  return tx.$queryRawUnsafe<Array<{ id: number; checksum: string }>>(
    `INSERT INTO "CreditoAmortizacion" (
       "creditoId", "calculoVersion", "frecuenciaPago", "periodosPorAnio", "numeroCuotas",
       "valorVenta", "cuotaInicial", "valorFinanciado", "tasaInteresEaPorcentaje", "tasaPeriodo",
       "fianzaCuotaPorcentaje", "seguroCuotaPorcentaje", "cuotaCreditoExacta", "cuotaFianzaExacta",
       "cuotaSeguroExacta", "cuotaTotalExacta", "cuotaComercial", "totalInteres", "totalFianza",
       "totalSeguro", "totalPagar", "parametrosSnapshot", "checksum", "aprobadoAt"
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24)
     ON CONFLICT ("creditoId") DO NOTHING RETURNING "id", "checksum"`,
    creditoId,
    plan.calculoVersion,
    plan.frecuenciaPago,
    plan.periodosPorAnio,
    plan.numeroCuotas,
    plan.valorVenta,
    plan.cuotaInicial,
    plan.valorFinanciado,
    plan.tasaInteresEaPorcentaje,
    plan.tasaPeriodo,
    plan.fianzaCuotaPorcentaje,
    plan.seguroCuotaPorcentaje,
    plan.cuotaCreditoExacta,
    plan.cuotaFianzaExacta,
    plan.cuotaSeguroExacta,
    plan.cuotaTotalExacta,
    plan.cuotaComercial,
    plan.totalInteres,
    plan.totalFianza,
    plan.totalSeguro,
    plan.totalPagar,
    JSON.stringify(snapshot),
    checksum,
    plan.aprobadoAt
  );
}

async function insertInstallments(
  tx: CreditAmortizationDbClient,
  amortizacionId: number,
  cuotas: ReturnType<typeof normalizeInstallments>
) {
  for (const cuota of cuotas) {
    await tx.$executeRawUnsafe(
      `INSERT INTO "CreditoAmortizacionCuota" (
         "amortizacionId", "numero", "fechaVencimiento", "saldoInicial", "interes",
         "abonoCapital", "fianza", "seguro", "cuotaCredito", "cuotaTotal",
         "cuotaCobro", "saldoFinal"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      amortizacionId,
      cuota.numero,
      cuota.fechaVencimiento,
      cuota.saldoInicial,
      cuota.interes,
      cuota.abonoCapital,
      cuota.fianza,
      cuota.seguro,
      cuota.cuotaCredito,
      cuota.cuotaTotal,
      cuota.cuotaCobro,
      cuota.saldoFinal
    );
  }
}

export async function persistCreditAmortization(
  tx: CreditAmortizationDbClient,
  creditoIdInput: number,
  plan: CreditAmortizationPersistenceInput,
  snapshot: unknown
) {
  await ensureCreditAmortizationSchema();
  const creditoId = positiveInteger(creditoIdInput, "creditoId");
  const normalized = normalizePlan(plan);
  const safeSnapshot = jsonSafe(snapshot);
  const checksumPlan: Partial<typeof normalized> = { ...normalized };
  delete checksumPlan.aprobadoAt;
  const checksum = createHash("sha256")
    .update(canonicalJson({ plan: checksumPlan, snapshot: safeSnapshot }))
    .digest("hex");
  const inserted = await insertHeader(
    tx,
    creditoId,
    normalized,
    safeSnapshot,
    checksum
  );
  const amortizacionId = Number(inserted[0]?.id || 0);

  if (!amortizacionId) {
    const existing = await loadByCreditId(creditoId, tx);

    if (
      !existing ||
      existing.checksum !== checksum ||
      existing.cuotas.length !== existing.numeroCuotas
    ) {
      throw new Error(
        "El credito ya tiene una tabla de amortizacion diferente o incompleta"
      );
    }

    return existing;
  }

  await insertInstallments(tx, amortizacionId, normalized.cuotas);
  const stored = await loadByCreditId(creditoId, tx);

  if (!stored || stored.cuotas.length !== normalized.numeroCuotas) {
    throw new Error("No se pudo verificar la tabla de amortizacion persistida");
  }

  return stored;
}

export async function getCreditAmortizationByCreditId(
  creditoIdInput: number,
  db: CreditAmortizationDbClient = defaultDb
) {
  await ensureCreditAmortizationSchema();
  return loadByCreditId(positiveInteger(creditoIdInput, "creditoId"), db);
}

export async function hasCreditAmortization(
  creditoIdInput: number,
  db: CreditAmortizationDbClient = defaultDb
) {
  await ensureCreditAmortizationSchema();
  const creditoId = positiveInteger(creditoIdInput, "creditoId");
  const rows = await db.$queryRawUnsafe<Array<{ present: number }>>(
    `SELECT 1 AS "present" FROM "CreditoAmortizacion"
     WHERE "creditoId" = $1 LIMIT 1`,
    creditoId
  );

  return rows.length > 0;
}
