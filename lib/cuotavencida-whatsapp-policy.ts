import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { isExcludedCarteraCreditState } from "@/lib/cartera-export";
import { resolveCarteraDaysPastDue } from "@/lib/cartera-due-days";
import { type DateValue } from "@/lib/colombia-date";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";
import { type CreditDueReminderCredit } from "@/lib/credit-due-reminder-policy";

export type CuotaVencidaWhatsAppCredit = CreditDueReminderCredit & { clienteDocumento?: string | null };
export type CuotaVencidaWhatsAppCandidate = {
  creditId: number; document: string | null; phone: string; name: string; daysPastDue: number;
  installmentNumber: number; dueDate: string;
};
export type CuotaVencidaWhatsAppGroup = {
  identityKey: string; phone: string; name: string; creditIds: number[]; representativeCreditId: number;
};

function registeredDate(value: DateValue): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value !== "string") return false;
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value.trim())?.[1];
  if (!day || !Number.isFinite(new Date(value).getTime())) return false;
  return new Date(day + "T00:00:00Z").toISOString().slice(0, 10) === day;
}
export function documentKey(value: unknown): string | null {
  if (typeof value !== "string" || !/^[\d\s.-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  return /^\d{5,15}$/.test(digits) ? digits : null;
}

/** The same unpaid-plan/Colombian-day rule as the Cartera export, with no guessed calendar. */
export function getCuotaVencidaWhatsAppCandidate(
  credit: CuotaVencidaWhatsAppCredit, today: DateValue,
): CuotaVencidaWhatsAppCandidate | null {
  const state = String(credit.estado || "").trim().toUpperCase();
  const phone = normalizeColombianMobile(credit.clienteTelefono);
  const name = String(credit.clienteNombre || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!registeredDate(today) || !Number.isSafeInteger(credit.id) || credit.id < 1 || !phone || !name || /[\p{Cc}\p{Cf}]/u.test(name)
    || state.includes("ANUL") || isExcludedCarteraCreditState(state) || ["PAGADO", "PAZ_Y_SALVO"].includes(state)
    || credit.pazYSalvoEmitidoAt) return null;
  try {
    const first = registeredDate(credit.fechaPrimerPago) ? credit.fechaPrimerPago : undefined;
    const next = registeredDate(credit.fechaProximoPago) ? credit.fechaProximoPago : undefined;
    const amount = Number(credit.montoCredito);
    if (!Number.isFinite(amount) || amount <= 0 || (!first && !next && credit.planCapitalVigente == null)) return null;
    const plan = buildCreditPaymentPlan({
      planCapitalVigente: credit.planCapitalVigente, montoCredito: amount,
      valorCuota: Number(credit.valorCuota || 0), plazoMeses: Number(credit.plazoMeses || 1), frecuenciaPago: credit.frecuenciaPago,
      fechaPrimerPago: first || next, fechaProximoPago: next, settled: false, today,
      abonos: (credit.abonos || []).filter(item => String(item.estado || "").trim().toUpperCase() !== "ANULADO")
        .map(item => ({ valor: Number(item.valor || 0), fechaAbono: item.fechaAbono })),
    });
    const daysPastDue = resolveCarteraDaysPastDue(plan, today);
    const oldest = plan.installments.filter(item => item.estaEnMora && item.saldoPendiente > 0)
      .sort((left, right) => left.fechaVencimiento.localeCompare(right.fechaVencimiento) || left.numero - right.numero)[0];
    if (plan.estadoPago === "PAGADO" || !(plan.saldoPendiente > 0) || !(plan.pendingCount > 0) || daysPastDue < 1 || !oldest) return null;
    return { creditId: credit.id, document: documentKey(credit.clienteDocumento), phone, name, daysPastDue,
      installmentNumber: oldest.numero, dueDate: oldest.fechaVencimiento };
  } catch { return null; }
}

/** One titular per message. Missing documents fall back to the primary mobile, never a reference. */
export function groupCuotaVencidaWhatsAppCandidates(candidates: ReadonlyArray<CuotaVencidaWhatsAppCandidate>) {
  const documentsByPhone = new Map<string, Set<string>>();
  for (const item of candidates) {
    const owners = documentsByPhone.get(item.phone) ?? new Set<string>();
    if (item.document) owners.add(item.document);
    documentsByPhone.set(item.phone, owners);
  }
  const byIdentity = new Map<string, CuotaVencidaWhatsAppCandidate[]>();
  let sharedPhoneCredits = 0;
  for (const item of candidates) {
    const owners = documentsByPhone.get(item.phone)!;
    if (owners.size > 1) { sharedPhoneCredits++; continue; }
    const document = item.document ?? (owners.size === 1 ? [...owners][0] : null);
    const key = document ? "document:" + document : "phone:" + item.phone;
    const group = byIdentity.get(key) ?? []; group.push(item); byIdentity.set(key, group);
  }
  const groups: CuotaVencidaWhatsAppGroup[] = [];
  for (const [identityKey, credits] of byIdentity) {
    const representative = [...credits].sort((left, right) => right.daysPastDue - left.daysPastDue || left.creditId - right.creditId)[0];
    groups.push({ identityKey, phone: representative.phone, name: representative.name,
      creditIds: [...new Set(credits.map(item => item.creditId))].sort((a, b) => a - b), representativeCreditId: representative.creditId });
  }
  return { groups: groups.sort((left, right) => left.identityKey.localeCompare(right.identityKey)), sharedPhoneCredits };
}
