export type CreditPaymentPlanInput = {
  montoCredito?: number | null;
  valorCuota?: number | null;
  plazoMeses?: number | null;
  fechaPrimerPago?: Date | string | null;
  abonos?: Array<{
    valor?: number | null;
    fechaAbono?: Date | string | null;
  }>;
  today?: Date | string | null;
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

function normalizeDate(value: Date | string | null | undefined, fallback = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(String(value || ""));

  if (Number.isNaN(date.getTime())) {
    return new Date(fallback);
  }

  return date;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  const originalDay = next.getDate();

  next.setMonth(next.getMonth() + months);

  if (next.getDate() < originalDay) {
    next.setDate(0);
  }

  return next;
}

function toDateOnlyIso(date: Date) {
  const normalized = new Date(date);
  normalized.setHours(12, 0, 0, 0);
  return normalized.toISOString().slice(0, 10);
}

export function buildCreditPaymentPlan(input: CreditPaymentPlanInput) {
  const total = Math.max(0, Number(input.montoCredito || 0));
  const cuotas = Math.max(1, Math.trunc(Number(input.plazoMeses || 1)));
  const defaultQuota = Math.max(0, Number(input.valorCuota || 0));
  const firstDueDate = normalizeDate(input.fechaPrimerPago);
  const today = normalizeDate(input.today, new Date());
  today.setHours(23, 59, 59, 999);

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
      const pending = roundMoney(Math.max(0, programmed - paid));
      const dueDate = addMonths(firstDueDate, index);
      dueDate.setHours(23, 59, 59, 999);
      const isPaid = pending <= 0;
      const isOverdue = !isPaid && dueDate.getTime() < today.getTime();

      return {
        numero,
        fechaVencimiento: toDateOnlyIso(dueDate),
        valorProgramado: programmed,
        valorAbonado: paid,
        saldoPendiente: pending,
        estado: isPaid ? "PAGO" : "PENDIENTE",
        estaEnMora: isOverdue,
      };
    }
  );

  const nextInstallment =
    installments.find((item) => item.saldoPendiente > 0) ||
    installments[installments.length - 1] ||
    null;
  const overdueCount = installments.filter((item) => item.estaEnMora).length;
  const paidCount = installments.filter((item) => item.estado === "PAGO").length;
  const pendingCount = installments.filter((item) => item.saldoPendiente > 0).length;
  const saldoPendiente = roundMoney(
    installments.reduce((sum, item) => sum + item.saldoPendiente, 0)
  );

  return {
    installments,
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
