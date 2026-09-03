import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import {
  calendarDateKey,
  getColombiaDateParts,
} from "@/lib/colombia-date";

export type PadlockUnlockCondition = "CURRENT" | "SETTLED";
export type PadlockFinancialState = "MORA" | "AL_DIA" | "SETTLED";

export type PadlockCreditPayment = {
  valor?: number | null;
  fechaAbono?: Date | string | null;
  estado?: string | null;
};

export type PadlockCreditFinancialInput = {
  montoCredito?: number | null;
  valorCuota?: number | null;
  plazoMeses?: number | null;
  frecuenciaPago?: string | null;
  fechaPrimerPago?: Date | string | null;
  fechaProximoPago?: Date | string | null;
  pazYSalvoEmitidoAt?: Date | string | null;
  abonos?: PadlockCreditPayment[];
};

export type PadlockFinancialPosition = {
  state: PadlockFinancialState;
  reliable: boolean;
  daysPastDue: number;
  effectiveDueDate: string | null;
  overdueInstallments: number;
  pendingInstallments: number;
  outstandingBalance: number;
  totalPaid: number;
};

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function finitePositive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function isValidDateValue(value: Date | string | null | undefined) {
  if (!value) return false;
  const parsed = value instanceof Date ? new Date(value) : new Date(String(value));
  return !Number.isNaN(parsed.getTime());
}

function dateKeyToUtcDay(value: string) {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return timestamp;
}

export function calendarDaysBetween(fromDateKey: string, toDateKey: string) {
  const from = dateKeyToUtcDay(fromDateKey);
  const to = dateKeyToUtcDay(toDateKey);
  if (from === null || to === null) return 0;
  return Math.max(0, Math.trunc((to - from) / 86_400_000));
}

export function effectivePadlockLockThreshold(policy: {
  graceDays: number;
  lockAfterDaysPastDue: number;
}) {
  const graceDays = Math.max(0, Math.trunc(Number(policy.graceDays || 0)));
  const lockAfterDaysPastDue = Math.max(
    0,
    Math.trunc(Number(policy.lockAfterDaysPastDue || 0))
  );
  return graceDays + lockAfterDaysPastDue;
}

export function buildPadlockFinancialPosition(
  input: PadlockCreditFinancialInput,
  now: Date | string = new Date()
): PadlockFinancialPosition {
  const payments = (input.abonos || [])
    .filter((payment) => String(payment.estado || "ACTIVO").toUpperCase() !== "ANULADO")
    .map((payment) => ({
      valor: Number(payment.valor || 0),
      fechaAbono: payment.fechaAbono,
    }));
  const hasSettlementCertificate = isValidDateValue(input.pazYSalvoEmitidoAt);
  const firstDueDate = input.fechaPrimerPago || input.fechaProximoPago || now;
  const hasPaymentSchedule = isValidDateValue(
    input.fechaPrimerPago || input.fechaProximoPago
  );
  const hasFinancialTerms =
    finitePositive(input.montoCredito) &&
    finitePositive(input.valorCuota) &&
    finitePositive(input.plazoMeses);
  const plan = buildCreditPaymentPlan({
    montoCredito: Number(input.montoCredito || 0),
    valorCuota: Number(input.valorCuota || 0),
    plazoMeses: Number(input.plazoMeses || 1),
    frecuenciaPago: input.frecuenciaPago,
    fechaPrimerPago: firstDueDate,
    fechaProximoPago: input.fechaProximoPago,
    abonos: payments,
    settled: hasSettlementCertificate,
    today: now,
  });
  const settled = hasSettlementCertificate || plan.estadoPago === "PAGADO";
  const state: PadlockFinancialState = settled
    ? "SETTLED"
    : plan.estadoPago === "MORA"
      ? "MORA"
      : "AL_DIA";
  const firstOverdue = plan.installments.find((installment) => installment.estaEnMora);
  const todayKey = calendarDateKey(getColombiaDateParts(now));

  return {
    state,
    reliable: settled || (hasPaymentSchedule && hasFinancialTerms),
    daysPastDue: firstOverdue
      ? calendarDaysBetween(firstOverdue.fechaVencimiento, todayKey)
      : 0,
    effectiveDueDate: firstOverdue?.fechaVencimiento || null,
    overdueInstallments: plan.overdueCount,
    pendingInstallments: plan.pendingCount,
    outstandingBalance: plan.saldoPendiente,
    totalPaid: plan.totalPaid,
  };
}

export function positionSatisfiesUnlockCondition(
  position: PadlockFinancialPosition,
  condition: PadlockUnlockCondition
) {
  if (!position.reliable) return false;
  if (condition === "SETTLED") return position.state === "SETTLED";
  return position.state === "AL_DIA" || position.state === "SETTLED";
}
