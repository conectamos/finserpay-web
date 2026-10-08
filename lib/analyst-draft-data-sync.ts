const CLIENT_CORRECTION_FIELDS = [
  "clienteTelefono",
  "clienteCorreo",
  "clienteDireccion",
  "clienteDepartamento",
  "clienteCiudad",
  "clientePrimerNombre",
  "clienteSegundoApellido",
  "clienteFechaNacimiento",
  "clienteNombre",
] as const;

export type AnalystDraftDataField = (typeof CLIENT_CORRECTION_FIELDS)[number];
export type AnalystDraftDataValues = Partial<Record<AnalystDraftDataField, string>>;

export type AnalystDraftDataSnapshot = {
  draftId: number;
  revision: number;
  values: AnalystDraftDataValues;
  fieldRevisions: Partial<Record<AnalystDraftDataField, number>>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function revision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export function readAnalystDraftDataSnapshot(
  draftId: number,
  payload: Record<string, unknown>,
): AnalystDraftDataSnapshot {
  const currentRevision = revision(payload.analystDataRevision);
  const correction = record(payload.analystDataCorrection);
  const values: AnalystDraftDataValues = {};
  const fieldRevisions: AnalystDraftDataSnapshot["fieldRevisions"] = {};
  if (revision(correction.revision) === currentRevision) {
    const fields = Array.isArray(correction.fields) ? correction.fields : [];
    const sourceValues = record(correction.values);
    const sourceRevisions = record(correction.fieldRevisions);
    for (const field of CLIENT_CORRECTION_FIELDS) {
      if (fields.includes(field) && typeof sourceValues[field] === "string") {
        values[field] = sourceValues[field];
        const fieldRevision = revision(sourceRevisions[field]);
        if (fieldRevision > 0 && fieldRevision <= currentRevision) {
          fieldRevisions[field] = fieldRevision;
        }
      }
    }
  }
  return { draftId, revision: currentRevision, values, fieldRevisions };
}

/** Apply each analyst correction once; later advisor edits remain local. */
export function resolveAnalystDraftDataUpdate(
  previous: AnalystDraftDataSnapshot,
  draftId: number,
  payload: Record<string, unknown>,
): { snapshot: AnalystDraftDataSnapshot; values: AnalystDraftDataValues } | null {
  if (previous.draftId !== draftId) return null;
  const next = readAnalystDraftDataSnapshot(draftId, payload);
  if (next.revision <= previous.revision) return null;

  const values: AnalystDraftDataValues = {};
  for (const field of CLIENT_CORRECTION_FIELDS) {
    const value = next.values[field];
    if (value === undefined) continue;
    const fieldRevision = next.fieldRevisions[field];
    if (fieldRevision !== undefined
      ? fieldRevision > previous.revision
      : value !== previous.values[field]) {
      values[field] = value;
    }
  }
  return { snapshot: next, values };
}

const FINANCIAL_CORRECTION_FIELDS = [
  "valorEquipoTotal", "cuotaInicial", "plazoMeses", "frecuenciaPago", "fechaPrimerPago",
  "tasaInteresEa", "fianzaPorcentaje", "fianzaCuotaPorcentaje", "seguroCuotaPorcentaje",
  "metodoCalculo", "calculoVersion", "cuotaExacta", "cuotaComercial", "valorCuota",
  "saldoBaseFinanciado", "montoCreditoTotal",
] as const;
const EVIDENCE_CORRECTION_FIELDS = [
  "contratoCedulaFrenteDataUrl", "contratoCedulaFrenteCapturedAt", "contratoCedulaFrenteSource", "cedulaFrenteDataUrl",
  "contratoCedulaRespaldoDataUrl", "contratoCedulaRespaldoCapturedAt", "contratoCedulaRespaldoSource", "cedulaRespaldoDataUrl",
  "iphoneSelfieCedulaDataUrl", "iphoneSelfieCedulaCapturedAt", "iphoneSelfieCedulaSource",
  "fotoEntregaDataUrl", "fotoEntregaCapturedAt", "fotoEntregaSource",
  "fotoRemisionDataUrl", "fotoRemisionCapturedAt", "fotoRemisionSource",
] as const;

export type AnalystDraftCorrectionSnapshot = {
  draftId: number;
  revision: number;
  values: Record<string, string | number | null>;
  fieldRevisions: Record<string, number>;
};

function readCorrectionSnapshot(draftId: number, payload: Record<string, unknown>,
  domain: "Financial" | "Evidence", evidenceLoaded = false): AnalystDraftCorrectionSnapshot {
  const currentRevision = revision(payload[`analyst${domain}Revision`]);
  const correction = record(payload[`analyst${domain}Correction`]);
  const fields = domain === "Financial" ? FINANCIAL_CORRECTION_FIELDS : EVIDENCE_CORRECTION_FIELDS;
  const values: AnalystDraftCorrectionSnapshot["values"] = {};
  const fieldRevisions: Record<string, number> = {};
  if (revision(correction.revision) === currentRevision) {
    const correctedFields = Array.isArray(correction.fields) ? correction.fields : [];
    // Financial amounts are small enough for the lightweight poll. Evidence bytes
    // stay outside the marker and are loaded only after detecting a new revision.
    const sourceValues = domain === "Financial" ? record(correction.values) : payload;
    const sourceRevisions = record(correction.fieldRevisions);
    for (const field of fields) {
      if (!correctedFields.includes(field)) continue;
      const value = sourceValues[field];
      if (typeof value === "string" || typeof value === "number" && Number.isFinite(value) || value === null) {
        values[field] = value;
      } else if (domain === "Evidence" && evidenceLoaded && !Object.prototype.hasOwnProperty.call(payload, field)) {
        // An authoritative full snapshot can legitimately omit an attachment
        // invalidated by a later identity or financial correction.
        values[field] = null;
      }
      const fieldRevision = revision(sourceRevisions[field]);
      if (fieldRevision > 0 && fieldRevision <= currentRevision) fieldRevisions[field] = fieldRevision;
    }
  }
  return { draftId, revision: currentRevision, values, fieldRevisions };
}

export function readAnalystDraftFinancialSnapshot(draftId: number, payload: Record<string, unknown>) {
  return readCorrectionSnapshot(draftId, payload, "Financial");
}
export function readAnalystDraftEvidenceSnapshot(draftId: number, payload: Record<string, unknown>, evidenceLoaded = false) {
  return readCorrectionSnapshot(draftId, payload, "Evidence", evidenceLoaded);
}

function resolveCorrectionUpdate(previous: AnalystDraftCorrectionSnapshot, draftId: number,
  payload: Record<string, unknown>, domain: "Financial" | "Evidence", evidenceLoaded = false) {
  if (previous.draftId !== draftId) return null;
  const next = readCorrectionSnapshot(draftId, payload, domain, evidenceLoaded);
  if (next.revision <= previous.revision) return null;
  const values: AnalystDraftCorrectionSnapshot["values"] = {};
  for (const [field, fieldRevision] of Object.entries(next.fieldRevisions)) {
    if (fieldRevision <= previous.revision) continue;
    // Never acknowledge a revision whose changed attachment was not loaded.
    if (!Object.prototype.hasOwnProperty.call(next.values, field)) return null;
    values[field] = next.values[field];
  }
  if (!Object.keys(next.fieldRevisions).length) {
    for (const [field, value] of Object.entries(next.values)) {
      if (value !== previous.values[field]) values[field] = value;
    }
  }
  return { snapshot: next, values };
}

export function resolveAnalystDraftFinancialUpdate(previous: AnalystDraftCorrectionSnapshot, draftId: number,
  payload: Record<string, unknown>) {
  return resolveCorrectionUpdate(previous, draftId, payload, "Financial");
}
export function resolveAnalystDraftEvidenceUpdate(previous: AnalystDraftCorrectionSnapshot, draftId: number,
  payload: Record<string, unknown>, evidenceLoaded = false) {
  return resolveCorrectionUpdate(previous, draftId, payload, "Evidence", evidenceLoaded);
}

export function hasPendingAnalystDraftEvidence(previous: AnalystDraftCorrectionSnapshot,
  draftId: number, payload: Record<string, unknown>) {
  return previous.draftId === draftId &&
    readAnalystDraftEvidenceSnapshot(draftId, payload).revision > previous.revision;
}

/** Poll only visible screens, never overlap requests, and discard late responses. */
export function startVisibleDraftDataPolling<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  apply: (data: T) => void;
  isVisible: () => boolean;
  schedule: (callback: () => void, delay: number) => unknown;
  cancel: (timer: unknown) => void;
  intervalMs?: number;
}) {
  let stopped = false;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  const clearTimer = () => {
    if (timer !== null) options.cancel(timer);
    timer = null;
  };
  const refresh = async () => {
    if (stopped) return;
    if (!options.isVisible()) {
      clearTimer();
      controller?.abort();
      return;
    }
    if (controller) return;
    clearTimer();
    const request = new AbortController();
    controller = request;
    try {
      const data = await options.load(request.signal);
      if (!stopped && !request.signal.aborted && options.isVisible()) {
        options.apply(data);
      }
    } catch {
      // A transient read failure leaves the advisor's work intact; retry later.
    } finally {
      if (controller === request) controller = null;
      if (!stopped && options.isVisible()) {
        timer = options.schedule(() => { void refresh(); }, options.intervalMs ?? 5_000);
      }
    }
  };
  void refresh();
  return {
    refresh: () => { void refresh(); },
    stop: () => {
      stopped = true;
      clearTimer();
      controller?.abort();
    },
  };
}
