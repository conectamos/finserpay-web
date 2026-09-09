import { createHash, randomUUID } from "node:crypto";
import {
  blacklistReason,
  blacklistUnavailable,
  blacklistUuid,
  blacklistVersion,
  DocumentBlacklistError,
  normalizeBlacklistedDocument,
} from "@/lib/document-blacklist-core";

export type BlacklistDatabase = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

export type BlacklistItem = {
  id: string;
  documento: string;
  motivo: string;
  activa: boolean;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  createdByName: string;
  updatedByName: string;
};
export type BlacklistActor = { id: number; nombre: string };
const itemColumns = `"id", "documento", "motivo", "activa", "version",
  "createdAt", "updatedAt", "createdByName", "updatedByName"`;

async function lock(db: BlacklistDatabase, key: string) {
  // PostgreSQL returns void here; executeRaw must not try to deserialize it.
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", key);
}

export async function assertDocumentAllowed(
  value: unknown,
  db: BlacklistDatabase,
  transactional = false,
): Promise<void> {
  const documento = normalizeBlacklistedDocument(value);
  try {
    if (transactional) await lock(db, `DOCUMENT_BLACKLIST:${documento}`);
    const rows = await db.$queryRawUnsafe<Array<{ activa: boolean }>>(
      `SELECT "activa" FROM public."ListaNegraDocumento" WHERE "documento" = $1`, documento,
    );
    if (rows.some((row) => row.activa)) {
      throw new DocumentBlacklistError("DOCUMENT_BLACKLISTED", "Esta cédula está bloqueada para ventas y consultas de crédito. Contacta a FINSER PAY.", 403);
    }
  } catch (error) {
    if (error instanceof DocumentBlacklistError) throw error;
    // Never fall back to an approval if storage or its schema is unavailable.
    throw blacklistUnavailable();
  }
}

export type BlacklistMutation =
  | { kind: "CREATE"; documento: string; motivo: string; mutationId: string }
  | { kind: "UPDATE"; id: string; activa: boolean; motivo: string; version: number; mutationId: string };

export function parseBlacklistMutation(method: "POST" | "PATCH", input: unknown): BlacklistMutation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DocumentBlacklistError("INVALID_REQUEST", "La solicitud no es válida.");
  }
  const body = input as Record<string, unknown>;
  const common = { motivo: blacklistReason(body.motivo), mutationId: blacklistUuid(body.mutationId) };
  if (method === "POST") return { ...common, kind: "CREATE", documento: normalizeBlacklistedDocument(body.documento) };
  if (typeof body.activa !== "boolean") throw new DocumentBlacklistError("INVALID_STATE", "El estado solicitado no es válido.");
  return { ...common, kind: "UPDATE", id: blacklistUuid(body.id), activa: body.activa, version: blacklistVersion(body.version) };
}

