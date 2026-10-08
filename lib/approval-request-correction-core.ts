import { composeCreditClientName } from "./credit-client-name";
import { normalizeCreditContactPhoneInput } from "./credit-contact-phones";

export const REQUEST_CONTACT_FIELDS = [
  "clienteTelefono", "clienteCorreo", "clienteDireccion", "clienteDepartamento", "clienteCiudad",
] as const;
export const REQUEST_IDENTITY_FIELDS = [
  "clientePrimerNombre", "clienteSegundoApellido", "clienteFechaNacimiento",
] as const;
export const REQUEST_CORRECTION_FIELDS = [...REQUEST_CONTACT_FIELDS, ...REQUEST_IDENTITY_FIELDS] as const;
const syncFields = new Set<string>([...REQUEST_CORRECTION_FIELDS, "clienteNombre"]);
export const CLIENT_CORRECTION_MARKER_FIELDS = [
  "firmaSeguroClientCorrectionPending", "firmaSeguroClientCorrectionId",
  "firmaSeguroClientCorrectionSourceProcessUuid", "firmaSeguroClientCorrectionSourceChecksum",
  "firmaSeguroClientCorrectionSourceSigned", "firmaSeguroClientCorrectionIntentSha256",
  "firmaSeguroClientCorrectionReissuedAt", "firmaSeguroClientCorrectionReissueProcessUuid",
] as const;
const identityEvidenceFields = [
  "contratoFotoDataUrl", "contratoFotoCapturedAt", "contratoFotoSource",
  "iphoneSelfieCedulaDataUrl", "iphoneSelfieCedulaCapturedAt", "iphoneSelfieCedulaSource",
  "contratoCedulaFrenteDataUrl", "contratoCedulaFrenteCapturedAt", "contratoCedulaFrenteSource",
  "contratoCedulaRespaldoDataUrl", "contratoCedulaRespaldoCapturedAt", "contratoCedulaRespaldoSource",
  "cedulaFrenteDataUrl", "cedulaRespaldoDataUrl", "contratoSelfieDataUrl",
] as const;

export class RequestDataCorrectionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "RequestDataCorrectionError";
  }
}

export function correctionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
export function requestDataRevision(payload: Record<string, unknown>) {
  return Number.isSafeInteger(payload.analystDataRevision) && Number(payload.analystDataRevision) >= 0
    ? Number(payload.analystDataRevision) : 0;
}
export function requestDataValues(payload: Record<string, unknown>) {
  return Object.fromEntries([...REQUEST_CORRECTION_FIELDS, "clientePrimerApellido", "clienteNombre", "clienteDocumento"]
    .map((field) => [field, text(payload[field])]));
}

export function requestDataEligibility(input: {
  open: boolean; expired: boolean; signatureStarted: boolean; identityStarted: boolean;
  correctionPending: boolean; dispatchPending?: boolean;
}) {
  const reason = !input.open ? "La solicitud está cerrada. No se pueden corregir sus datos."
    : input.expired ? "La solicitud está vencida. No se pueden corregir sus datos."
    : input.dispatchPending ? "Hay un envío de firma en curso o pendiente de conciliación. Consulta su estado antes de corregir los datos."
    : input.correctionPending
      ? "Hay una corrección contractual en curso. Termínala desde Gestionar firma antes de cambiar los datos."
      : null;
  return {
    editableFields: reason ? [] : [...REQUEST_CORRECTION_FIELDS],
    reason,
    identityReason: null,
    requiresNewSignature: !reason && input.signatureStarted,
    signatureNotice: !reason && input.signatureStarted
      ? "Al guardar se archivará la firma anterior y se enviará una nueva con los datos corregidos. Las condiciones financieras se conservarán."
      : null,
    canManageContract: input.open && !input.expired && (input.signatureStarted || input.correctionPending),
  };
}

export type RequestDataCorrectionInput = {
  values: Record<string, unknown>; expectedValues: Record<string, unknown>;
  expectedRevision: number; reason: string;
  expectedProcessUuid?: string | null; idempotencyKey?: string; confirmed?: boolean;
};

