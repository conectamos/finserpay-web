import { getColombiaDateParts, type DateValue } from "@/lib/colombia-date";

type DueDayPlan = {
  installments: ReadonlyArray<{ fechaVencimiento: string; saldoPendiente: number }>;
  nextInstallment: { fechaVencimiento: string } | null;
};

function signedDaysFromDueDate(dueDate: string, today: DateValue) {
  const due = new Date(`${dueDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(due.getTime()) ||
      due.toISOString().slice(0, 10) !== dueDate) return 0;
  const current = getColombiaDateParts(today);
  const currentDay = Date.UTC(current.year, current.month - 1, current.day);
  return Math.round((currentDay - due.getTime()) / 86_400_000);
}

/** The signed "Dias vencidos" value used by the cartera Excel export. */
export function resolveCarteraDaysPastDue(plan: DueDayPlan, today: DateValue): number {
  const overdueDays = plan.installments
    .filter(installment => installment.saldoPendiente > 0)
    .map(installment => signedDaysFromDueDate(installment.fechaVencimiento, today))
    .filter(days => days > 0);
  if (overdueDays.length) return Math.max(...overdueDays);
  return plan.nextInstallment
    ? signedDaysFromDueDate(plan.nextInstallment.fechaVencimiento, today)
    : 0;
}
