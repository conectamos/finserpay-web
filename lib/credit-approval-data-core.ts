import { createHash } from "node:crypto";
import { CreditApprovalError } from "@/lib/credit-approval-errors";

export const APPROVAL_DATA_FIELDS = [
  "clienteCorreo",
  "clienteTelefono",
  "clienteDepartamento",
  "clienteCiudad",
  "clienteDireccion",
  "referenciaEquipo",
] as const;

export type ApprovalDataField = (typeof APPROVAL_DATA_FIELDS)[number];
export type ApprovalDataSnapshot = Record<ApprovalDataField, string | null>;
export type ApprovalDataChanges = Partial<Record<Exclude<ApprovalDataField, "referenciaEquipo">, string>> & {
  catalogItemId?: number;
};
export type ParsedApprovalDataCorrection = {
  changes: ApprovalDataChanges;
  reason: string;
  revision: number;
  reviewHash: string;
  idempotencyKey: string;
};
export type ApprovalDataCorrectionChainEntry = {
  before: unknown;
  after: unknown;
  requestedRevision?: number;
  resultingRevision?: number;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_HASH = /^[a-f0-9]{64}$/;
const REQUEST_CHANGE_KEYS = new Set([
  "clienteCorreo",
  "clienteTelefono",
  "clienteDepartamento",
  "clienteCiudad",
  "clienteDireccion",
  "catalogItemId",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function invalid(message = "Revisa los datos que deseas corregir.") {
  return new CreditApprovalError("INVALID_DATA_CORRECTION", message);
}

function cleanText(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string") throw invalid(`${label} no es válido.`);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw invalid(`${label} no es válido.`);
  }
  return normalized;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function approvalDataDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function parseApprovalDataCorrection(value: unknown): ParsedApprovalDataCorrection {
  const body = record(value);
  if (Object.keys(body).sort().join(",") !== "changes,idempotencyKey,reason,reviewHash,revision") {
    throw invalid();
  }
  const rawChanges = record(body.changes);
  const changeKeys = Object.keys(rawChanges);
  if (!changeKeys.length || changeKeys.some((key) => !REQUEST_CHANGE_KEYS.has(key))) throw invalid();
  if (typeof body.reason !== "string" || typeof body.idempotencyKey !== "string"
      || !UUID_V4.test(body.idempotencyKey)
      || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1
      || typeof body.reviewHash !== "string" || !REVIEW_HASH.test(body.reviewHash)) throw invalid();

  const reason = cleanText(body.reason, "El motivo", 5, 500);
  const changes: ApprovalDataChanges = {};
  if ("clienteCorreo" in rawChanges) {
    const email = cleanText(rawChanges.clienteCorreo, "El correo", 3, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Ingresa un correo electrónico válido.");
    changes.clienteCorreo = email;
  }
  if ("clienteTelefono" in rawChanges) {
    const rawPhone = cleanText(rawChanges.clienteTelefono, "El teléfono", 7, 32);
    if (!/^[+\d\s().-]+$/.test(rawPhone)) throw invalid("Ingresa un celular colombiano válido.");
    let phone = rawPhone.replace(/\D/g, "");
    if (phone.length === 12 && phone.startsWith("57")) phone = phone.slice(2);
    if (!/^\d{10}$/.test(phone)) throw invalid("Ingresa un celular colombiano de 10 números.");
    changes.clienteTelefono = phone;
  }
  if ("clienteDepartamento" in rawChanges) {
    changes.clienteDepartamento = cleanText(rawChanges.clienteDepartamento, "El departamento", 2, 80).toUpperCase();
  }
  if ("clienteCiudad" in rawChanges) {
    changes.clienteCiudad = cleanText(rawChanges.clienteCiudad, "La ciudad", 2, 120);
  }
  if ("clienteDireccion" in rawChanges) {
    changes.clienteDireccion = cleanText(rawChanges.clienteDireccion, "La dirección", 5, 240);
  }
  if ("catalogItemId" in rawChanges) {
    if (!Number.isSafeInteger(rawChanges.catalogItemId) || Number(rawChanges.catalogItemId) < 1) {
      throw invalid("Selecciona un equipo válido del catálogo.");
    }
    changes.catalogItemId = Number(rawChanges.catalogItemId);
  }

  return {
    changes,
    reason,
    revision: Number(body.revision),
    reviewHash: body.reviewHash,
    idempotencyKey: body.idempotencyKey.toLowerCase(),
  };
}

export function approvalDataRequestHash(creditoId: number, input: ParsedApprovalDataCorrection) {
  return approvalDataDigest({ creditoId, ...input });
}

export function approvalDataSnapshot(value: unknown): ApprovalDataSnapshot | null {
  const source = record(value);
  const snapshot = {} as ApprovalDataSnapshot;
  for (const field of APPROVAL_DATA_FIELDS) {
    const item = source[field];
    if (item !== null && typeof item !== "string") return null;
    snapshot[field] = item as string | null;
  }
  return snapshot;
}

export function approvalDataChangedFields(before: ApprovalDataSnapshot, after: ApprovalDataSnapshot) {
  return APPROVAL_DATA_FIELDS.flatMap((field) => before[field] === after[field]
    ? []
    : [{ field, before: before[field], after: after[field] }]);
}

export function formatApprovalEquipmentReference(marca: unknown, modelo: unknown) {
  const brand = String(marca ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  const model = String(modelo ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!brand) return model;
  if (!model) return brand;
  const identity = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const brandKey = identity(brand);
  const modelKey = identity(model);
  return modelKey === brandKey || modelKey.startsWith(`${brandKey} `) ? model : `${brand} ${model}`;
}

const CONTRACTUAL_CORRECTION_FIELDS = [
  ["clienteTelefono", "clienteTelefono"],
  ["clienteCorreo", "clienteCorreo"],
  ["clienteDireccion", "clienteDireccion"],
] as const;

function comparable(value: unknown) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Confirms that every operational difference from the signed seal is explained
 * by the ordered, immutable correction ledger. The returned credit remains
 * contractual: callers use the signed values, never the corrected ones.
 */
export function correctionChainBacksOperationalCredit(
  currentCredit: Record<string, unknown>,
  signedTerms: Record<string, unknown>,
  entries: readonly ApprovalDataCorrectionChainEntry[],
) {
  const state = Object.fromEntries(CONTRACTUAL_CORRECTION_FIELDS.map(([field, term]) => [field, signedTerms[term]]));
  let previousResultRevision = 0;
  for (const entry of entries) {
    const before = approvalDataSnapshot(entry.before);
    const after = approvalDataSnapshot(entry.after);
    if (!before || !after) return false;
    if (entry.requestedRevision !== undefined || entry.resultingRevision !== undefined) {
      if (!Number.isSafeInteger(entry.requestedRevision) || !Number.isSafeInteger(entry.resultingRevision)
          || Number(entry.requestedRevision) < previousResultRevision
          || Number(entry.resultingRevision) <= Number(entry.requestedRevision)) return false;
      previousResultRevision = Number(entry.resultingRevision);
    }
    for (const [field] of CONTRACTUAL_CORRECTION_FIELDS) {
      if (comparable(before[field]) !== comparable(state[field])) return false;
      state[field] = after[field];
    }
  }
  return CONTRACTUAL_CORRECTION_FIELDS.every(([field]) => comparable(state[field]) === comparable(currentCredit[field]));
}
