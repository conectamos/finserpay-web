export const CREDIT_PROCESS_STATUS_INTERVAL_MS = 5_000;

export type CreditProcessStatusBinding = {
  draftId: number;
  validationId?: number | null;
  processUuid?: string | null;
};

export type CreditProcessStatusSnapshot<Validation = unknown, Process = unknown> = {
  ok: true;
  draftId: number;
  revision: {
    draftUpdatedAt: string | null;
    processId: number | null;
    processUpdatedAt: string | null;
    validationId: number | null;
    validationUpdatedAt: string | null;
  };
  validation: Validation | null;
  process: Process | null;
  retryPolicy: {
    applicationRejected: boolean;
    declinedAttempts: number;
    maxAttempts: number;
    remainingAttempts: number;
    retryAllowed: boolean;
  };
  pending: boolean;
  identityCorrectionPending: boolean;
  imeiCorrectionPending: boolean;
  financialCorrectionPending: boolean;
};

export type CreditProcessConnection = "idle" | "checking" | "connected" | "reconnecting";

/** One read at a time; a discarded screen can never receive its late response. */
export function createCreditProcessStatusPoller<Snapshot extends CreditProcessStatusSnapshot>(options: {
  binding: CreditProcessStatusBinding;
  read: (binding: CreditProcessStatusBinding, signal: AbortSignal) => Promise<Snapshot>;
  canRead: () => boolean;
  isPending: () => boolean;
  onSnapshot: (snapshot: Snapshot) => void;
  onConnection: (connection: CreditProcessConnection, error: string | null) => void;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flight: { controller: AbortController; generation: number } | null = null;
  let confirmed = false;
  let serverPending: boolean | null = null;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const scheduleNext = () => {
    clearTimer();
    if (disposed || !options.canRead() || !options.isPending() || serverPending === false) return;
    timer = schedule(() => { timer = null; void read(); }, CREDIT_PROCESS_STATUS_INTERVAL_MS);
  };
  const read = async () => {
    clearTimer();
    if (disposed || flight) return;
    if (!options.canRead()) {
      options.onConnection("reconnecting", "No hay conexión. Reintentaremos cuando regreses.");
      return;
    }
    const current = { controller: new AbortController(), generation: ++generation };
    flight = current;
    if (!confirmed) options.onConnection("checking", null);
    try {
      const snapshot = await options.read(options.binding, current.controller.signal);
      if (disposed || current.generation !== generation || current.controller.signal.aborted) return;
      if (!snapshot.ok || snapshot.draftId !== options.binding.draftId) {
        throw new Error("La respuesta no corresponde a la solicitud vigente.");
      }
      serverPending = snapshot.pending;
      confirmed = true;
      options.onSnapshot(snapshot);
      options.onConnection("connected", null);
    } catch (error) {
      if (disposed || current.generation !== generation || current.controller.signal.aborted) return;
      options.onConnection("reconnecting", error instanceof Error ? error.message : "No se pudo consultar el estado.");
    } finally {
      if (flight === current) flight = null;
      if (!disposed && current.generation === generation) scheduleNext();
    }
  };
  const pause = () => {
    clearTimer();
    generation += 1;
    flight?.controller.abort();
    flight = null;
    if (!disposed) options.onConnection("idle", null);
  };

  return {
    start: read,
    retry: read,
    pause,
    dispose() {
      disposed = true;
      pause();
    },
  };
}