export function parseRequestDataCorrection(value: unknown): RequestDataCorrectionInput {
  const body = correctionRecord(value);
  if (Object.keys(body).some((key) => !["values", "expectedValues", "expectedRevision", "reason",
    "expectedProcessUuid", "idempotencyKey", "confirmed"].includes(key)))
    throw new RequestDataCorrectionError("INVALID_FIELDS", "La solicitud contiene campos no permitidos.", 400);
  const values = correctionRecord(body.values);
  const expectedValues = correctionRecord(body.expectedValues);
  if (!Object.keys(values).length || Object.keys(values).some((field) =>
    !(REQUEST_CORRECTION_FIELDS as readonly string[]).includes(field)) ||
      Object.keys(values).some((field) => typeof values[field] !== "string" || typeof expectedValues[field] !== "string"))
    throw new RequestDataCorrectionError("INVALID_FIELDS", "Selecciona datos del cliente permitidos para corregir.", 400);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
    throw new RequestDataCorrectionError("INVALID_REVISION", "Actualiza la solicitud antes de corregir sus datos.", 400);
  const reason = text(body.reason).normalize("NFKC").replace(/\s+/g, " ");
  if (reason.length < 5 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason))
    throw new RequestDataCorrectionError("INVALID_REASON", "Describe el motivo en 5 a 500 caracteres.", 400);
  if (body.expectedProcessUuid !== undefined && body.expectedProcessUuid !== null &&
    (typeof body.expectedProcessUuid !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(body.expectedProcessUuid)))
    throw new RequestDataCorrectionError("INVALID_PROCESS", "Actualiza el estado de la firma antes de corregir.", 400);
  if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotencyKey)))
    throw new RequestDataCorrectionError("INVALID_OPERATION", "Actualiza la solicitud antes de confirmar.", 400);
  if (body.confirmed !== undefined && typeof body.confirmed !== "boolean")
    throw new RequestDataCorrectionError("INVALID_CONFIRMATION", "Confirma el envío de la nueva firma.", 400);
  return { values, expectedValues, expectedRevision: Number(body.expectedRevision), reason,
    ...(body.expectedProcessUuid !== undefined ? { expectedProcessUuid: body.expectedProcessUuid as string | null } : {}),
    ...(typeof body.idempotencyKey === "string" ? { idempotencyKey: body.idempotencyKey.toLowerCase() } : {}),
    ...(typeof body.confirmed === "boolean" ? { confirmed: body.confirmed } : {}) };
}

function validateField(field: string, raw: unknown, payload: Record<string, unknown>, now: Date) {
  const value = text(raw).normalize("NFKC").replace(/\s+/g, " ");
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new RequestDataCorrectionError("INVALID_VALUE", "El dato contiene caracteres no permitidos.", 400);
  if (field === "clienteTelefono") {
    const phone = normalizeCreditContactPhoneInput(value);
    if (!/^3\d{9}$/.test(phone) || !/^[+\d ()-]+$/.test(value))
      throw new RequestDataCorrectionError("INVALID_PHONE", "Ingresa un celular colombiano válido de 10 dígitos.", 400);
    if ([payload.referenciaFamiliar1Telefono, payload.referenciaFamiliar2Telefono]
      .some((reference) => normalizeCreditContactPhoneInput(reference) === phone))
      throw new RequestDataCorrectionError("CONTACT_PHONE_DUPLICATE", "El celular debe ser diferente al de las referencias familiares.", 400);
    return phone;
  }
  if (field === "clienteCorreo") {
    if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      throw new RequestDataCorrectionError("INVALID_EMAIL", "Ingresa un correo electrónico válido.", 400);
    return value.toLowerCase();
  }
  if (field === "clientePrimerNombre" || field === "clienteSegundoApellido") {
    if (field === "clienteSegundoApellido" && !value) return "";
    if (value.length < 2 || value.length > 90 || !/^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u.test(value))
      throw new RequestDataCorrectionError("INVALID_NAME", "Ingresa nombres y apellidos válidos.", 400);
    return value.toLocaleUpperCase("es-CO");
  }
  if (field === "clienteFechaNacimiento") {
    const date = new Date(`${value}T00:00:00Z`);
    const issueDate = text(payload.clienteFechaExpedicion).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value || value < "1900-01-01" ||
      value > now.toISOString().slice(0, 10) || (issueDate && value > issueDate))
      throw new RequestDataCorrectionError("INVALID_BIRTHDATE", "Ingresa una fecha de nacimiento válida y anterior a la expedición del documento.", 400);
    return value;
  }
  const max = field === "clienteDireccion" ? 240 : 100;
  if (value.length < (field === "clienteDireccion" ? 5 : 2) || value.length > max)
    throw new RequestDataCorrectionError("INVALID_LOCATION", "Ingresa una dirección, departamento o ciudad válidos.", 400);
  return value;
}

