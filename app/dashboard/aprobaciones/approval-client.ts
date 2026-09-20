export type ApprovalView = "pending" | "approved";

export type ApprovalStatus = "PENDING" | "APPROVED" | "NOT_REQUIRED";

export type ApprovalListItem = {
  id: number;
  folio: string;
  numeroCreditoVisible?: string | null;
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
  id: string; key: string; label: string; status: "OPEN" | "RESPONDED" | "VERIFIED"; version: number;
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
  clienteDepartamento: string | null;
  clienteDepartamentoCodigo: string | null;
  clienteCiudad: string | null;
  clienteDireccion: string | null;
  referenciaEquipo: string | null;
  plataforma: string | null;
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
  capabilities: { canCreateNovelty: boolean; canCorrectEvidence: boolean; canReissueSignature: boolean; canEditData: boolean; correctionBlockedReason: string | null; dataCorrectionBlockedReason: string | null };
  reissue: ApprovalReissueState;
  novelties: ApprovalNoveltyState;
  callRecording: ApprovalCallRecordingState;
  canApprove: boolean;
  blockingReasons: string[];
  evidence: Array<{ key: string; label: string; available: boolean; href: string }>;
  document: { processUuid: string | null; available: boolean; href: string; fileName: string | null };
};

export type ApprovalDataChanges = Partial<{
  clienteCorreo: string;
  clienteTelefono: string;
  clienteDepartamento: string;
  clienteCiudad: string;
  clienteDireccion: string;
  catalogItemId: number;
}>;

export type ApprovalEditableData = {
  clienteNombre: string;
  clienteDocumento: string | null;
  clienteCorreo: string | null;
  clienteTelefono: string | null;
  clienteDepartamento: string | null;
  clienteDepartamentoLabel: string | null;
  clienteCiudad: string | null;
  clienteDireccion: string | null;
  referenciaEquipo: string | null;
  plataforma: string | null;
  review: { revision: number; reviewHash: string };
  capabilities: { canEditData: boolean; correctionBlockedReason: string | null };
};

export type ApprovalEquipmentCatalogItem = {
  id: number;
  marca: string;
  modelo: string;
  referenciaEquipo: string;
  plataforma: string;
};

export type ApprovalDataHistoryField =
  | "clienteCorreo"
  | "clienteTelefono"
  | "clienteDepartamento"
  | "clienteCiudad"
  | "clienteDireccion"
  | "referenciaEquipo";

export type ApprovalDataHistoryEvent = {
  id: string;
  changes: Array<{ field: ApprovalDataHistoryField; before: string | null; after: string | null }>;
  reason: string;
  actorName: string;
  actorKind: "USER" | "SHARED_LINK";
  createdAt: string;
};

