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
