import { createHash } from "node:crypto";
import { correctionRecord, RequestDataCorrectionError } from "./approval-request-correction-core";

export const REQUEST_EVIDENCE_CONFIG = {
  "cedula-frente": { label: "Cédula frontal", field: "contratoCedulaFrenteDataUrl", aliases: ["cedulaFrenteDataUrl"], prefix: "contratoCedulaFrente", identity: true },
  "cedula-posterior": { label: "Cédula posterior", field: "contratoCedulaRespaldoDataUrl", aliases: ["cedulaRespaldoDataUrl"], prefix: "contratoCedulaRespaldo", identity: true },
  "selfie-cedula": { label: "Selfie con cédula", field: "iphoneSelfieCedulaDataUrl", aliases: [], prefix: "iphoneSelfieCedula", identity: true },
  "foto-entrega": { label: "Foto de entrega", field: "fotoEntregaDataUrl", aliases: [], prefix: "fotoEntrega", identity: false },
  "foto-remision": { label: "Remisión", field: "fotoRemisionDataUrl", aliases: [], prefix: "fotoRemision", identity: false },
} as const;
export type RequestEvidenceKey = keyof typeof REQUEST_EVIDENCE_CONFIG;
export const REQUEST_EVIDENCE_SYNC_FIELDS: readonly string[] = Object.values(REQUEST_EVIDENCE_CONFIG)
  .flatMap((config) => [config.field, ...config.aliases, `${config.prefix}CapturedAt`, `${config.prefix}Source`]);
export const REQUEST_EVIDENCE_MAX_DATA_URL_LENGTH = 2_500_000;

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
export function requestEvidenceRevision(payload: Record<string, unknown>) {
  return Number.isSafeInteger(payload.analystEvidenceRevision) && Number(payload.analystEvidenceRevision) >= 0
    ? Number(payload.analystEvidenceRevision) : 0;
}
export function requestEvidenceValue(payload: Record<string, unknown>, key: RequestEvidenceKey) {
  const config = REQUEST_EVIDENCE_CONFIG[key];
  const fields: readonly string[] = key === "selfie-cedula"
    ? [config.field, "contratoSelfieDataUrl", "contratoFotoDataUrl"] : [config.field, ...config.aliases];
  return fields.map((field) => text(payload[field])).find(Boolean) || "";
}
export function requestEvidenceBytes(value: string) {
  const match = value.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  return bytes.length && bytes.toString("base64") === match[2]
    ? { bytes, mime: match[1].toLowerCase().replace("image/jpg", "image/jpeg") } : null;
}
export function requestEvidenceHash(value: string) {
  if (!value) return null;
  return createHash("sha256").update(requestEvidenceBytes(value)?.bytes ?? value).digest("hex");
}
export type RequestEvidenceCorrectionInput = {
  key: RequestEvidenceKey; dataUrl: string; expectedSha256: string | null;
  expectedRevision: number; reason: string;
};
export function parseRequestEvidenceCorrection(value: unknown): RequestEvidenceCorrectionInput {
  const body = correctionRecord(value);
  if (Object.keys(body).some((key) => !["key", "dataUrl", "expectedSha256", "expectedRevision", "reason"].includes(key)) ||
      typeof body.key !== "string" || !Object.hasOwn(REQUEST_EVIDENCE_CONFIG, body.key))
    throw new RequestDataCorrectionError("INVALID_EVIDENCE", "Selecciona una evidencia permitida. El documento firmado se conserva desde FirmaSeguro.", 400);
  if (typeof body.dataUrl !== "string" || !body.dataUrl || body.dataUrl.length > REQUEST_EVIDENCE_MAX_DATA_URL_LENGTH)
    throw new RequestDataCorrectionError("INVALID_FILE", "Adjunta una foto JPG o PNG de hasta 1,8 MB.", 400);
  if (body.expectedSha256 !== null && (typeof body.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedSha256)))
    throw new RequestDataCorrectionError("INVALID_BASELINE", "Actualiza los documentos antes de guardar.", 400);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
    throw new RequestDataCorrectionError("INVALID_REVISION", "Actualiza los documentos antes de guardar.", 400);
  const reason = text(body.reason).normalize("NFKC").replace(/\s+/g, " ");
  if (reason.length < 5 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason))
    throw new RequestDataCorrectionError("INVALID_REASON", "Describe el motivo en 5 a 500 caracteres.", 400);
  return { key: body.key as RequestEvidenceKey, dataUrl: body.dataUrl, expectedSha256: body.expectedSha256 as string | null,
    expectedRevision: Number(body.expectedRevision), reason };
}

