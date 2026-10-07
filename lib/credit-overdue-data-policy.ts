import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { isExcludedCarteraCreditState } from "@/lib/cartera-export";
import { resolveCarteraDaysPastDue } from "@/lib/cartera-due-days";
import { type DateValue } from "@/lib/colombia-date";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";
import { isCreditDueReminderWindow, type CreditDueReminderCredit } from "@/lib/credit-due-reminder-policy";

export type CreditOverdueDataCredit = CreditDueReminderCredit;

export type CreditOverdueDataCandidate = {
  creditId: number;
  phone: string;
  name: string;
  daysPastDue: number;
  installmentNumber: number;
  dueDate: string;
};

export const OVERDUE_DATA_MIN_DAYS = 20;

function isRegisteredCalendarDate(value: DateValue): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value !== "string") return false;
  const stored = value.trim();
  const calendarDay = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(stored)?.[1];
  if (!calendarDay || !Number.isFinite(new Date(stored).getTime())) return false;
  const calendarDate = new Date(`${calendarDay}T00:00:00.000Z`);
  return Number.isFinite(calendarDate.getTime()) && calendarDate.toISOString().slice(0, 10) === calendarDay;
}

/** Cartera's Mora is the age of the oldest installment that is still unpaid. */
export function getCreditOverdueDataCandidate(
  credit: CreditOverdueDataCredit,
  today: DateValue
): CreditOverdueDataCandidate | null {
  if (!isRegisteredCalendarDate(today)) return null;
  const state = String(credit.estado || "").trim().toUpperCase();
  if (state.includes("ANUL") || isExcludedCarteraCreditState(state) || state === "PAGADO" || state === "PAZ_Y_SALVO" ||
      credit.pazYSalvoEmitidoAt || !Number.isSafeInteger(credit.id) || credit.id < 1) return null;
  const phone = normalizeColombianMobile(credit.clienteTelefono);
  const name = String(credit.clienteNombre || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!phone || !name) return null;

  try {
    const amount = Number(credit.montoCredito || 0);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const firstDue = isRegisteredCalendarDate(credit.fechaPrimerPago) ? credit.fechaPrimerPago : undefined;
    const nextDue = isRegisteredCalendarDate(credit.fechaProximoPago) ? credit.fechaProximoPago : undefined;
    if (!firstDue && !nextDue && credit.planCapitalVigente == null) return null;
    // Non-null snapshots must validate; invalid plans never fall back to guessed dates.
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
    if (plan.estadoPago === "PAGADO" || !(plan.saldoPendiente > 0) || !(plan.pendingCount > 0)) return null;
    const daysPastDue = resolveCarteraDaysPastDue(plan, today);
    if (daysPastDue < OVERDUE_DATA_MIN_DAYS) return null;
    const oldest = plan.installments
      .filter(installment => installment.estaEnMora && installment.saldoPendiente > 0)
      .reduce<typeof plan.nextInstallment>((previous, installment) =>
        !previous || installment.fechaVencimiento < previous.fechaVencimiento ||
        (installment.fechaVencimiento === previous.fechaVencimiento && installment.numero < previous.numero)
          ? installment : previous, null);
    if (!oldest) return null;
    return { creditId: credit.id, phone, name, daysPastDue,
      installmentNumber: oldest.numero, dueDate: oldest.fechaVencimiento };
  } catch {
    return null;
  }
}

/** One recipient per mobile; use greatest arrears, then the lowest credit id. */
export function groupCreditOverdueDataCandidates(
  candidates: ReadonlyArray<CreditOverdueDataCandidate>
): CreditOverdueDataCandidate[] {
  const byPhone = new Map<string, CreditOverdueDataCandidate>();
  for (const candidate of candidates) {
    const previous = byPhone.get(candidate.phone);
    if (!previous || candidate.daysPastDue > previous.daysPastDue ||
        (candidate.daysPastDue === previous.daysPastDue && candidate.creditId < previous.creditId)) {
      byPhone.set(candidate.phone, candidate);
    }
  }
  return [...byPhone.values()].sort((left, right) => left.phone.localeCompare(right.phone));
}

/** Only the sending hour; the persistent worker owns the three-day cadence. */
export function isCreditOverdueDataWindow(now: Date): boolean {
  return isCreditDueReminderWindow(now);
}
