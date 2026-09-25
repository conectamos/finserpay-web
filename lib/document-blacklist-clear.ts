import { createHash, randomUUID } from "node:crypto";
import { blacklistReason, blacklistUuid, DocumentBlacklistError } from "@/lib/document-blacklist-core";
import type { BlacklistActor, BlacklistDatabase } from "@/lib/document-blacklist-store";

export type BlacklistClearPreview = { total: number; active: number; inactive: number; fingerprint: string };
export type BlacklistClearInput = { motivo: string; mutationId: string; fingerprint: string; confirmed: true };
export type BlacklistClearResult = { clearId: string; removed: number; unblocked: number; createdAt: string; actorName: string; idempotent: boolean };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function parseBlacklistClear(input: unknown): BlacklistClearInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DocumentBlacklistError("INVALID_REQUEST", "La solicitud no es válida.");
  const body = input as Record<string, unknown>;
  if (body.confirmed !== true) throw new DocumentBlacklistError("CLEAR_CONFIRMATION_REQUIRED", "Confirma la eliminación de todas las cédulas.");
  if (typeof body.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint)) {
    throw new DocumentBlacklistError("INVALID_CLEAR_PREVIEW", "Revisa el total de cédulas antes de confirmar.");
  }
  return { motivo: blacklistReason(body.motivo), mutationId: blacklistUuid(body.mutationId), fingerprint: body.fingerprint, confirmed: true };
}

// All registered rows, regardless of search, status or pagination. A single
// aggregate gives counts and fingerprint from the same database snapshot.
export async function previewBlacklistClear(db: BlacklistDatabase, actor: BlacklistActor): Promise<BlacklistClearPreview> {
  const [row] = await db.$queryRawUnsafe<Array<{ total: number; active: number; inactive: number; digest: string }>>(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE "activa")::int AS active,
      COUNT(*) FILTER (WHERE NOT "activa")::int AS inactive,
      MD5(COALESCE(STRING_AGG("id"::text || ':' || "version"::text,',' ORDER BY "id"),'')) AS digest
     FROM public."ListaNegraDocumento" WHERE "eliminadaAt" IS NULL`,
  );
  if (!row) throw new Error("Missing blacklist preview");
  return { total: row.total, active: row.active, inactive: row.inactive, fingerprint: hash([actor.id, row.digest]) };
}

/** Transaction required. History stays append-only; removed rows cannot block sales. */
export async function clearBlacklist(db: BlacklistDatabase, input: BlacklistClearInput, actor: BlacklistActor): Promise<BlacklistClearResult> {
  const requestHash = hash([actor.id, input.motivo, input.fingerprint]);
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `DOCUMENT_BLACKLIST_CLEAR:${input.mutationId}`);
  const [previous] = await db.$queryRawUnsafe<Array<{ requestHash: string; result: BlacklistClearResult }>>(
    `SELECT "requestHash","result" FROM public."ListaNegraLimpieza" WHERE "id"=$1::uuid`, input.mutationId,
  );
  if (previous) {
    if (previous.requestHash !== requestHash) throw new DocumentBlacklistError("MUTATION_CONFLICT", "La operación ya fue utilizada con otros datos.", 409);
    return { ...previous.result, idempotent: true };
  }
  // Writers hold this same gate in shared mode before taking any document lock.
  // It prevents unseen inserts and stale updates without reversing lock order.
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", "DOCUMENT_BLACKLIST_LIST");
  const preview = await previewBlacklistClear(db, actor);
  if (preview.fingerprint !== input.fingerprint) throw new DocumentBlacklistError("CLEAR_PREVIEW_CHANGED", "La lista cambió. Revisa el total actualizado y confirma de nuevo; no se eliminó ninguna cédula.", 409);
  if (!preview.total) throw new DocumentBlacklistError("BLACKLIST_EMPTY", "La lista negra ya está vacía.", 409);
  await db.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext('DOCUMENT_BLACKLIST:' || docs."documento"))
     FROM (SELECT "documento" FROM public."ListaNegraDocumento" WHERE "eliminadaAt" IS NULL ORDER BY "documento" COLLATE "C") docs
     ORDER BY docs."documento" COLLATE "C"`,
  );
  const changes = await db.$queryRawUnsafe<Array<{ id: string; before: unknown; after: unknown }>>(
    `WITH before AS MATERIALIZED (
       SELECT item."id",to_jsonb(item) AS snapshot FROM public."ListaNegraDocumento" item WHERE "eliminadaAt" IS NULL FOR UPDATE
     ) UPDATE public."ListaNegraDocumento" item SET "activa"=false,"eliminadaAt"=CURRENT_TIMESTAMP,
       "version"=item."version"+1,"motivo"=$1,"updatedByUserId"=$2,"updatedByName"=$3,"updatedAt"=CURRENT_TIMESTAMP
       FROM before WHERE item."id"=before."id"
       RETURNING item."id",before.snapshot AS before,to_jsonb(item) AS after`, input.motivo, actor.id, actor.nombre,
  );
  if (changes.length !== preview.total) throw new Error("Incomplete blacklist cleanup");
  const events = changes.map(change => ({ ...change, eventId: randomUUID(), mutationId: randomUUID() }));
  await db.$executeRawUnsafe(
    `INSERT INTO public."ListaNegraDocumentoEvento"
      ("id","registroId","mutationId","requestHash","accion","motivo","actorUserId","actorName","before","after")
     SELECT event."eventId"::uuid,event.id::uuid,event."mutationId"::uuid,$2,'ELIMINAR',$3,$4,$5,event."before",event."after"
     FROM jsonb_to_recordset($1::jsonb) AS event(id text,"eventId" text,"mutationId" text,"before" jsonb,"after" jsonb)`,
    JSON.stringify(events), requestHash, input.motivo, actor.id, actor.nombre,
  );
  const result: BlacklistClearResult = { clearId: input.mutationId, removed: changes.length, unblocked: preview.active,
    createdAt: new Date().toISOString(), actorName: actor.nombre, idempotent: false };
  await db.$executeRawUnsafe(
    `INSERT INTO public."ListaNegraLimpieza" ("id","requestHash","actorUserId","actorName","motivo","result")
     VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb)`, input.mutationId, requestHash, actor.id, actor.nombre, input.motivo, JSON.stringify(result),
  );
  return result;
}