/** Optimistic checks use only edited fields, so unrelated advisor work remains intact. */
export function applyRequestDataCorrection(payload: Record<string, unknown>, input: RequestDataCorrectionInput,
  editableFields: readonly string[], actorName: string, now = new Date(),
  options: { preserveIdentityEvidence?: boolean } = {}) {
  const revision = requestDataRevision(payload);
  if (input.expectedRevision !== revision)
    throw new RequestDataCorrectionError("REQUEST_CHANGED", "Otro analista corrigió la solicitud. Actualiza y revisa los datos antes de guardar.");
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const [field, raw] of Object.entries(input.values)) {
    if (text(raw) === text(input.expectedValues[field])) continue;
    if (!editableFields.includes(field))
      throw new RequestDataCorrectionError("FIELD_LOCKED", "Estos datos ya están vinculados a una validación o contrato. Usa el flujo de corrección correspondiente.");
    if (text(payload[field]) !== text(input.expectedValues[field]))
      throw new RequestDataCorrectionError("REQUEST_CHANGED", "El asesor actualizó uno de los datos que estás corrigiendo. Actualiza y revisa la solicitud antes de guardar.");
    const value = validateField(field, raw, payload, now);
    if (value === text(payload[field])) continue;
    before[field] = text(payload[field]);
    after[field] = value;
  }
  if (!Object.keys(after).length)
    throw new RequestDataCorrectionError("NO_CHANGES", "Modifica al menos un dato antes de guardar.", 400);
  const next = { ...payload, ...after };
  if (Object.keys(after).some((field) => (REQUEST_IDENTITY_FIELDS as readonly string[]).includes(field) && field !== "clienteFechaNacimiento")) {
    before.clienteNombre = text(payload.clienteNombre);
    after.clienteNombre = composeCreditClientName({ firstNames: text(next.clientePrimerNombre),
      firstSurname: text(next.clientePrimerApellido), secondSurname: text(next.clienteSegundoApellido) });
    next.clienteNombre = after.clienteNombre;
  }
  const previous = correctionRecord(payload.analystDataCorrection);
  const identityChanged = Object.keys(after).some((field) =>
    (REQUEST_IDENTITY_FIELDS as readonly string[]).includes(field));
  const invalidatedFields = [...new Set([
    ...(Array.isArray(previous.invalidatedFields) ? previous.invalidatedFields.filter((field) =>
      typeof field === "string" && (identityEvidenceFields as readonly string[]).includes(field)) as string[] : []),
    ...(identityChanged && !options.preserveIdentityEvidence ? identityEvidenceFields : []),
  ])];
  if (identityChanged && !options.preserveIdentityEvidence) for (const field of identityEvidenceFields) delete next[field];
  const fields = [...new Set([...(Array.isArray(previous.fields) ? previous.fields.filter((field) =>
    typeof field === "string" && syncFields.has(field)) as string[] : []), ...Object.keys(after)])];
  const fieldRevisions = { ...correctionRecord(previous.fieldRevisions),
    ...Object.fromEntries(Object.keys(after).map((field) => [field, revision + 1])) };
  next.analystDataRevision = revision + 1;
  next.analystDataCorrection = { revision: revision + 1, fields, fieldRevisions, invalidatedFields,
    preserveIdentityEvidence: options.preserveIdentityEvidence === true,
    values: Object.fromEntries(fields.map((field) => [field, text(next[field])])),
    updatedAt: now.toISOString(), actorName };
  return { payload: next, before, after, revision: revision + 1 };
}

