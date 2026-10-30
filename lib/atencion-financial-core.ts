import { AttentionError, attentionText, attentionUuid } from "./atencion-core";
import { attentionId } from "./atencion-http";
import { buildCreditPaymentPlan, type CreditPaymentPlanInput } from "./credit-payment-plan";
import { parseCapitalPlanSnapshot } from "./credit-principal-payment";
import { colombiaDateKey } from "./colombia-date";
import type { AttentionExtensionInput, AttentionFinancialCredit, AttentionReceiptSendInput } from "./atencion-financial-types";

export function financialDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AttentionError("Fecha de compromiso inválida.");
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new AttentionError("Fecha de compromiso inválida.");
  return value;
}
export function financialDay(value: Date | string) { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10); }
export function addFinancialDays(value: string, days: number) {
  const date = new Date(`${financialDate(value)}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
function version(value: unknown) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new AttentionError("Versión inválida."); return value; }
function exactFields(body: Record<string, unknown>, keys: string[]) { if (Object.keys(body).some(key => !keys.includes(key))) throw new AttentionError("La solicitud contiene campos no admitidos."); }
export function parseAttentionExtension(body: Record<string, unknown>): AttentionExtensionInput {
  exactFields(body, ["creditId", "days", "version", "requestId", "reason", "observation", "promiseAmount", "promiseDate"]);
  if (typeof body.days !== "number" || ![1, 2, 3, 4].includes(body.days)) throw new AttentionError("Selecciona entre uno y cuatro días.");
  if (typeof body.promiseAmount !== "number" || !Number.isFinite(body.promiseAmount) || body.promiseAmount <= 0 || body.promiseAmount > 1e12 || Math.round(body.promiseAmount * 100) / 100 !== body.promiseAmount) throw new AttentionError("Indica un compromiso de pago válido.");
  const reason = attentionText(body.reason, 500), observation = attentionText(body.observation, 2000);
  if (reason.length < 5 || observation.length < 5) throw new AttentionError("El motivo y la observación requieren al menos cinco caracteres.");
  return { creditId: attentionId(body.creditId), days: body.days as AttentionExtensionInput["days"], version: version(body.version), requestId: attentionUuid(body.requestId), reason, observation, promiseAmount: body.promiseAmount, promiseDate: financialDate(body.promiseDate) };
}
export function parseAttentionReceiptSend(body: Record<string, unknown>): AttentionReceiptSendInput {
  exactFields(body, ["creditId", "paymentId", "version", "requestId"]);
  return { creditId: attentionId(body.creditId), paymentId: attentionId(body.paymentId), version: version(body.version), requestId: attentionUuid(body.requestId) };
}
export type FinancialPlanCredit = CreditPaymentPlanInput & { estado: string; pazYSalvoEmitidoAt: Date | string | null };
export function financialPlan(credit: FinancialPlanCredit, now: Date) {
  // Do not let the plan's compatibility defaults invent today's first due date.
  let capital;
  try { capital = credit.planCapitalVigente ? parseCapitalPlanSnapshot(credit.planCapitalVigente) : null; }
  catch { return null; }
  if (credit.planCapitalVigente && !capital) return null;
  if (!capital && (!credit.fechaPrimerPago || !Number.isFinite(new Date(credit.fechaPrimerPago).getTime()) || !Number.isFinite(Number(credit.plazoMeses)) || Number(credit.plazoMeses) < 1 || !Number.isFinite(Number(credit.montoCredito)) || Number(credit.montoCredito) <= 0 || !Number.isFinite(Number(credit.valorCuota)) || Number(credit.valorCuota) <= 0)) return null;
  return buildCreditPaymentPlan({ ...credit, fechaProximoPago: null, today: colombiaDateKey(now), settled: Boolean(credit.pazYSalvoEmitidoAt) });
}
export function extensionEligibility(credit: FinancialPlanCredit, open: { id: string; type: string; status: string; expiresOn: Date | string | null } | null, now: Date): AttentionFinancialCredit["extension"] {
  const today = colombiaDateKey(now), plan = financialPlan(credit, now);
  const installment = plan?.installments.find(item => !item.eliminada && item.saldoPendiente > 0);
  const dueDate = installment?.fechaVencimiento || null;
  const protectedCredit = open?.status === "APPROVED" && (!open.expiresOn || financialDay(open.expiresOn) >= today);
  const active = protectedCredit && open.type === "PRORROGA" ? { id: open.id, expiresOn: open.expiresOn ? financialDay(open.expiresOn) : null } : null;
  const pending = open?.status === "PENDING" || protectedCredit;
  const blockedReason = ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(credit.estado.trim().toUpperCase()) ? "El crédito está anulado."
    : !plan ? "El crédito no tiene un calendario completo verificado."
    : pending ? "Ya existe una solicitud pendiente o una excepción vigente para este crédito."
    : !installment || plan.estadoPago !== "MORA" ? "El crédito no tiene una cuota regular vencida."
    : !dueDate || ![2, 17].includes(Number(dueDate.slice(8, 10))) || today <= dueDate || today > addFinancialDays(dueDate, 4) ? "La prórroga solo está disponible después del vencimiento 02/17 y hasta el día 06/21." : null;
  const choices = blockedReason || !dueDate ? [] : ([1, 2, 3, 4] as const).map(days => ({ days, expiresOn: addFinancialDays(dueDate, days) })).filter(choice => choice.expiresOn >= today);
  return { canGrant: !blockedReason && choices.length > 0, blockedReason, installmentNumber: installment?.numero ?? null, dueDate, choices, active,
    promise: { amount: installment ? Math.min(installment.saldoPendiente, Number(credit.valorCuota || installment.saldoPendiente)) : 0, date: choices.at(-1)?.expiresOn || today } };
}