export function requestEvidenceEligibility(input: {
  open: boolean; expired: boolean; identityStarted: boolean; signatureStarted: boolean;
  signatureCompleted: boolean; dispatchPending: boolean; correctionPending: boolean;
}) {
  const commonReason = !input.open ? "La solicitud está cerrada. Consulta el expediente de aprobación para gestionar sus evidencias."
    : input.expired ? "La solicitud está vencida. No se pueden modificar sus documentos."
    : input.correctionPending ? "Completa la corrección del contrato y la nueva firma antes de actualizar las evidencias."
    : input.dispatchPending || (input.signatureStarted && !input.signatureCompleted)
      ? "El contrato tiene un envío de firma en curso. Espera su confirmación antes de actualizar los documentos." : null;
  return {
    documents: Object.entries(REQUEST_EVIDENCE_CONFIG).map(([key, config]) => {
      const reason = commonReason || (config.identity && input.identityStarted && !input.signatureCompleted
        ? "La identidad ya está en validación. Usa el flujo de corrección de identidad para cambiar sus evidencias." : null);
      return { key: key as RequestEvidenceKey, label: config.label, editable: reason === null, reason };
    }),
    canManageContract: input.open && !input.expired && (input.signatureStarted || input.correctionPending),
  };
}

/** Call after the real decoder accepts the upload, under the same row lock as the audit. */
export function applyRequestEvidenceCorrection(payload: Record<string, unknown>, input: RequestEvidenceCorrectionInput,
  editableKeys: readonly string[], actorName: string, now = new Date()) {
  const revision = requestEvidenceRevision(payload);
  if (revision !== input.expectedRevision)
    throw new RequestDataCorrectionError("REQUEST_CHANGED", "Otro analista actualizó los documentos. Actualiza y revisa antes de guardar.");
  if (!editableKeys.includes(input.key))
    throw new RequestDataCorrectionError("EVIDENCE_LOCKED", "La evidencia está vinculada a una validación o contrato en curso.");
  const previous = requestEvidenceValue(payload, input.key);
  const previousSha256 = requestEvidenceHash(previous);
  if (previousSha256 !== input.expectedSha256)
    throw new RequestDataCorrectionError("REQUEST_CHANGED", "El asesor actualizó esta evidencia. Actualiza y revisa antes de guardar.");
  const nextSha256 = requestEvidenceHash(input.dataUrl);
  if (previousSha256 === nextSha256)
    throw new RequestDataCorrectionError("NO_CHANGES", "La foto adjunta es igual a la que ya está guardada.", 400);
  const config = REQUEST_EVIDENCE_CONFIG[input.key];
  const changedFields = [config.field, ...config.aliases, `${config.prefix}CapturedAt`, `${config.prefix}Source`];
  const next = { ...payload };
  for (const field of [config.field, ...config.aliases]) next[field] = input.dataUrl;
  next[`${config.prefix}CapturedAt`] = now.toISOString();
  next[`${config.prefix}Source`] = "CORRECCION_ANALISTA_SOLICITUD";
  const correction = correctionRecord(payload.analystEvidenceCorrection);
  const fields = [...new Set([...(Array.isArray(correction.fields) ? correction.fields.filter((field): field is string =>
    typeof field === "string" && REQUEST_EVIDENCE_SYNC_FIELDS.includes(field)) : []), ...changedFields])];
  const fieldRevisions = { ...correctionRecord(correction.fieldRevisions),
    ...Object.fromEntries(changedFields.map((field) => [field, revision + 1])) };
  next.analystEvidenceRevision = revision + 1;
  next.analystEvidenceCorrection = { revision: revision + 1, fields, fieldRevisions,
    updatedAt: now.toISOString(), actorName };
  return { payload: next, revision: revision + 1, previous, previousSha256, nextSha256 };
}

/** Protect only changed evidence groups; never trust browser-authored audit markers. */
export function preserveAnalystEvidenceCorrectionAutosave(stored: Record<string, unknown>, incoming: Record<string, unknown>) {
  const payload = { ...incoming };
  delete payload.analystEvidenceRevision;
  delete payload.analystEvidenceCorrection;
  const revision = requestEvidenceRevision(stored);
  if (!revision) return payload;
  const correction = correctionRecord(stored.analystEvidenceCorrection);
  const fields = Array.isArray(correction.fields) ? correction.fields.filter((field): field is string =>
    typeof field === "string" && REQUEST_EVIDENCE_SYNC_FIELDS.includes(field)) : [];
  for (const field of fields) if (incoming.analystEvidenceRevision !== revision || !Object.hasOwn(payload, field)) {
    if (Object.hasOwn(stored, field)) payload[field] = stored[field];
    else delete payload[field];
  }
  payload.analystEvidenceRevision = revision;
  payload.analystEvidenceCorrection = { ...correction, revision, fields };
  return payload;
}
