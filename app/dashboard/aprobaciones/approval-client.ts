export type ApprovalView = "pending" | "approved";

export type ApprovalStatus = "PENDING" | "APPROVED" | "NOT_REQUIRED";

export type ApprovalListItem = {
  id: number;
  folio: string;
  clienteDocumento: string | null;
  clienteNombre: string;
  aliadoNombre: string;
  fechaCredito: string | null;
  status: ApprovalStatus;
  required: boolean;
};

export type ApprovalQueueItem = ApprovalListItem & {
  createdAt?: string; sedeNombre?: string; revision?: number;
  approvedAt?: string; approvedByName?: string | null; paid?: boolean;
  novelty?: { id: string; status: "WAITING_ALLY" | "RESPONDED"; version: number; pendingCount: number; answeredCount: number } | null;
  reissue?: { blocked: boolean; status: string | null };
};
export type ApprovalNoveltyItem = {
  id: string; key: string; label: string; status: "OPEN" | "RESPONDED"; version: number;
  reason: string; openedAt: string; respondedAt: string | null; responseText: string | null;
};
export type ApprovalNoveltyState = {
  available: boolean; blocksApproval: boolean; blocksSettlement: boolean; pendingCount: number; answeredCount: number;
  novelty: null | { id: string; status: "WAITING_ALLY" | "RESPONDED" | "RESOLVED"; version: number; items: ApprovalNoveltyItem[] };
};
export type ApprovalQueueCounts = { pending: number; approved: number };
export type ApprovalQueuePage = { items: ApprovalQueueItem[]; nextCursor: string | null; hasMore: boolean; counts?: ApprovalQueueCounts };

export type ApprovalReissueState = {
  available: boolean; blocked: boolean;
  operation: null | { id: string; status: string; reason: string; requestedAt: string; lastCheckedAt: string | null; completedAt: string | null; canRefresh: boolean; message: string };
};

export type ApprovalCallRecordingState = {
  available: boolean; required: boolean; canUpload: boolean; blockedReason: string | null;
  recording: null | { id: string; revision: number; reviewHash: string; fileName: string; mimeType: string;
    sizeBytes: number; createdAt: string; actorName: string; href: string; sha256: string };
};

export type ApprovalDetail = Omit<ApprovalListItem, "status" | "required"> & {
  clienteCorreo: string | null;
  clienteTelefono: string | null;
  referenciaEquipo: string | null;
  numeroCuotas: number | null;
  frecuenciaPago: string | null;
  valorCuota: number | null;
  fechaPrimerPago: string | null;
  score: number | null;
  scoreLabel?: string | null;
  initialPaymentPercentage: number | null;
  cuotaInicial: number;
  creditoAutorizado: number;
  approvedLimit: number | null;
  valorVenta: number;
  review: {
    required: boolean;
    status: ApprovalStatus;
    revision: number;
    reviewHash: string;
    approvedAt: string | null;
    approvedByName: string | null;
  };
  capabilities: { canCreateNovelty: boolean; canCorrectEvidence: boolean; canReissueSignature: boolean; correctionBlockedReason: string | null };
  reissue: ApprovalReissueState;
  novelties: ApprovalNoveltyState;
  callRecording: ApprovalCallRecordingState;
  canApprove: boolean;
  blockingReasons: string[];
  evidence: Array<{ key: string; label: string; available: boolean; href: string }>;
  document: { processUuid: string | null; available: boolean; href: string; fileName: string | null };
};

export class ApprovalRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApprovalRequestError";
    this.status = status;
  }
}

async function readResult<T>(response: Response, fallback: string): Promise<T> {
  let result: T & { ok?: boolean; error?: string };
  try {
    result = await response.json();
  } catch {
    throw new ApprovalRequestError(fallback, response.status);
  }
  if (!response.ok || !result || result.ok === false) {
    throw new ApprovalRequestError(result?.error || fallback, response.status);
  }
  return result;
}

export async function searchApprovalCredits(documento: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ documento });
  const response = await fetch(`/api/aprobaciones?${query}`, { cache: "no-store", signal });
  const result = await readResult<{ items: ApprovalListItem[] }>(response, "No fue posible buscar los créditos.");
  if (!Array.isArray(result.items)) throw new ApprovalRequestError("La búsqueda no devolvió una respuesta válida.", response.status);
  return result.items;
}

export async function readApprovalCredit(id: number, signal?: AbortSignal) {
  const response = await fetch(`/api/aprobaciones/${id}`, { cache: "no-store", signal });
  const result = await readResult<{ item: ApprovalDetail }>(response, "No fue posible cargar el expediente.");
  if (!result.item || result.item.id !== id) throw new ApprovalRequestError("El expediente recibido no corresponde al crédito seleccionado.", response.status);
  return result.item;
}

