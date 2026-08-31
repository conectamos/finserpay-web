export const DELIVERY_EVIDENCE_DRAFT_FIELDS = [
  "contratoCedulaFrenteDataUrl",
  "contratoCedulaFrenteCapturedAt",
  "contratoCedulaFrenteSource",
  "contratoCedulaRespaldoDataUrl",
  "contratoCedulaRespaldoCapturedAt",
  "contratoCedulaRespaldoSource",
  "iphoneSelfieCedulaDataUrl",
  "iphoneSelfieCedulaCapturedAt",
  "iphoneSelfieCedulaSource",
  "fotoEntregaDataUrl",
  "fotoEntregaCapturedAt",
  "fotoEntregaSource",
  "fotoRemisionDataUrl",
  "fotoRemisionCapturedAt",
  "fotoRemisionSource",
] as const;

export function mergeDeliveryEvidenceDraftPayload(
  storedPayload: Record<string, unknown>,
  incomingPayload: Record<string, unknown>
) {
  const merged: Record<string, unknown> = { ...storedPayload };

  for (const field of DELIVERY_EVIDENCE_DRAFT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(incomingPayload, field)) {
      merged[field] = incomingPayload[field];
    }
  }

  return merged;
}

export function isOmittedSignedDraftAutosaveValue(value: unknown) {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  );
}
