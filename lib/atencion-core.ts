import type { AttentionActor, AttentionFilters, AttentionMutation } from "./atencion-types";

export class AttentionError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "AttentionError"; }
}
export function attentionUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new AttentionError("Identificador inválido.");
  return value.toLowerCase();
}
export function attentionText(value: unknown, max: number, required = true): string {
  if (typeof value !== "string") throw new AttentionError("Texto inválido.");
  const text = [...value].filter(char => { const code = char.charCodeAt(0); return code >= 32 && code !== 127 || [9, 10, 13].includes(code); }).join("").trim();
  if ((required && !text) || text.length > max) throw new AttentionError(`El texto debe contener entre ${required ? 1 : 0} y ${max} caracteres.`);
  return text;
}
/** Exact E.164 comparison; Colombia's local ten-digit mobile format is the only inferred country. */
export function normalizeAttentionPhone(value: unknown): string {
  if (typeof value !== "string" || !/^[+\d\s().-]+$/.test(value.trim())) throw new AttentionError("Ingresa un teléfono válido con indicativo de país.");
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^3\d{9}$/.test(digits)) digits = `57${digits}`;
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw new AttentionError("Ingresa un teléfono válido con indicativo de país.");
  return `+${digits}`;
}
export function assertAttentionActor(actor: AttentionActor) {
  if (!Number.isSafeInteger(actor.userId) || actor.userId <= 0 ||
      actor.key !== (actor.sellerId ? `seller:${actor.sellerId}` : `user:${actor.userId}`) ||
      (actor.central && !actor.admin) || (!actor.admin && (!Number.isSafeInteger(actor.sellerId) || Number(actor.sellerId) <= 0)) ||
      (!actor.central && (!Number.isSafeInteger(actor.aliadoId) || Number(actor.aliadoId) <= 0)) ||
      (!actor.admin && (!Number.isSafeInteger(actor.sedeId) || Number(actor.sedeId) <= 0))) {
    throw new AttentionError("Perfil de atención no autorizado.", 403);
  }
}
export async function getAttentionAccess(): Promise<AttentionActor> {
  const { getDashboardAccess } = await import("./dashboard-access");
  const access = await getDashboardAccess();
  if (!access) throw new AttentionError("Inicia sesión para acceder a atención.", 401);
  if (!access.admin && !access.seller) throw new AttentionError("Abre primero tu perfil de asesor.", 403);
  const actor: AttentionActor = {
    userId: access.session.id, sellerId: access.admin ? null : access.seller!.id,
    key: access.admin ? `user:${access.session.id}` : `seller:${access.seller!.id}`,
    name: access.admin ? access.session.nombre : access.seller!.nombre,
    central: access.admin && access.session.aliadoAccesoCodigo?.trim().toUpperCase() === "FINSERPAY",
    admin: access.admin, supervisor: access.supervisor,
    aliadoId: access.admin ? access.session.aliadoAccesoId : access.session.aliadoId,
    sedeId: access.admin ? access.session.sedeAccesoId : access.seller!.sedeId,
  };
  assertAttentionActor(actor); return actor;
}
export function parseAttentionFilters(params: URLSearchParams): AttentionFilters {
  if (["search", "filter", "page"].some(key => params.getAll(key).length > 1)) throw new AttentionError("No repitas parámetros de búsqueda.");
  const filter = params.get("filter") || "mine";
  if (!["mine", "all", "pending", "closed"].includes(filter)) throw new AttentionError("Filtro inválido.");
  const pageText = params.get("page") || "1";
  if (!/^\d+$/.test(pageText) || Number(pageText) < 1 || Number(pageText) > 10000) throw new AttentionError("Página inválida.");
  return { search: attentionText(params.get("search") || "", 120, false), filter: filter as AttentionFilters["filter"], page: Number(pageText) };
}
export function parseAttentionMutation(body: Record<string, unknown>): AttentionMutation {
  const actions = ["claim", "transfer", "close", "reopen", "note", "tags", "task", "complete_task", "link", "unlink", "human_request"];
  if (typeof body.action !== "string" || !actions.includes(body.action)) throw new AttentionError("Acción inválida.");
  if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 1) throw new AttentionError("Versión inválida.");
  const result: AttentionMutation = { action: body.action as AttentionMutation["action"], version: body.version, requestId: attentionUuid(body.requestId) };
  if (result.action === "transfer") {
    if (typeof body.assigneeKey !== "string" || !/^(user|seller):[1-9]\d{0,9}$/.test(body.assigneeKey)) throw new AttentionError("Asesor inválido.");
    result.assigneeKey = body.assigneeKey;
  }
  if (result.action === "note" || result.action === "task") result.text = attentionText(body.text, result.action === "note" ? 4000 : 240);
  if (result.action === "tags") {
    if (!Array.isArray(body.tags) || body.tags.length > 8) throw new AttentionError("Puedes usar hasta ocho etiquetas.");
    result.tags = [...new Set(body.tags.map(tag => attentionText(tag, 40)))];
  }
  if (result.action === "task") {
    if (body.dueAt === null || body.dueAt === undefined || body.dueAt === "") result.dueAt = null;
    else {
      if (typeof body.dueAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(body.dueAt) || !Number.isFinite(Date.parse(body.dueAt))) throw new AttentionError("Fecha de recordatorio inválida.");
      result.dueAt = new Date(body.dueAt).toISOString();
    }
  }
  if (result.action === "complete_task") result.taskId = attentionUuid(body.taskId);
  if (result.action === "link") {
    if (typeof body.creditId !== "number" || !Number.isSafeInteger(body.creditId) || body.creditId < 1) throw new AttentionError("Crédito inválido.");
    result.creditId = body.creditId;
  }
  return result;
}