export async function approveCreditReview(id: number, revision: number, reviewHash: string, recordingId?: string | null) {
  const response = await fetch(`/api/aprobaciones/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, reviewHash, ...(recordingId ? { recordingId } : {}) }),
  });
  const result = await readResult<{ ok?: boolean }>(response, "No fue posible confirmar la aprobación. Actualiza el expediente antes de intentarlo de nuevo.");
  if (result.ok !== true) throw new ApprovalRequestError("No se recibió confirmación de la aprobación. Actualiza el expediente antes de intentarlo de nuevo.", response.status);
  return result;
}


async function sendSignatureAction(id: number, payload: Record<string, unknown>) {
  const response = await fetch(`/api/aprobaciones/${id}/firma-seguro`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const result = await readResult<{ ok?: boolean }>(response, "No se pudo confirmar la operación de firma. Actualiza el expediente antes de intentarlo nuevamente.");
  if (result.ok !== true) throw new ApprovalRequestError("No se recibió confirmación de la operación. Actualiza el expediente.", response.status);
  return result;
}
export function requestApprovalSignature(id: number, input: { expectedRevision: number; expectedProcessUuid: string; reason: string; idempotencyKey: string }) {
  return sendSignatureAction(id, { action: "REQUEST", ...input });
}
export function refreshApprovalSignature(id: number, operationId: string) {
  return sendSignatureAction(id, { action: "REFRESH", operationId });
}

export async function readApprovalQueue(cursor?: string | null, signal?: AbortSignal, view: ApprovalView = "pending", options: { query?: string; counts?: boolean } = {}) {
  const query = new URLSearchParams({ view });
  if (options.query?.trim()) query.set("q", options.query.trim());
  if (options.counts) query.set("counts", "1");
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/aprobaciones?${query}`, { cache: "no-store", signal });
  const result = await readResult<ApprovalQueuePage>(response, "No fue posible cargar los créditos.");
  if (!Array.isArray(result.items) || result.items.some((item) => !Number.isSafeInteger(item.id) || item.id <= 0 || item.status !== (view === "approved" ? "APPROVED" : "PENDING") || item.required !== true) ||
      !(result.nextCursor === null || typeof result.nextCursor === "string" && result.nextCursor.length > 0) ||
      typeof result.hasMore !== "boolean" || result.hasMore !== Boolean(result.nextCursor)) {
    throw new ApprovalRequestError("El muro no devolvió una respuesta válida. Actualiza antes de continuar.", response.status);
  }
  if (options.counts && (!result.counts || !Number.isSafeInteger(result.counts.pending) || result.counts.pending < 0 || !Number.isSafeInteger(result.counts.approved) || result.counts.approved < 0)) {
    throw new ApprovalRequestError("No fue posible verificar los contadores. Actualiza el muro.", response.status);
  }
  return result;
}

export function mergeApprovalQueuePage(current: ApprovalQueueItem[], incoming: ApprovalQueueItem[], append: boolean, view: ApprovalView = "pending") {
  const rows = new Map<number, ApprovalQueueItem>();
  for (const item of append ? [...current, ...incoming] : incoming) {
    if (item.required && item.status === (view === "approved" ? "APPROVED" : "PENDING")) rows.set(item.id, item);
  }
  return [...rows.values()];
}

export async function createApprovalNovelty(id: number, input: { keys: string[]; reason: string; revision: number; reviewHash: string; idempotencyKey: string }) {
  const response = await fetch(`/api/aprobaciones/${id}/novedades`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const result = await readResult<{ ok?: boolean }>(response, "No se pudo confirmar la novedad. Actualiza el expediente antes de volver a intentarlo.");
  if (result.ok !== true) throw new ApprovalRequestError("No se recibió confirmación de la novedad. Actualiza el expediente.", response.status);
  return result;
}

export async function uploadApprovalCallRecording(id: number, input: {
  file: File; revision: number; reviewHash: string; idempotencyKey: string;
}) {
  const response = await fetch(`/api/aprobaciones/${id}/grabaciones`, {
    method: "POST", headers: {
      "Content-Type": "application/octet-stream",
      "x-recording-file-name": encodeURIComponent(input.file.name),
      "x-review-revision": String(input.revision), "x-review-hash": input.reviewHash,
      "idempotency-key": input.idempotencyKey,
    }, body: input.file,
  });
  const result = await readResult<{ ok: boolean; state: ApprovalCallRecordingState; unchanged: boolean }>(response,
    "No se pudo confirmar la carga de la grabación. Actualiza el expediente antes de reintentar.");
  if (result.ok !== true || !result.state?.recording?.id) throw new ApprovalRequestError("No se recibió confirmación de la grabación. Actualiza el expediente.", response.status);
  return result;
}

export type ApprovalNoveltyHistoryEvent = { id: string; type: string; actorKind: "USER" | "SHARED_LINK"; actorName: string; createdAt: string; payload: Record<string, unknown> };
export async function readApprovalNoveltyHistory(id: number, signal?: AbortSignal) {
  const response = await fetch(`/api/aprobaciones/${id}/novedades`, { cache: "no-store", signal });
  const result = await readResult<{ history: ApprovalNoveltyHistoryEvent[] }>(response, "No fue posible consultar el historial de novedades.");
  if (!Array.isArray(result.history) || result.history.some(event => !event || typeof event.id !== "string" || typeof event.type !== "string" || typeof event.actorName !== "string" || !["USER", "SHARED_LINK"].includes(event.actorKind) || !Number.isFinite(new Date(event.createdAt).getTime()) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload))) {
    throw new ApprovalRequestError("El historial no devolvió una respuesta válida.", response.status);
  }
  return result.history;
}
