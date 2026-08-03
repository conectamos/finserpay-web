import {
  PAYMENT_FREQUENCY_OPTIONS,
  normalizePaymentFrequency,
} from "@/lib/credit-factory";
import {
  calendarDateKey,
  getColombiaDateParts,
  type CalendarDateParts,
} from "@/lib/colombia-date";

export type CreditPaymentPlanInput = {
  montoCredito?: number | null;
  valorCuota?: number | null;
  plazoMeses?: number | null;
  frecuenciaPago?: string | null;
  fechaPrimerPago?: Date | string | null;
  abonos?: Array<{
    valor?: number | null;
    fechaAbono?: Date | string | null;
  }>;
  today?: Date | string | null;
  settled?: boolean;
};

export type CreditPaymentPlanInstallment = {
  numero: number;
  fechaVencimiento: string;
  valorProgramado: number;
  valorAbonado: number;
  saldoPendiente: number;
  estado: "PAGO" | "PENDIENTE";
  estaEnMora: boolean;
};

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizePending(value: number) {
  const rounded = roundMoney(value);
  return rounded < 1 ? 0 : rounded;
}

function normalizeStoredCalendarDate(
  value: Date | string | null | undefined,
  fallback = new Date()
): CalendarDateParts {
  const normalizedValue = String(value || "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    const [year, month, day] = normalizedValue.split("-").map(Number);
    return { year, month, day };
  }

  const date = value instanceof Date ? new Date(value) : new Date(String(value || ""));

  if (Number.isNaN(date.getTime())) {
    return getColombiaDateParts(fallback);
  }

  // Credit due dates are calendar values stored by Prisma as UTC DateTime.
  // Preserve that stored calendar day instead of projecting it to a timezone.
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function toUtcCalendarDate(parts: CalendarDateParts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
}

function utcCalendarParts(date: Date): CalendarDateParts {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function addCalendarPaymentFrequency(
  start: CalendarDateParts,
  frequencyValue: unknown,
  periods: number
) {
  const frequency = normalizePaymentFrequency(frequencyValue);
  const steps = Math.max(0, Math.trunc(Number(periods || 0)));

  if (frequency === "QUINCENAL") {
    let dueMonth = start.month - 1;
    let dueYear = start.year;
    let dueDay = start.day <= 2 ? 2 : 17;

    for (let index = 0; index < steps; index += 1) {
      if (dueDay === 2) {
        dueDay = 17;
      } else {
        dueDay = 2;
        dueMonth += 1;
      }

      const normalized = new Date(Date.UTC(dueYear, dueMonth, dueDay, 12));
      dueYear = normalized.getUTCFullYear();
      dueMonth = normalized.getUTCMonth();
    }

    return utcCalendarParts(
      new Date(Date.UTC(dueYear, dueMonth, dueDay, 12))
    );
  }

  const date = toUtcCalendarDate(start);

  if (frequency === "MENSUAL") {
    date.setUTCMonth(date.getUTCMonth() + steps);
  } else {
    const days =
      PAYMENT_FREQUENCY_OPTIONS.find((option) => option.value === frequency)
        ?.days || 15;
    date.setUTCDate(date.getUTCDate() + days * steps);
  }

  return utcCalendarParts(date);
}

export function buildCreditPaymentPlan(input: CreditPaymentPlanInput) {
  const total = Math.max(0, Number(input.montoCredito || 0));
  const cuotas = Math.max(1, Math.trunc(Number(input.plazoMeses || 1)));
  const frecuenciaPago = normalizePaymentFrequency(input.frecuenciaPago);
  const defaultQuota = Math.max(0, Number(input.valorCuota || 0));
  const firstDueDate = normalizeStoredCalendarDate(input.fechaPrimerPago);
  const todayKey = calendarDateKey(getColombiaDateParts(input.today, new Date()));

  const totalPaid = roundMoney(
    (input.abonos || []).reduce((sum, item) => sum + Math.max(0, Number(item.valor || 0)), 0)
  );
  let remainingPaid = totalPaid;
  let assignedTotal = 0;

  const installments: CreditPaymentPlanInstallment[] = Array.from(
    { length: cuotas },
    (_, index) => {
      const numero = index + 1;
      const isLast = numero === cuotas;
      const programmed = isLast
        ? roundMoney(Math.max(0, total - assignedTotal))
        : roundMoney(defaultQuota > 0 ? defaultQuota : total / cuotas);
      assignedTotal = roundMoney(assignedTotal + programmed);

      const paid = roundMoney(Math.min(programmed, remainingPaid));
      remainingPaid = roundMoney(Math.max(0, remainingPaid - paid));
      const pending = normalizePending(Math.max(0, programmed - paid));
      const dueDate = addCalendarPaymentFrequency(
        firstDueDate,
        frecuenciaPago,
        index
      );
      const dueDateKey = calendarDateKey(dueDate);
      const isPaid = pending <= 0;
      const isOverdue = !isPaid && dueDateKey < todayKey;

      return {
        numero,
        fechaVencimiento: dueDateKey,
        valorProgramado: programmed,
        valorAbonado: paid,
        saldoPendiente: pending,
        estado: isPaid ? "PAGO" : "PENDIENTE",
        estaEnMora: isOverdue,
      };
    }
  );

  const effectiveInstallments = input.settled
    ? installments.map((item) => ({
        ...item,
        estado: "PAGO" as const,
        estaEnMora: false,
        saldoPendiente: 0,
      }))
    : installments;
  const nextInstallment = input.settled
    ? null
    : effectiveInstallments.find((item) => item.saldoPendiente > 0) ||
      effectiveInstallments[effectiveInstallments.length - 1] ||
      null;
  const overdueCount = effectiveInstallments.filter((item) => item.estaEnMora).length;
  const paidCount = effectiveInstallments.filter((item) => item.estado === "PAGO").length;
  const pendingCount = effectiveInstallments.filter(
    (item) => item.saldoPendiente > 0
  ).length;
  const saldoPendiente = roundMoney(
    effectiveInstallments.reduce((sum, item) => sum + item.saldoPendiente, 0)
  );

  return {
    installments: effectiveInstallments,
    nextInstallment,
    overdueCount,
    paidCount,
    pendingCount,
    totalPaid,
    saldoPendiente,
    estadoPago:
      saldoPendiente <= 0 ? "PAGADO" : overdueCount > 0 ? "MORA" : "AL_DIA",
  };
}
