import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import type { AnalystRequestDetail } from "@/lib/approval-request-detail-types";

export function parseAnalystRequestId(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^(D|C)-([1-9]\d*)$/.exec(value);
  if (!match) return null;
  const entityId = Number(match[2]);
  if (!Number.isSafeInteger(entityId)) return null;
  return { id: value, source: match[1] === "D" ? "DRAFT" as const : "CREDIT" as const, entityId };
}

export function requestRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function requestText(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function number(value: unknown) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function requestIso(value: unknown) {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Date-only credit fields are stored as UTC calendar dates, not local instants. */
export function requestCalendarDate(value: unknown): string | null {
  const text = requestText(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(text)) return null;
  const rawCalendar = text.slice(0,10);
  const rawDate = new Date(`${rawCalendar}T00:00:00Z`);
  if (!Number.isFinite(rawDate.getTime()) || rawDate.toISOString().slice(0,10) !== rawCalendar) return null;
  const plain = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/.test(text);
  const calendar = plain ? text.slice(0,10) : requestIso(text)?.slice(0,10);
  if (!calendar) return null;
  const parsed = new Date(`${calendar}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === calendar ? calendar : null;
}

/** Display persisted or sealed terms only; opening a request never recalculates its offer. */
export function projectRequestFinancial(payloadValue: unknown, signedSealValue?: unknown): AnalystRequestDetail["financial"] {
  const payload = requestRecord(payloadValue);
  const seal = readFinancingTermsSeal(signedSealValue) || readFinancingTermsSeal(payload.financialTermsSeal);
  if (seal) {
    const terms = seal.snapshot;
    return {
      saleValue: number(terms.valorVenta), downPayment: number(terms.cuotaInicial),
      authorizedAmount: number(terms.valorFinanciado), installments: number(terms.numeroCuotas),
      installment: number(terms.cuotaPactada ?? terms.cuotaComercial),
      frequency: requestText(terms.frecuenciaPago), firstPayment: requestCalendarDate(terms.fechaPrimerPago),
    };
  }
  const saleValue = number(payload.valorEquipoTotal);
  const downPayment = number(payload.cuotaInicial);
  return {
    saleValue, downPayment,
    authorizedAmount: number(payload.saldoBaseFinanciado) ??
      (saleValue !== null && downPayment !== null && saleValue >= downPayment ? saleValue - downPayment : null),
    installments: number(payload.plazoMeses),
    installment: number(payload.cuotaComercial) ?? number(payload.valorCuota),
    frequency: requestText(payload.frecuenciaPago), firstPayment: requestCalendarDate(payload.fechaPrimerPago),
  };
}

export function projectRequestContact(payloadValue: unknown): AnalystRequestDetail["client"] {
  const payload = requestRecord(payloadValue);
  return {
    phone: requestText(payload.clienteTelefono), email: requestText(payload.clienteCorreo),
    address: requestText(payload.clienteDireccion), department: requestText(payload.clienteDepartamento),
    city: requestText(payload.clienteCiudad), birthDate: requestCalendarDate(payload.clienteFechaNacimiento),
    documentType: requestText(payload.clienteTipoDocumento),
  };
}