/** Must run in a transaction. The document lock is shared with new sales and bureau calls. */
export async function mutateBlacklist(db: BlacklistDatabase, input: BlacklistMutation, actor: BlacklistActor) {
  const requestHash = createHash("sha256").update(JSON.stringify([input, actor.id])).digest("hex");
  await lock(db, `DOCUMENT_BLACKLIST_MUTATION:${input.mutationId}`);
  const previous = await db.$queryRawUnsafe<Array<{ requestHash: string; after: BlacklistItem }>>(
    `SELECT "requestHash", "after" FROM public."ListaNegraDocumentoEvento" WHERE "mutationId" = $1::uuid`, input.mutationId,
  );
  if (previous[0]) {
    if (previous[0].requestHash !== requestHash) throw new DocumentBlacklistError("MUTATION_CONFLICT", "La operación ya fue utilizada con otros datos.", 409);
    return { item: previous[0].after, idempotent: true };
  }
  const identified = input.kind === "UPDATE"
    ? await db.$queryRawUnsafe<BlacklistItem[]>(`SELECT ${itemColumns} FROM public."ListaNegraDocumento" WHERE "id" = $1::uuid`, input.id)
    : [];
  if (input.kind === "UPDATE" && !identified[0]) throw new DocumentBlacklistError("NOT_FOUND", "No se encontró el registro.", 404);
  const documento = input.kind === "CREATE" ? input.documento : identified[0].documento;
  await lock(db, `DOCUMENT_BLACKLIST:${documento}`);
  const rows = await db.$queryRawUnsafe<BlacklistItem[]>(
    `SELECT ${itemColumns} FROM public."ListaNegraDocumento" WHERE "documento" = $1 FOR UPDATE`, documento,
  );
  const before = rows[0] ?? null;
  if (input.kind === "CREATE" && before?.activa) throw new DocumentBlacklistError("ALREADY_BLACKLISTED", "Esta cédula ya tiene un bloqueo activo.", 409);
  if (input.kind === "UPDATE" && (!before || before.version !== input.version)) throw new DocumentBlacklistError("VERSION_CONFLICT", "Otro administrador modificó este registro. Actualiza la lista.", 409);
  const activa = input.kind === "CREATE" ? true : input.activa;
  if (input.kind === "UPDATE" && before?.activa === activa) throw new DocumentBlacklistError("STATE_CONFLICT", "El registro ya tiene ese estado. Actualiza la lista.", 409);
  const id = before?.id ?? randomUUID();
  const saved = before
    ? await db.$queryRawUnsafe<BlacklistItem[]>(
      `UPDATE public."ListaNegraDocumento" SET "activa"=$2, "motivo"=$3, "version"="version"+1,
       "updatedByUserId"=$4, "updatedByName"=$5, "updatedAt"=CURRENT_TIMESTAMP
       WHERE "id"=$1::uuid RETURNING ${itemColumns}`,
      id, activa, input.motivo, actor.id, actor.nombre,
    )
    : await db.$queryRawUnsafe<BlacklistItem[]>(
      `INSERT INTO public."ListaNegraDocumento" ("id","documento","motivo","activa","createdByUserId","createdByName","updatedByUserId","updatedByName")
       VALUES ($1::uuid,$2,$3,true,$4,$5,$4,$5) RETURNING ${itemColumns}`,
      id, documento, input.motivo, actor.id, actor.nombre,
    );
  const item = saved[0];
  if (!item) throw blacklistUnavailable();
  await db.$executeRawUnsafe(
    `INSERT INTO public."ListaNegraDocumentoEvento" ("id","registroId","mutationId","requestHash","accion","motivo","actorUserId","actorName","before","after")
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    randomUUID(), id, input.mutationId, requestHash, activa ? "BLOQUEAR" : "DESBLOQUEAR", input.motivo,
    actor.id, actor.nombre, before ? JSON.stringify(before) : null, JSON.stringify(item),
  );
  return { item, idempotent: false };
}

export function parseBlacklistFilters(params: URLSearchParams) {
  const raw = (params.get("q") ?? "").trim();
  if (raw && !/^[\d.\s-]+$/.test(raw)) throw new DocumentBlacklistError("INVALID_SEARCH", "Busca usando los dígitos de la cédula.");
  const q = raw.replace(/[.\s-]/g, "").replace(/^0+/, "");
  if (q.length > 13) throw new DocumentBlacklistError("INVALID_SEARCH", "La búsqueda no puede superar 13 dígitos.");
  const estado = params.get("estado") ?? "ACTIVA";
  if (!["ACTIVA", "INACTIVA", "TODAS"].includes(estado)) throw new DocumentBlacklistError("INVALID_STATE", "El filtro de estado no es válido.");
  const page = Number(params.get("page") ?? "1");
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new DocumentBlacklistError("INVALID_PAGE", "La página solicitada no es válida.");
  return { q, estado, page };
}

export async function listBlacklist(db: BlacklistDatabase, filters: ReturnType<typeof parseBlacklistFilters>) {
  const { q, estado, page } = filters;
  const pageSize = 25;
  const active = estado === "TODAS" ? null : estado === "ACTIVA";
  const where = `WHERE ($1::text = '' OR "documento" LIKE '%' || $1 || '%') AND ($2::boolean IS NULL OR "activa" = $2)`;
  const counts = await db.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM public."ListaNegraDocumento" ${where}`, q, active);
  const items = await db.$queryRawUnsafe<BlacklistItem[]>(`SELECT ${itemColumns} FROM public."ListaNegraDocumento" ${where} ORDER BY "updatedAt" DESC, "id" LIMIT $3 OFFSET $4`, q, active, pageSize, (page - 1) * pageSize);
  return { items, total: counts[0]?.total ?? 0, page, pageSize };
}