export type ApprovalDataResponse = {
  item: ApprovalEditableData;
  history: ApprovalDataHistoryEvent[];
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

export type VerifyApprovalNoveltyInput = {
  noveltyId: string;
  itemId: string;
  expectedVersion: number;
  revision: number;
  reviewHash: string;
  note: string;
  idempotencyKey: string;
};

export async function verifyApprovalNovelty(id: number, input: VerifyApprovalNoveltyInput) {
  const response = await fetch(`/api/aprobaciones/${id}/novedades`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const result = await readResult<{ ok?: boolean; unchanged?: boolean }>(response,
    "No se pudo confirmar que la novedad quedó solucionada. Actualiza el expediente antes de volver a intentarlo.");
  if (result.ok !== true || typeof result.unchanged !== "boolean") {
    throw new ApprovalRequestError("No se recibió confirmación de la novedad solucionada. Actualiza el expediente.", response.status);
  }
  return { ok: true as const, unchanged: result.unchanged };
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

const APPROVAL_DATA_HISTORY_FIELDS = new Set<ApprovalDataHistoryField>([
  "clienteCorreo",
  "clienteTelefono",
  "clienteDepartamento",
  "clienteCiudad",
  "clienteDireccion",
  "referenciaEquipo",
]);

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validEditableData(value: unknown): value is ApprovalEditableData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const review = item.review as Record<string, unknown> | null;
  const capabilities = item.capabilities as Record<string, unknown> | null;
  return typeof item.clienteNombre === "string"
    && nullableString(item.clienteDocumento)
    && nullableString(item.clienteCorreo)
    && nullableString(item.clienteTelefono)
    && nullableString(item.clienteDepartamento)
    && nullableString(item.clienteDepartamentoLabel)
    && nullableString(item.clienteCiudad)
    && nullableString(item.clienteDireccion)
    && nullableString(item.referenciaEquipo)
    && nullableString(item.plataforma)
    && Boolean(review)
    && Number.isSafeInteger(review?.revision)
    && Number(review?.revision) > 0
    && typeof review?.reviewHash === "string"
    && review.reviewHash.length > 0
    && Boolean(capabilities)
    && typeof capabilities?.canEditData === "boolean"
    && nullableString(capabilities?.correctionBlockedReason);
}

function validDataHistory(history: unknown): history is ApprovalDataHistoryEvent[] {
  return Array.isArray(history) && history.every((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const item = event as Record<string, unknown>;
    return typeof item.id === "string"
      && typeof item.reason === "string"
      && typeof item.actorName === "string"
      && (item.actorKind === "USER" || item.actorKind === "SHARED_LINK")
      && typeof item.createdAt === "string"
      && Number.isFinite(new Date(item.createdAt).getTime())
      && Array.isArray(item.changes)
      && item.changes.every((change) => {
        if (!change || typeof change !== "object" || Array.isArray(change)) return false;
        const row = change as Record<string, unknown>;
        return typeof row.field === "string"
          && APPROVAL_DATA_HISTORY_FIELDS.has(row.field as ApprovalDataHistoryField)
          && nullableString(row.before)
          && nullableString(row.after);
      });
  });
}

export async function readApprovalData(id: number, signal?: AbortSignal): Promise<ApprovalDataResponse> {
  const response = await fetch(`/api/aprobaciones/${id}/datos`, { cache: "no-store", signal });
  const result = await readResult<ApprovalDataResponse>(
    response,
    "No fue posible cargar la información editable del expediente."
  );
  if (!validEditableData(result.item) || !validDataHistory(result.history)) {
    throw new ApprovalRequestError("La información editable no devolvió una respuesta válida.", response.status);
  }
  return result;
}

export async function readApprovalEquipmentCatalog(signal?: AbortSignal) {
  const response = await fetch("/api/aprobaciones/catalogo-equipos", { cache: "no-store", signal });
  const result = await readResult<{ items: ApprovalEquipmentCatalogItem[] }>(
    response,
    "No fue posible cargar el catálogo de equipos."
  );
  if (!Array.isArray(result.items) || result.items.some((item) =>
    !item
    || !Number.isSafeInteger(item.id)
    || item.id <= 0
    || typeof item.marca !== "string"
    || typeof item.modelo !== "string"
    || typeof item.referenciaEquipo !== "string"
    || typeof item.plataforma !== "string"
  )) {
    throw new ApprovalRequestError("El catálogo de equipos no devolvió una respuesta válida.", response.status);
  }
  return result.items;
}

export async function updateApprovalData(id: number, input: {
  changes: ApprovalDataChanges;
  reason: string;
  revision: number;
  reviewHash: string;
  idempotencyKey: string;
}) {
  const response = await fetch(`/api/aprobaciones/${id}/datos`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await readResult<{
    ok?: boolean;
    item: ApprovalEditableData;
    history: ApprovalDataHistoryEvent[];
    unchanged: boolean;
    replayed: boolean;
  }>(response, "No fue posible guardar la corrección. Actualiza el expediente antes de intentarlo de nuevo.");
  if (result.ok !== true
      || !validEditableData(result.item)
      || typeof result.unchanged !== "boolean"
      || typeof result.replayed !== "boolean"
      || !validDataHistory(result.history)) {
    throw new ApprovalRequestError("No se recibió confirmación válida de la corrección. Actualiza el expediente.", response.status);
  }
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
