export type PendingStatus = "WAITING_ALLY" | "RESPONDED";
export type PendingIssue = {
  id: string;
  key: string;
  label: string;
  status: "OPEN" | "RESPONDED";
  version: number;
  reason: string;
  openedAt: string;
  respondedAt: string | null;
  responseText?: string | null;
  evidence?: { available: boolean; href: string | null; sha256: string | null };
};
export type PendingCredit = {
  id: number;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string | null;
  aliadoNombre: string;
  sedeNombre: string;
  fechaCredito: string | null;
  novelty: { id: string; status: PendingStatus; version: number; pendingCount: number; answeredCount: number };
};
export type PendingDetail = PendingCredit & {
  novelty: PendingCredit["novelty"] & { items: PendingIssue[] };
  canRespond: boolean;
  blockedReason: string | null;
};
type ResponseIdentity = { noveltyId: string; itemId: string; expectedVersion: number; idempotencyKey: string };
export type PendingPhotoResponse = ResponseIdentity & { expectedPhotoHash: string | null; dataUrl: string };
export type PendingTextResponse = ResponseIdentity & { text: string };

export class PendingRequestError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "PendingRequestError";
  }
}

async function readResult<T>(response: Response, fallback: string): Promise<T> {
  let body: T & { ok?: boolean; error?: string };
  try { body = await response.json(); }
  catch { throw new PendingRequestError(fallback, response.status); }
  if (!response.ok || !body || body.ok === false) {
    throw new PendingRequestError(typeof body?.error === "string" ? body.error : fallback, response.status);
  }
  return body;
}

export type PendingPage = { items: PendingCredit[]; nextCursor: string | null; hasMore: boolean };
export async function listPendingCredits(options: { status?: PendingStatus; cursor?: string } = {}, signal?: AbortSignal): Promise<PendingPage> {
  const query = new URLSearchParams();
  if (options.status) query.set("status", options.status);
  if (options.cursor) query.set("cursor", options.cursor);
  const response = await fetch(`/api/pendientes${query.size ? `?${query}` : ""}`, { cache: "no-store", signal });
  const result = await readResult<PendingPage>(response, "No fue posible cargar los pendientes.");
  if (!Array.isArray(result.items) || result.items.some((item) => !item?.novelty ||
    !Number.isInteger(item.id) || !["WAITING_ALLY", "RESPONDED"].includes(item.novelty.status))) {
    throw new PendingRequestError("El listado recibido no es válido. Actualiza los pendientes.", response.status);
  }
  if (typeof result.hasMore !== "boolean" || (result.hasMore && !result.nextCursor)) {
    throw new PendingRequestError("No se recibió una paginación válida. Actualiza los pendientes.", response.status);
  }
  return result;
}

export async function readPendingCredit(id: number, signal?: AbortSignal): Promise<PendingDetail> {
  const response = await fetch(`/api/pendientes/${id}`, { cache: "no-store", signal });
  const result = await readResult<{ item: PendingDetail }>(response, "No fue posible cargar las novedades del crédito.");
  if (result.item?.id !== id || !Array.isArray(result.item.novelty?.items) ||
    typeof result.item.canRespond !== "boolean") {
    throw new PendingRequestError("Las novedades recibidas no corresponden al crédito seleccionado.", response.status);
  }
  return result.item;
}

async function saveResponse(id: number, action: "evidencias" | "respuesta", input: PendingPhotoResponse | PendingTextResponse) {
  const response = await fetch(`/api/pendientes/${id}/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const result = await readResult<{ ok: boolean; unchanged: boolean }>(response,
    "No se pudo confirmar el guardado. Actualiza las novedades para comprobar el resultado.");
  if (result.ok !== true || typeof result.unchanged !== "boolean") {
    throw new PendingRequestError("No se recibió confirmación del guardado. Actualiza las novedades antes de continuar.", response.status);
  }
  return result;
}

export function respondPendingPhoto(id: number, input: PendingPhotoResponse) {
  return saveResponse(id, "evidencias", input);
}
export function respondPendingText(id: number, input: PendingTextResponse) {
  return saveResponse(id, "respuesta", input);
}

export function canRespondToPendingIssue(detail: PendingDetail, issue: PendingIssue) {
  return detail.canRespond && issue.status === "OPEN";
}
