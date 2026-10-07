import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { isExcludedCarteraCreditState } from "@/lib/cartera-export";
import { resolveCarteraDaysPastDue } from "@/lib/cartera-due-days";
import { COLOMBIA_TIME_ZONE, type DateValue } from "@/lib/colombia-date";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";

export type CreditDueReminderCredit = {
  id: number;
  clienteNombre: string;
  clienteTelefono?: string | null;
  estado: string;
  pazYSalvoEmitidoAt?: Date | string | null;
  planCapitalVigente?: unknown;
  montoCredito: unknown;
  valorCuota: unknown;
  plazoMeses: unknown;
  frecuenciaPago: string;
  fechaPrimerPago?: Date | string | null;
  fechaProximoPago?: Date | string | null;
  abonos?: Array<{ valor: unknown; fechaAbono?: Date | string | null; estado?: string | null }>;
};

export type CreditDueReminder = {
  creditId: number;
  installmentNumber: number;
  dueDate: string;
  phone: string;
  name: string;
};

const reminderHourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: COLOMBIA_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

function isRegisteredCalendarDate(value: DateValue): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value !== "string") return false;
  const stored = value.trim();
  const calendarDay = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(stored)?.[1];
  if (!calendarDay || !Number.isFinite(new Date(stored).getTime())) return false;
  const calendarDate = new Date(`${calendarDay}T00:00:00.000Z`);
  return Number.isFinite(calendarDate.getTime()) && calendarDate.toISOString().slice(0, 10) === calendarDay;
}

/** Daily sending window: 10:00 inclusive to 11:00 exclusive in Colombia. */
export function isCreditDueReminderWindow(now: Date): boolean {
  return Number.isFinite(now.getTime()) && reminderHourFormatter.format(now) === "10";
}

/** Select the same AD = -1 rows as Excel, with contact and settled-credit guards. */
export function getCreditDueReminder(credit: CreditDueReminderCredit, today: DateValue): CreditDueReminder | null {
  const state = String(credit.estado || "").trim().toUpperCase();
  if (isExcludedCarteraCreditState(state) || state === "PAGADO" || state === "PAZ_Y_SALVO" ||
      credit.pazYSalvoEmitidoAt || !Number.isSafeInteger(credit.id) || credit.id < 1) return null;
  const phone = normalizeColombianMobile(credit.clienteTelefono);
  const name = String(credit.clienteNombre || "").trim().slice(0, 100);
  if (!phone || !name) return null;

  try {
    const amount = Number(credit.montoCredito || 0);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const firstDue = isRegisteredCalendarDate(credit.fechaPrimerPago) ? credit.fechaPrimerPago : undefined;
    const nextDue = isRegisteredCalendarDate(credit.fechaProximoPago) ? credit.fechaProximoPago : undefined;
    if (!firstDue && !nextDue && credit.planCapitalVigente == null) return null;
    // The plan builder validates every non-null snapshot and its internal calendar.
    const plan = buildCreditPaymentPlan({
      planCapitalVigente: credit.planCapitalVigente,
      montoCredito: amount,
      valorCuota: Number(credit.valorCuota || 0),
      plazoMeses: Number(credit.plazoMeses || 1),
      frecuenciaPago: credit.frecuenciaPago,
      fechaPrimerPago: firstDue || nextDue,
      fechaProximoPago: nextDue,
      abonos: (credit.abonos || [])
        .filter(abono => String(abono.estado || "").trim().toUpperCase() !== "ANULADO")
        .map(abono => ({ valor: Number(abono.valor || 0), fechaAbono: abono.fechaAbono })),
      today,
      settled: Boolean(credit.pazYSalvoEmitidoAt),
    });
    const next = plan.nextInstallment;
    if (plan.estadoPago === "PAGADO" || !(plan.saldoPendiente > 0) ||
        !next || !(next.saldoPendiente > 0) || resolveCarteraDaysPastDue(plan, today) !== -1) return null;
    return { creditId: credit.id, installmentNumber: next.numero,
      dueDate: next.fechaVencimiento, phone, name };
  } catch {
    // An invalid revised financial plan cannot revert to the original calendar.
    return null;
  }
}
