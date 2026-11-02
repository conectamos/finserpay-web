import { createHash, randomBytes } from "node:crypto";
import { AttentionError } from "./atencion-core";
import { financialDate } from "./atencion-financial-core";
import type { DianaExtensionProposalInput, DianaExtensionProposalView } from "./diana-extension-types";

export const DIANA_EXTENSION_ACTOR = "SYSTEM_DIANA";
export const DIANA_EXTENSION_PROPOSAL_MS = 15 * 60 * 1000;
export const DIANA_EXTENSION_CODE = /^PR-[A-F0-9]{16}$/;
export const dianaExtensionDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const newDianaExtensionCode = () => `PR-${randomBytes(8).toString("hex").toUpperCase()}`;
export function parseDianaExtensionProposal(value: unknown): DianaExtensionProposalInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttentionError("Propuesta inválida.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["cedula", "folio", "days", "promiseAmount", "promiseDate", "reason"].includes(key))) throw new AttentionError("La propuesta contiene campos no admitidos.");
  if (typeof input.cedula !== "string" || !/^\d{5,15}$/.test(input.cedula)) throw new AttentionError("Indica la cédula consultada.");
  if (typeof input.folio !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.folio)) throw new AttentionError("Indica el folio exacto del crédito consultado.");
  if (typeof input.days !== "number" || ![1, 2, 3, 4].includes(input.days)) throw new AttentionError("Selecciona entre uno y cuatro días.");
  if (typeof input.promiseAmount !== "number" || !Number.isFinite(input.promiseAmount) || input.promiseAmount <= 0 || input.promiseAmount > 1e12 || Math.round(input.promiseAmount * 100) / 100 !== input.promiseAmount) throw new AttentionError("Indica un compromiso de pago válido.");
  if (typeof input.reason !== "string" || input.reason.trim().length < 5 || input.reason.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new AttentionError("Indica el motivo de la solicitud, de 5 a 500 caracteres.");
  return { cedula: input.cedula, folio: input.folio, days: input.days as 1 | 2 | 3 | 4,
    promiseAmount: input.promiseAmount, promiseDate: financialDate(input.promiseDate), reason: input.reason.trim() };
}
export function parseDianaExtensionCode(value: unknown): string {
  if (typeof value !== "string" || !DIANA_EXTENSION_CODE.test(value)) throw new AttentionError("Código de propuesta inválido.");
  return value;
}
export function dianaExtensionMessageCode(text: string, direction: "outbound" | "inbound") {
  if (direction === "inbound") return /^CONFIRMO (PR-[A-F0-9]{16})$/.exec(text.trim())?.[1] || null;
  const codes = text.match(/\bPR-[A-F0-9]{16}\b/g) || [];
  return codes.length === 1 ? codes[0] : null;
}
const dateLabel = (value: string) => value.split("-").reverse().join("/");
export function dianaExtensionOffer(input: Pick<DianaExtensionProposalView, "code" | "days" | "installmentNumber" | "installmentDueDate" | "expiresOn" | "promiseAmount" | "promiseDate" | "expiresAt"> & { folio: string }) {
  const amount = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(input.promiseAmount);
  const until = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(input.expiresAt));
  // No names, document numbers or telephone numbers. The exact delivered text
  // is the witness of the terms; an LLM paraphrase cannot authorize a grant.
  return `Propuesta de prórroga FINSER PAY\nCrédito: ${input.folio}\nCuota: ${input.installmentNumber}, vencimiento ${dateLabel(input.installmentDueDate)}\nPrórroga: ${input.days} ${input.days === 1 ? "día" : "días"}, hasta ${dateLabel(input.expiresOn)}\nCompromiso de pago: ${amount} el ${dateLabel(input.promiseDate)}\nPropuesta válida hasta ${until}, hora de Colombia. Todavía no está aprobada.\nPara confirmar estas condiciones, responde exactamente:\nCONFIRMO ${input.code}`;
}
export function dianaExtensionFollowUp(promiseDate: string) {
  const date = new Date(`${financialDate(promiseDate)}T13:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}
