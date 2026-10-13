import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import {
  calculateFrenchAmortization,
  type FrenchAmortizationVersion,
  type CommercialInstallmentRounding,
} from "@/lib/credit-amortization";
import type {
  CreditAmortizationDbClient,
  StoredCreditAmortization,
} from "@/lib/credit-amortization-storage";
import {
  addPaymentFrequency,
  MAX_CREDIT_INSTALLMENTS,
  PAYMENT_FREQUENCY_OPTIONS,
} from "@/lib/credit-factory";

const defaultDb = prisma as unknown as CreditAmortizationDbClient;
let schemaReady: Promise<void> | null = null;
const VERSIONS = new Set(["FRANCES_V1", "ARES_FRANCES_V1", "ARES_FRANCES_V2"]);
const HEADER_AMOUNTS = [
  "valorVenta", "cuotaInicial", "valorFinanciado", "tasaInteresEaPorcentaje",
  "tasaPeriodo", "fianzaCuotaPorcentaje", "seguroCuotaPorcentaje",
  "cuotaCreditoExacta", "cuotaFianzaExacta", "cuotaSeguroExacta", "cuotaTotalExacta",
  "cuotaComercial", "totalInteres", "totalFianza", "totalSeguro", "totalPagar",
] as const;
const INSTALLMENT_AMOUNTS = [
  "saldoInicial", "interes", "abonoCapital", "fianza", "seguro", "cuotaCredito",
  "cuotaTotal", "cuotaCobro", "saldoFinal",
] as const;
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "CreditPaymentPlanRevision" (
    "id" SERIAL PRIMARY KEY,
    "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "usuarioId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "nombreUsuario" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "beforeSnapshot" JSONB NOT NULL,
    "afterSnapshot" JSONB NOT NULL,
    "amortizationSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditPaymentPlanRevision_creditoId_id_idx"
    ON "CreditPaymentPlanRevision" ("creditoId", "id" DESC)`,
] as const;

/** Run outside the credit transaction; this creates only the append-only audit table. */
export async function ensureCreditPlanRevisionSchema(db: CreditAmortizationDbClient = defaultDb) {
  const setup = async () => {
    for (const statement of SCHEMA_STATEMENTS) await db.$executeRawUnsafe(statement);
  };
  if (db !== defaultDb) return setup();
  if (!schemaReady) schemaReady = setup().catch(error => { schemaReady = null; throw error; });
  await schemaReady;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function integer(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) throw new Error(`${field} no es válido.`);
  return parsed;
}

function decimal(value: unknown, field: string) {
  const text = String(value ?? "").trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
    throw new Error(`${field} debe ser un decimal no negativo.`);
  }
  return text;
}

function calendarDate(value: unknown, field = "fechaPrimerPago") {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${field} no es una fecha válida.`);
  const date = new Date(`${text}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error(`${field} no es una fecha válida.`);
  return text;
}

function frequency(value: unknown) {
  const text = String(value ?? "").trim().toUpperCase();
  const option = PAYMENT_FREQUENCY_OPTIONS.find(item => item.value === text);
  if (!option) throw new Error("frecuenciaPago no es válida.");
  return option;
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function revisionChecksum(plan: StoredCreditAmortization) {
  const { checksum: _checksum, ...snapshot } = plan;
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

// Match PostgreSQL NUMERIC rounding from the calculator's decimal text, including half ties.
function storedDecimal(value: number, places = 6) {
  if (!Number.isFinite(value) || value < 0) throw new Error("El ajuste produjo un importe inválido.");
  const [coefficient, exponentText = "0"] = String(value).split(/[eE]/);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = BigInt(whole + fraction);
  const scale = places - fraction.length + Number(exponentText);
  const divisor = scale < 0 ? BigInt(10) ** BigInt(-scale) : BigInt(1);
  const rounded = scale < 0
    ? (digits + divisor / BigInt(2)) / divisor
    : digits * BigInt(10) ** BigInt(scale);
  const text = rounded.toString().padStart(places + 1, "0");
  return places ? `${text.slice(0, -places)}.${text.slice(-places)}` : text;
}

function validateStoredPlan(value: unknown, creditoId?: number): StoredCreditAmortization {
  if (!record(value)) throw new Error("La revisión del plan de pagos está dañada.");
  const plan = jsonSafe(value) as StoredCreditAmortization;
  integer(plan.id, "amortizacion.id");
  integer(plan.creditoId, "amortizacion.creditoId");
  if (creditoId !== undefined && plan.creditoId !== creditoId) throw new Error("La revisión no corresponde al crédito solicitado.");
  if (!VERSIONS.has(String(plan.calculoVersion))) throw new Error("Versión de amortización guardada no compatible.");
  const option = frequency(plan.frecuenciaPago);
  if (plan.periodosPorAnio !== option.periodsPerYear) throw new Error("El calendario guardado es inconsistente.");
  integer(plan.numeroCuotas, "numeroCuotas", MAX_CREDIT_INSTALLMENTS);
  if (!record(plan.parametrosSnapshot)) throw new Error("Faltan los parámetros financieros guardados.");
  if (typeof plan.checksum !== "string" || !plan.checksum.trim()) throw new Error("Falta la huella del plan guardado.");
  for (const key of HEADER_AMOUNTS) plan[key] = decimal(plan[key], key);
  if (!Array.isArray(plan.cuotas) || plan.cuotas.length !== plan.numeroCuotas) throw new Error("La revisión debe conservar todas las cuotas.");
  for (const [index, installment] of plan.cuotas.entries()) {
    if (!record(installment) || installment.numero !== index + 1) throw new Error("La secuencia de cuotas guardada es inválida.");
    integer(installment.id, "cuota.id");
    if (installment.amortizacionId !== plan.id) throw new Error("La cuota no corresponde a la amortización guardada.");
    installment.fechaVencimiento = calendarDate(installment.fechaVencimiento, "fechaVencimiento");
    if (index && installment.fechaVencimiento <= plan.cuotas[index - 1].fechaVencimiento) throw new Error("Las fechas de las cuotas deben ser crecientes.");
    for (const key of INSTALLMENT_AMOUNTS) installment[key] = decimal(installment[key], `cuota.${key}`);
  }
  for (const key of ["aprobadoAt", "createdAt"] as const) {
    if (typeof plan[key] !== "string" || Number.isNaN(new Date(plan[key]).getTime())) throw new Error(`${key} no es válido.`);
  }
  return plan;
}

/** An operational plan revision never updates the original amortization or signed documents. */
export function createAdministrativeAmortization(
  current: StoredCreditAmortization,
  input: { numeroCuotas: number; frecuenciaPago: string; fechaPrimerPago: Date | string }
): StoredCreditAmortization {
  const before = validateStoredPlan(current);
  const numeroCuotas = integer(input.numeroCuotas, "numeroCuotas", MAX_CREDIT_INSTALLMENTS);
  const option = frequency(input.frecuenciaPago);
  const fechaPrimerPago = calendarDate(input.fechaPrimerPago);
  const snapshot = before.parametrosSnapshot as Record<string, unknown>;
  const calendarOnly = numeroCuotas === before.numeroCuotas && option.value === before.frecuenciaPago;
  let after: StoredCreditAmortization;

  if (calendarOnly) {
    after = { ...before, cuotas: before.cuotas.map((installment, index) => ({
      ...installment,
      fechaVencimiento: addPaymentFrequency(fechaPrimerPago, option.value, index).toISOString().slice(0, 10),
    })) };
  } else {
    const decimals = typeof snapshot.tasaPeriodoDecimales === "number" ? snapshot.tasaPeriodoDecimales : NaN;
    const rounding = snapshot.redondeoComercial;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12 || !record(rounding) ||
        !["PISO", "REDONDEO"].includes(String(rounding.modo)) ||
        !Number.isSafeInteger(Number(rounding.multiplo)) || Number(rounding.multiplo) <= 0) {
      throw new Error("Faltan los parámetros históricos de tasa y redondeo; no se puede ajustar este plan.");
    }
    let fianzaCuotaPorcentaje = Number(before.fianzaCuotaPorcentaje);
    if (snapshot.origenFianza === "TOTAL_CREDITO") {
      fianzaCuotaPorcentaje = Number(decimal(snapshot.fianzaTotalPorcentaje, "fianzaTotalPorcentaje")) / numeroCuotas;
    }
    const result = calculateFrenchAmortization({
      calculoVersion: before.calculoVersion as FrenchAmortizationVersion,
      tasaPeriodoDecimales: decimals,
      redondeoComercial: { modo: rounding.modo, multiplo: Number(rounding.multiplo) } as CommercialInstallmentRounding,
      valorVenta: Number(before.valorVenta), cuotaInicial: Number(before.cuotaInicial),
      numeroCuotas, tasaInteresEa: Number(before.tasaInteresEaPorcentaje),
      fianzaCuotaPorcentaje, seguroCuotaPorcentaje: Number(before.seguroCuotaPorcentaje),
      frecuenciaPago: option.value, fechaPrimerPago,
    });
    const amount = storedDecimal;
    after = {
      ...before,
      frecuenciaPago: result.frecuenciaPago, numeroCuotas: result.numeroCuotas,
      periodosPorAnio: result.periodosPorAno, tasaPeriodo: amount(result.tasaPeriodo, 12),
      fianzaCuotaPorcentaje: amount(result.fianzaCuotaPorcentaje, 12),
      cuotaCreditoExacta: amount(result.cuotaCredito), cuotaFianzaExacta: amount(result.cuotaFianza),
      cuotaSeguroExacta: amount(result.cuotaSeguro), cuotaTotalExacta: amount(result.cuotaTotal),
      cuotaComercial: amount(result.cuotaComercial, 2), totalInteres: amount(result.valorInteresTotal),
      totalFianza: amount(result.valorFianzaTotal), totalSeguro: amount(result.valorSeguroTotal),
      totalPagar: amount(result.montoTotal),
      parametrosSnapshot: { ...snapshot, fechaPrimerPago,
        ...(before.calculoVersion === "ARES_FRANCES_V2" ? {
          cuotaPactada: result.cuotaCobro, totalPagarExacto: result.montoTotalExacto,
          descuentoRedondeo: result.descuentoRedondeo,
        } : {}),
      },
      cuotas: result.cuotas.map((installment, index) => ({
        ...installment,
        id: before.cuotas[index]?.id ?? index + 1,
        amortizacionId: before.id, createdAt: before.cuotas[index]?.createdAt ?? before.createdAt,
        saldoInicial: amount(installment.saldoInicial), interes: amount(installment.interes),
        abonoCapital: amount(installment.abonoCapital), fianza: amount(installment.fianza),
        seguro: amount(installment.seguro), cuotaCredito: amount(installment.cuotaCredito),
        cuotaTotal: amount(installment.cuotaTotal), cuotaCobro: amount(installment.cuotaCobro, 2),
        saldoFinal: amount(installment.saldoFinal),
      })),
    };
  }
  after.parametrosSnapshot = { ...(after.parametrosSnapshot as Record<string, unknown>), fechaPrimerPago };
  after = validateStoredPlan(after);
  after.checksum = revisionChecksum(after);
  return after;
}

export type CreditPlanRevisionInput = {
  creditoId: number; usuarioId: number; nombreUsuario: string; motivo: string;
  beforeSnapshot: unknown; afterSnapshot: unknown; amortizationSnapshot: StoredCreditAmortization;
};

/** Caller must lock the credit and validate central permissions before inserting in its transaction. */
export async function insertCreditPlanRevision(tx: CreditAmortizationDbClient, input: CreditPlanRevisionInput) {
  const creditoId = integer(input.creditoId, "creditoId");
  const usuarioId = integer(input.usuarioId, "usuarioId");
  const nombreUsuario = String(input.nombreUsuario ?? "").trim();
  const motivo = String(input.motivo ?? "").trim();
  if (!nombreUsuario || nombreUsuario.length > 200 || motivo.length < 5 || motivo.length > 2000) throw new Error("El responsable y el motivo de la revisión son obligatorios.");
  const plan = validateStoredPlan(input.amortizationSnapshot, creditoId);
  if (plan.checksum !== revisionChecksum(plan)) throw new Error("La huella de la revisión del plan no coincide.");
  if (!record(input.beforeSnapshot) || !record(input.afterSnapshot)) throw new Error("Los estados anterior y posterior son obligatorios.");
  const rows = await tx.$queryRawUnsafe<Array<{ id: number; createdAt: Date | string }>>(
    `INSERT INTO "CreditPaymentPlanRevision" ("creditoId", "usuarioId", "nombreUsuario", "motivo", "beforeSnapshot", "afterSnapshot", "amortizationSnapshot")
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) RETURNING "id", "createdAt"`,
    creditoId, usuarioId, nombreUsuario, motivo,
    JSON.stringify(jsonSafe(input.beforeSnapshot)), JSON.stringify(jsonSafe(input.afterSnapshot)), JSON.stringify(plan)
  );
  if (!rows[0]?.id) throw new Error("No se pudo registrar la revisión del plan.");
  return { id: Number(rows[0].id), createdAt: new Date(rows[0].createdAt).toISOString() };
}

export async function getLatestCreditPlanAmortization(creditoIdInput: number, db: CreditAmortizationDbClient = defaultDb): Promise<StoredCreditAmortization | null> {
  if (db === defaultDb) await ensureCreditPlanRevisionSchema();
  const creditoId = integer(creditoIdInput, "creditoId");
  const rows = await db.$queryRawUnsafe<Array<{ amortizationSnapshot: unknown }>>(
    `SELECT "amortizationSnapshot" FROM "CreditPaymentPlanRevision" WHERE "creditoId" = $1 ORDER BY "id" DESC LIMIT 1`, creditoId
  );
  if (!rows.length) return null;
  const plan = validateStoredPlan(rows[0].amortizationSnapshot, creditoId);
  if (plan.checksum !== revisionChecksum(plan)) throw new Error("La huella de la revisión del plan no coincide; se requiere revisión administrativa.");
  return plan;
}

export type CreditPlanOperationalTerms = {
  montoCredito: number;
  valorCuota: number;
  plazoMeses: number;
  frecuenciaPago: string;
  fechaPrimerPago: string;
  fechaProximoPago: string | null;
  valorInteres: number;
  valorFianza: number;
  tasaInteresEa: number;
};

function operationalSnapshot(value: unknown): CreditPlanOperationalTerms {
  if (!record(value)) throw new Error("Los términos históricos del plan están dañados.");
  const amount = (key: string) => Number(decimal(value[key], key));
  const date = (key: string) => {
    const raw = value[key];
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(raw)) throw new Error(`${key} histórico no es válido.`);
    return calendarDate(raw.slice(0, 10), key);
  };
  return {
    montoCredito: amount("montoCredito"), valorCuota: amount("valorCuota"),
    plazoMeses: integer(value.plazoMeses, "plazoMeses", MAX_CREDIT_INSTALLMENTS),
    frecuenciaPago: frequency(value.frecuenciaPago).value,
    fechaPrimerPago: date("fechaPrimerPago"),
    fechaProximoPago: value.fechaProximoPago === null ? null : date("fechaProximoPago"),
    valorInteres: amount("valorInteres"), valorFianza: amount("valorFianza"),
    tasaInteresEa: amount("tasaInteresEa"),
  };
}

/** Reconstruct terms at the original accounting event, never the receipt download time. */
export async function getCreditPlanTermsAtDate(
  creditoIdInput: number,
  date: Date | string,
  db: CreditAmortizationDbClient = defaultDb
): Promise<CreditPlanOperationalTerms | null> {
  if (db === defaultDb) await ensureCreditPlanRevisionSchema();
  const creditoId = integer(creditoIdInput, "creditoId");
  const instant = date instanceof Date ? new Date(date) : new Date(String(date));
  if (Number.isNaN(instant.getTime())) throw new Error("La fecha del registro del abono no es válida.");
  const rows = await db.$queryRawUnsafe<Array<{ beforeSnapshot: unknown }>>(
    `SELECT "beforeSnapshot" FROM "CreditPaymentPlanRevision"
     WHERE "creditoId" = $1 AND "createdAt" > $2::timestamp
     ORDER BY "createdAt" ASC, "id" ASC LIMIT 1`, creditoId, instant.toISOString()
  );
  if (!rows.length) return null;
  return operationalSnapshot(rows[0].beforeSnapshot);
}
