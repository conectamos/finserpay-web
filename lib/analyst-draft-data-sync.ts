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