/** Browser autosaves cannot remove or manufacture the server's correction marker. */
export function preserveAnalystDataCorrectionAutosave(stored: Record<string, unknown>, incoming: Record<string, unknown>) {
  const payload = { ...incoming };
  delete payload.analystDataRevision;
  delete payload.analystDataCorrection;
  // Only the nominal analyst dispatch and verified completion can create these markers.
  for (const field of CLIENT_CORRECTION_MARKER_FIELDS) {
    delete payload[field];
    if (Object.hasOwn(stored, field)) payload[field] = stored[field];
  }
  const contractCorrected = stored.firmaSeguroClientCorrectionPending === true ||
    typeof stored.firmaSeguroClientCorrectionReissueProcessUuid === "string";
  // The advisor factory omits the seal and derives some amounts from its
  // current policy. Keep the corrected contract authoritative even after its
  // new signature, including intentionally absent optional snapshot fields.
  const contractFields = [...REQUEST_CORRECTION_FIELDS,
    "clienteTipoDocumento", "clienteNombre", "clientePrimerApellido", "clienteDocumento",
    "dataCreditoAssessmentId", "financialTermsSeal", "firmaSeguroDraftFolio",
    "equipoCatalogoId", "equipoMarca", "equipoModelo", "referenciaEquipo",
    "imei", "deviceUid", "plataformaDispositivo", "valorEquipoTotal", "cuotaInicial",
    "plazoMeses", "frecuenciaPago", "fechaPrimerPago", "montoCredito", "valorCuota",
    "valorCuotaComercial", "calculoVersion", "cuotaTotalExacta", "descuentoRedondeo",
    "tasaInteresEa", "tasaPeriodo", "fianzaCuotaPorcentaje", "fianzaTotalPorcentaje",
    "fianzaModalidad", "seguroCuotaPorcentaje", "redondeoComercialModo",
    "redondeoComercialMultiplo", "valorFianza", "valorSeguro", "fianzaPorcentaje",
    "metodoCalculo", "cuotaExacta", "cuotaComercial", "saldoBaseFinanciado", "montoCreditoTotal",
  ] as const;
  if (contractCorrected) {
    for (const field of contractFields) {
      if (Object.hasOwn(stored, field)) payload[field] = stored[field];
      else delete payload[field];
    }
    // A normal factory autosave can omit evidence while rebuilding its local
    // state. Keep those existing files; explicit replacements still use the
    // ordinary evidence correction and audit protections.
    for (const field of [...identityEvidenceFields,
      "fotoEntregaDataUrl", "fotoEntregaCapturedAt", "fotoEntregaSource",
      "fotoRemisionDataUrl", "fotoRemisionCapturedAt", "fotoRemisionSource",
    ] as const) {
      if (!Object.hasOwn(incoming, field) && Object.hasOwn(stored, field)) payload[field] = stored[field];
    }
  }
  const revision = requestDataRevision(stored);
  if (!revision) return payload;
  const correction = correctionRecord(stored.analystDataCorrection);
  const fields = Array.isArray(correction.fields) ? correction.fields.filter((field): field is string =>
    typeof field === "string" && syncFields.has(field)) : [];
  const acknowledged = incoming.analystDataRevision === revision;
  for (const field of fields) {
    if (!acknowledged || !Object.prototype.hasOwnProperty.call(payload, field)) payload[field] = stored[field];
  }
  if (!acknowledged && Array.isArray(correction.invalidatedFields)) {
    for (const field of correction.invalidatedFields) {
      if (typeof field !== "string" || !(identityEvidenceFields as readonly string[]).includes(field)) continue;
      if (Object.prototype.hasOwnProperty.call(stored, field)) payload[field] = stored[field];
      else delete payload[field];
    }
  }
  payload.analystDataRevision = revision;
  payload.analystDataCorrection = { ...correction, revision, fields,
    values: Object.fromEntries(fields.map((field) => [field, text(payload[field])])) };
  return payload;
}
