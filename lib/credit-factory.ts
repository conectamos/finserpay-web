import type { EqualityDeliveryStatus } from "@/lib/equality-device-meta";

export type CreditAdminCommand =
  | "consult-device"
  | "payment-reference"
  | "toggle-stolen-lock"
  | "update-due-date"
  | "extend-1h"
  | "extend-24h"
  | "extend-48h"
  | "warranty-15d"
  | "warranty-20d"
  | "remove-lock";

export const CREDIT_ABONO_CAJA_MARKER = "ABONO_CREDITO_ID:";
export const DEFAULT_LEGAL_CONSUMER_RATE_EA = 17.84;
export const DEFAULT_FIANCO_SURETY_PERCENTAGE = 60;
export const MAX_DEVICE_FINANCING_BASE = 800_000;
export const DEFAULT_LEGAL_RATE_REFERENCE =
  "SFC consumo y ordinario vigente del 1 al 30 de abril de 2026";

export function sanitizeDeviceValue(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

export function sanitizeText(value: unknown) {
  return String(value ?? "").trim();
}

export function sanitizeSearch(value: unknown) {
  return String(value ?? "").trim().slice(0, 80);
}

export function toNumber(value: unknown) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

export function toNullableDate(value: unknown) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function generateCreditFolio() {
  const timestamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `FC-${timestamp}-${suffix}`;
}

export function generatePagareNumber(reference?: string | null) {
  const base = sanitizeText(reference).replace(/\W/g, "").slice(-18);

  if (base) {
    return `PG-${base}`;
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PG-${timestamp}-${suffix}`;
}

export function generatePaymentReference(folio: string, document: string) {
  const cleanDocument = sanitizeText(document).replace(/\W/g, "").slice(-6) || "CLIENTE";
  return `REF-${folio}-${cleanDocument}`.slice(0, 40);
}

export function resolveCreditState(options: {
  bloqueoRobo?: boolean;
  bloqueoMora?: boolean;
  deliverable?: EqualityDeliveryStatus | null;
  pazYSalvoEmitidoAt?: Date | null;
}) {
  if (options.pazYSalvoEmitidoAt) {
    return "PAZ_Y_SALVO";
  }

  if (options.bloqueoRobo) {
    return "ROBO_BLOQUEADO";
  }

  if (options.bloqueoMora) {
    return "MORA_BLOQUEADO";
  }

  if (options.deliverable?.ready) {
    return "ENTREGABLE";
  }

  if (options.deliverable) {
    return "INSCRITO";
  }

  return "GENERADO";
}

export function extendFromNow(hours: number, current: Date | null) {
  const base =
    current && current.getTime() > Date.now() ? current.getTime() : Date.now();

  return new Date(base + hours * 60 * 60 * 1000);
}

export function extendDays(days: number, current: Date | null) {
  const base =
    current && current.getTime() > Date.now() ? current.getTime() : Date.now();

  return new Date(base + days * 24 * 60 * 60 * 1000);
}

export function normalizePaymentMethod(value: unknown) {
  const method = String(value ?? "").trim().toUpperCase();

  if (["EFECTIVO", "TRANSFERENCIA", "NEQUI", "DAVIPLATA", "OTRO"].includes(method)) {
    return method;
  }

  return "EFECTIVO";
}

export function calculateFinancedBalance(
  valorTotalEquipo: number | null | undefined,
  cuotaInicial: number | null | undefined
) {
  const total = Math.max(0, Number(valorTotalEquipo || 0));
  const inicial = Math.max(0, Number(cuotaInicial || 0));
  return Math.max(0, total - inicial);
}

export function calculateRequiredInitialPayment(
  valorTotalEquipo: number | null | undefined,
  precioBaseVenta?: number | null
) {
  const total = Math.max(0, Number(valorTotalEquipo || 0));
  const catalogBase = Math.max(0, Number(precioBaseVenta || 0));
  const limit = catalogBase > 0 ? catalogBase : MAX_DEVICE_FINANCING_BASE;
  const financedBase = Math.min(total, limit);
  const excedente = Math.max(0, total - limit);
  const initial = financedBase * 0.2 + excedente;

  return Math.round(initial * 100) / 100;
}

export function getDefaultFirstPaymentDate(from: Date | number | string = new Date()) {
  const baseDate = new Date(from);
  const normalized = Number.isNaN(baseDate.getTime()) ? new Date() : baseDate;
  normalized.setHours(12, 0, 0, 0);
  normalized.setDate(normalized.getDate() + 15);
  return normalized.toISOString().slice(0, 10);
}

export function calculateInstallmentValue(
  saldoFinanciado: number | null | undefined,
  cuotas: number | null | undefined
) {
  const saldo = Math.max(0, Number(saldoFinanciado || 0));
  const totalCuotas = Math.max(0, Math.trunc(Number(cuotas || 0)));

  if (totalCuotas <= 0) {
    return saldo;
  }

  return Math.round((saldo / totalCuotas) * 100) / 100;
}

export function annualEffectiveToMonthlyEffectiveRate(
  annualRateEaPercent: number | null | undefined
) {
  const annualRate = Math.max(0, Number(annualRateEaPercent || 0)) / 100;
  const monthlyRate = Math.pow(1 + annualRate, 1 / 12) - 1;
  return Math.round(monthlyRate * 1000000) / 1000000;
}

export function calculateCreditCharges(options: {
  saldoBaseFinanciado?: number | null;
  cuotas?: number | null;
  tasaInteresEa?: number | null;
  fianzaPorcentaje?: number | null;
}) {
  const saldoBaseFinanciado = Math.max(0, Number(options.saldoBaseFinanciado || 0));
  const cuotas = Math.max(0, Math.trunc(Number(options.cuotas || 0)));
  const tasaInteresEa = Math.max(
    0,
    Number(options.tasaInteresEa ?? DEFAULT_LEGAL_CONSUMER_RATE_EA)
  );
  const fianzaPorcentaje = Math.max(
    0,
    Number(options.fianzaPorcentaje ?? DEFAULT_FIANCO_SURETY_PERCENTAGE)
  );
  const tasaMensual = annualEffectiveToMonthlyEffectiveRate(tasaInteresEa);
  const valorInteres =
    Math.round(saldoBaseFinanciado * tasaMensual * Math.max(1, cuotas) * 100) / 100;
  const valorFianza =
    Math.round((saldoBaseFinanciado * fianzaPorcentaje) / 100 * 100) / 100;
  const montoCreditoTotal =
    Math.round((saldoBaseFinanciado + valorInteres + valorFianza) * 100) / 100;
  const valorCuota =
    cuotas > 0 ? Math.round((montoCreditoTotal / cuotas) * 100) / 100 : montoCreditoTotal;

  return {
    saldoBaseFinanciado,
    cuotas,
    tasaInteresEa,
    tasaMensual,
    valorInteres,
    fianzaPorcentaje,
    valorFianza,
    montoCreditoTotal,
    valorCuota,
  };
}

export function sanitizeImageDataUrl(value: unknown) {
  const normalized = String(value ?? "").trim();

  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(normalized)) {
    return "";
  }

  if (normalized.length > 2_500_000) {
    return "";
  }

  return normalized;
}

export function sanitizeVideoDataUrl(value: unknown) {
  const normalized = String(value ?? "").trim();

  if (!/^data:video\/(webm|mp4|ogg|quicktime|mov|x-m4v);base64,/i.test(normalized)) {
    return "";
  }

  if (normalized.length > 10_000_000) {
    return "";
  }

  return normalized;
}

export function resolveCreditPaymentSummary(options: {
  montoCredito?: number | null;
  cuotaInicial?: number | null;
  totalAbonado?: number | null;
  abonosCount?: number | null;
}) {
  const montoCredito = Math.max(0, Number(options.montoCredito || 0));
  const cuotaInicial = Math.max(0, Number(options.cuotaInicial || 0));
  const totalAbonado = Math.max(0, Number(options.totalAbonado || 0));
  const saldoPendiente = Math.max(0, montoCredito - totalAbonado);
  const porcentajeRecaudado =
    montoCredito > 0 ? Math.min(100, Math.round((totalAbonado / montoCredito) * 100)) : 0;

  return {
    abonosCount: Math.max(0, Number(options.abonosCount || 0)),
    cuotaInicial,
    montoCredito,
    porcentajeRecaudado,
    saldoPendiente,
    totalAbonado,
    totalRecaudado: totalAbonado,
  };
}

export function creditCajaConcept(method: string) {
  return method === "EFECTIVO" ? "ABONO CREDITO EFECTIVO" : "ABONO CREDITO";
}

export function creditCajaDescription(abono: {
  id: number;
  creditoFolio: string;
  clienteNombre: string;
  metodoPago: string;
  observacion?: string | null;
}) {
  const parts = [
    `${CREDIT_ABONO_CAJA_MARKER}${abono.id}`,
    `Folio: ${abono.creditoFolio}`,
    `Cliente: ${abono.clienteNombre}`,
    `Metodo: ${abono.metodoPago}`,
  ];

  if (abono.observacion) {
    parts.push(`Obs: ${abono.observacion}`);
  }

  return parts.join(" | ");
}
