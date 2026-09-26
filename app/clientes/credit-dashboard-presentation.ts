import { colombiaDateKey, parseColombiaDate } from "../../lib/colombia-date";

/** Calendar-day copy only. Credit status and amounts remain server-owned. */
export function paymentReminder(dueDate: string | null, overdue: boolean, now = new Date()) {
  if (overdue) return "Paga hoy y evita cargos adicionales";
  if (!dueDate) return "No tienes cuotas pendientes";
  if (Number.isNaN(parseColombiaDate(dueDate).getTime())) return "Fecha por confirmar";
  const days = Math.round(
    (Date.parse(colombiaDateKey(dueDate)) - Date.parse(colombiaDateKey(now))) / 86_400_000,
  );
  if (days === 0) return "Tu próximo pago es hoy";
  if (days < 0) return "Consulta el estado de tu próxima cuota";
  return `Próximo pago en ${days} ${days === 1 ? "día" : "días"}`;
}

type HomePaymentInstallment = {
  numero: number;
  fechaVencimiento: string;
  saldoPendiente: number;
  estaEnMora?: boolean;
  eliminada?: boolean;
};

/** Uses the server's remaining balances and delinquency flags, never scheduled face values. */
export function resolveHomeInstallmentPayment(credit: {
  estadoPago: string;
  cuotas: readonly HomePaymentInstallment[];
}) {
  const payable = credit.cuotas.filter(item => !item.eliminada && item.saldoPendiente > 0)
    .sort((left, right) => left.numero - right.numero);
  const overdue = credit.estadoPago === "MORA" ? payable.filter(item => item.estaEnMora) : [];
  const selected = overdue.length ? overdue : payable.slice(0, 1);
  const installmentLimit = selected.at(-1)?.numero;
  return {
    amount: Math.round(selected.reduce((sum, item) => sum + item.saldoPendiente, 0) * 100) / 100,
    overdueCount: overdue.length,
    dueDate: selected[0]?.fechaVencimiento ?? null,
    installmentLimit,
    // The existing checkout applies pending installments in numeric order.
    requiresPlanReview: overdue.length > 0 && payable.some(item =>
      item.numero <= (installmentLimit ?? 0) && !item.estaEnMora),
  };
}