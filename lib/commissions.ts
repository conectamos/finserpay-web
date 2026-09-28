/** Commission amounts are integer Colombian pesos. This module is safe in clients. */
export const COMMISSION_TIME_ZONE = "America/Bogota";
export const COMMISSION_STARTS_AT = "2026-10-01T05:00:00.000Z";
export const COMMISSION_FIRST_PERIOD = "2026-10";
export const COMMISSION_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

export class CommissionError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "COMMISSION_INVALID") {
    super(message);
    this.name = "CommissionError";
  }
}

export type CommissionPeriod = {
  period: string; validCreditCount: number; rate: number; generated: number;
  paid: number; reserved: number; available: number; adjustment: number;
};
export type CommissionRequest = {
  id: string; period: string; amount: number; nequi: string;
  status: "PENDING" | "PAID" | "REJECTED";
  createdAt: string; rejectionReason: string | null; paidAt: string | null;
  receiptUrl: string | null; receiptFileName: string | null;
};
export type CommissionAuditEvent = {
  id: string; action: string; createdAt: string; actorName: string | null; detail: string;
};
export type AdminCommissionRequest = CommissionRequest & {
  sellerId: number; sellerName: string; branchName: string;
  credits: { id: number; code: string; finalizedAt: string }[];
  audit: CommissionAuditEvent[];
};
export type SellerCommissionDashboard = {
  active: boolean; startsAt: string; serverNow: string; currentPeriod: string;
  payoutsPaused: boolean;
  periods: CommissionPeriod[]; requests: CommissionRequest[];
};
export type AdminCommissionBag = {
  allyId: number; allyName: string; overdueBalance: number; totalBalance: number;
  overduePercent: number; paused: boolean;
};
export type CreateCommissionRequestInput = {
  period: string; amount: number; nequi: string; idempotencyKey: string;
};
export type CommissionReceiptInput = { fileName: string; mimeType: string; base64: string };

export function commissionPeriodAt(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new CommissionError("Fecha inválida.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMMISSION_TIME_ZONE, year: "numeric", month: "2-digit",
  }).formatToParts(date);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}

export function commissionsAreActive(now = new Date()) {
  return now.getTime() >= Date.parse(COMMISSION_STARTS_AT);
}

export function commissionRate(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) throw new CommissionError("Cantidad de créditos inválida.");
  return count >= 30 ? 30_000 : count >= 21 ? 25_000 : count >= 15 ? 20_000 : 0;
}

export function calculateCommissionPeriod(period: string, count: number, paid = 0, reserved = 0): CommissionPeriod {
  if (![paid, reserved].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new CommissionError("Los movimientos deben expresarse en pesos enteros.");
  }
  const rate = commissionRate(count);
  const generated = count * rate;
  return { period, validCreditCount: count, rate, generated, paid, reserved,
    available: Math.max(0, generated - paid - reserved),
    adjustment: Math.max(0, paid + reserved - generated) };
}

export function validateCommissionRequest(input: CreateCommissionRequestInput, currentPeriod: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period) || input.period < COMMISSION_FIRST_PERIOD || input.period > currentPeriod) {
    throw new CommissionError("El periodo de comisión no es válido.");
  }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new CommissionError("Ingresa un monto positivo en pesos enteros.");
  }
  const nequi = String(input.nequi || "").replace(/[\s()-]/g, "");
  if (!/^3\d{9}$/.test(nequi)) throw new CommissionError("Ingresa un número de Nequi colombiano de 10 dígitos.");
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotencyKey || "")) {
    throw new CommissionError("La solicitud requiere una clave de operación válida.");
  }
  return { ...input, nequi };
}
