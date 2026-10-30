import { normalizeAttentionPhone } from "./atencion-core";
import type { AttentionCreditClassification } from "./atencion-types";

export type AttentionCreditIdentityRecord = {
  id: number;
  clienteTelefono: string | null;
  clienteDocumento: string | null;
  clienteTipoDocumento?: string | null;
  estado: string;
};
export type AttentionCreditResolution = {
  classification: AttentionCreditClassification;
  autoTags: "FINSERPAY"[];
  creditIds: number[];
};

export function attentionPhoneOrNull(value: unknown): string | null {
  try { return normalizeAttentionPhone(value); } catch { return null; }
}

/** Match the input parser, including its sole country inference: Colombian mobile numbers. */
export function attentionPhoneSql(alias: "c" | "k" | "d"): string {
  const raw = `regexp_replace(COALESCE(${alias}."clienteTelefono",''),'^[[:space:]]+|[[:space:]]+$','','g')`;
  const digits = `regexp_replace(regexp_replace(${raw},'[^0-9]','','g'),'^00','')`;
  const national = `(CASE WHEN length(${digits})=10 AND ${digits} LIKE '3%' THEN '57'||${digits} ELSE ${digits} END)`;
  return `(CASE WHEN ${raw} ~ '^(\\+|00)?[0-9[:space:]().-]+$' AND ${national} ~ '^[1-9][0-9]{7,14}$' THEN '+'||${national} ELSE NULL END)`;
}

/** Preserve letters and document type: a passport AB123 must never become CC123. */
export function attentionDocumentKey(record: { clienteDocumento: string | null; clienteTipoDocumento?: string | null }): string | null {
  const document = (record.clienteDocumento || "").normalize("NFKC").toUpperCase().replace(/[\s.-]/g, "");
  if (!/^[A-Z0-9]+$/.test(document)) return null;
  let type = (record.clienteTipoDocumento || "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[\s._-]/g, "");
  if (["1", "CC", "CEDULADECIUDADANIA"].includes(type)) type = "CC";
  if (["CE", "CEDULADEEXTRANJERIA"].includes(type)) type = "CE";
  if (["PA", "PASAPORTE", "PASSPORT"].includes(type)) type = "PASAPORTE";
  return `${type}:${document}`;
}

// Operational states from resolveCreditState and historical finalized states used
// by commissions-storage. New or misspelled states require review, never approval.
const registeredStates = new Set(["GENERADO", "INSCRITO", "ENTREGABLE", "ENTREGADO", "FINALIZADO", "ACTIVO", "AL_DIA", "MORA",
  "MORA_BLOQUEADO", "ROBO_BLOQUEADO", "PAGADO", "PAZ_Y_SALVO", "APROBADO"]);
const nonCreditStates = new Set(["ANULADO", "ANULADA", "CANCELADO", "CANCELADA", "BORRADOR", "PENDIENTE", "RECHAZADO", "RECHAZADA", "SOLICITADO", "SOLICITADA"]);
export function attentionCreditIsRegistered(record: Pick<AttentionCreditIdentityRecord, "estado">): boolean {
  return registeredStates.has(record.estado.trim().toUpperCase());
}

/**
 * Read-only identity resolution. Callers must first authorize and lock the chat,
 * then supply all exact-phone candidates inside that same transaction. This does
 * not grant access, change a link, or authorize a financial operation.
 */
export function resolveAttentionCreditIdentity(
  conversation: { phone: string | null; linkedCreditId: number | null },
  records: readonly AttentionCreditIdentityRecord[],
): AttentionCreditResolution {
  const empty = (status: AttentionCreditResolution["classification"]["status"], creditCount: number | null = null): AttentionCreditResolution =>
    ({ classification: { status, source: null, creditCount }, autoTags: [], creditIds: [] });
  const phone = attentionPhoneOrNull(conversation.phone);
  if (!phone) return empty("unverified");
  const candidates = [...new Map(records.filter(record => Number.isSafeInteger(record.id) && record.id > 0 &&
    attentionPhoneOrNull(record.clienteTelefono) === phone).map(record => [record.id, record])).values()];
  const linked = conversation.linkedCreditId === null ? null : candidates.find(record => record.id === conversation.linkedCreditId);
  if (conversation.linkedCreditId !== null && !linked) return empty("unverified");
  const identityKey = (record: AttentionCreditIdentityRecord) => attentionDocumentKey(record) || `credit:${record.id}`;
  const keys = new Set(candidates.map(identityKey));
  if (!linked && keys.size > 1) return empty("ambiguous");
  const identity = linked || candidates[0];
  if (!identity) return empty("no_credit", 0);
  const selected = candidates.filter(record => identityKey(record) === identityKey(identity));
  const creditIds = selected.filter(attentionCreditIsRegistered)
    .map(record => record.id).sort((a, b) => a - b);
  if (!creditIds.length) return selected.some(record => !nonCreditStates.has(record.estado.trim().toUpperCase()))
    ? empty("unverified") : empty("no_credit", 0);
  return { classification: { status: "finserpay", source: linked ? "manual_link" : "exact_phone", creditCount: creditIds.length },
    autoTags: ["FINSERPAY"], creditIds };
}
