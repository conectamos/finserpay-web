import { createHash } from "node:crypto";
import { getCreditDueReminder, type CreditDueReminderCampaign, type CreditDueReminderCredit } from "./credit-due-reminder-policy";
import { getCreditOverdueDataCandidate } from "./credit-overdue-data-policy";
import { collectionCallingAllowed } from "./collection-voice-policy";
import { colombiaDateKey } from "./colombia-date";

export const attentionCollectionTemplateNames = ["2dias", "1_dia_falta", "hoyvence", "fechap", "data"] as const;
export type AttentionCollectionTemplateName = typeof attentionCollectionTemplateNames[number];
export type AttentionCollectionReview = {
  creditId: number; creditNumber: string; templateName: AttentionCollectionTemplateName;
  reviewHash: string; phone: string; parameters: Record<string, string>;
  installmentNumber: number; dueDate: string; day: string;
  coveredCredits: { id: number; number: string }[];
};
export type AttentionCollectionOption = { templateName: AttentionCollectionTemplateName; eligible: boolean; reason: string | null; review: AttentionCollectionReview | null };
export type AttentionCollectionTemplateList = { version: number; blockedReason: string | null; credits: { id: number; number: string; options: AttentionCollectionOption[] }[] };
export type AttentionCollectionCredit = CreditDueReminderCredit & { clienteDocumento?: string | null };
const campaigns: Record<Exclude<AttentionCollectionTemplateName, "data">, CreditDueReminderCampaign> = {
  "2dias": "two_days_before_due", "1_dia_falta": "before_due", hoyvence: "due_today", fechap: "due_today",
};
// These are the existing cron ledger keys. The date-specific alias shares hoyvence's reservation.
export function attentionCollectionReminderKey(name: Exclude<AttentionCollectionTemplateName, "data">) {
  return name === "2dias" ? "recordatorio_2_dias_antescuota" : name === "1_dia_falta" ? "recordatorio_1_dia_falta_antescuota" : "recordatorio_hoyvence_cuota";
}
export function isAttentionCollectionTemplateName(name: unknown): name is AttentionCollectionTemplateName {
  return typeof name === "string" && (attentionCollectionTemplateNames as readonly string[]).includes(name);
}
export const isAttentionCollectionTemplate = isAttentionCollectionTemplateName;
export function attentionCollectionCandidate(credit: AttentionCollectionCredit, name: AttentionCollectionTemplateName, now: Date) {
  return name === "data" ? getCreditOverdueDataCandidate(credit, now) : getCreditDueReminder(credit, now, campaigns[name]);
}
export function attentionCollectionReview(credit: AttentionCollectionCredit, input: {
  templateName: AttentionCollectionTemplateName; phone: string; creditNumber: string; now: Date;
  coveredCredits: { id: number; number: string }[]; financialSnapshot: unknown;
}): AttentionCollectionOption {
  const name = input.templateName, candidate = attentionCollectionCandidate(credit, name, input.now);
  const reason = !collectionCallingAllowed(input.now) ? "Fuera del horario de contacto vigente de cartera."
    : !candidate ? name === "data" ? "Datos solo corresponde al día exacto 20 de mora de la cuota pendiente; no aplica a una cartera pagada, protegida o con calendario inválido."
      : name === "2dias" ? "Esta plantilla solo corresponde a dos días antes de la próxima cuota pendiente."
        : name === "1_dia_falta" ? "Esta plantilla solo corresponde al día anterior a la próxima cuota pendiente."
          : "Esta plantilla solo corresponde al día de vencimiento de la próxima cuota pendiente."
      : `+${candidate.phone}` !== input.phone ? "El teléfono registrado del crédito no coincide exactamente con el chat."
        : /[\p{Cc}\p{Cf}{}]/u.test(candidate.name) ? "El nombre registrado requiere revisión antes de generar la plantilla." : null;
  if (reason || !candidate) return { templateName: name, eligible: false, reason, review: null };
  const parameters: Record<string, string> = { "body:1": candidate.name };
  if (name === "1_dia_falta" || name === "hoyvence") parameters["body:2"] = "FINSER PAY";
  if (name === "fechap") parameters["body:2"] = candidate.dueDate.split("-").reverse().join("/");
  const review = { creditId: credit.id, creditNumber: input.creditNumber, templateName: name, phone: input.phone,
    parameters, installmentNumber: candidate.installmentNumber, dueDate: candidate.dueDate, day: colombiaDateKey(input.now),
    coveredCredits: [...input.coveredCredits].sort((a,b)=>a.id-b.id) };
  const reviewHash = createHash("sha256").update(JSON.stringify({ ...review, financialSnapshot: input.financialSnapshot })).digest("hex");
  return { templateName: name, eligible: true, reason: null, review: { ...review, reviewHash } };
}
