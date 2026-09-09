import { createHash, randomUUID } from "node:crypto";
import {
  BULK_MAX_ENTRIES,
  parseBlacklistBulkInput,
  type BulkInput,
  type BulkPreview,
  type BulkResult,
  type BulkRow,
  type BulkSummary,
} from "@/lib/document-blacklist-bulk-core";
import { blacklistUnavailable, blacklistUuid, DocumentBlacklistError } from "@/lib/document-blacklist-core";
import type { BlacklistActor, BlacklistDatabase, BlacklistItem } from "@/lib/document-blacklist-store";

const columns = `"id", "documento", "motivo", "activa", "version", "createdAt", "updatedAt", "createdByName", "updatedByName"`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type BulkCommitInput = BulkInput & { mutationId: string; fingerprint: string; confirmed: true };

export function parseBlacklistBulkCommit(input: unknown): BulkCommitInput {
  const parsed = parseBlacklistBulkInput(input);
  const body = input as Record<string, unknown>;
  if (body.confirmed !== true) throw new DocumentBlacklistError("BULK_CONFIRMATION_REQUIRED", "Confirma la previsualización antes de guardar la lista.");
  if (typeof body.fingerprint !== "string" || !/^[0-9a-f]{64}$/i.test(body.fingerprint)) {
    throw new DocumentBlacklistError("INVALID_BULK_PREVIEW", "Previsualiza la lista antes de confirmar la importación.");
  }
  return { ...parsed, mutationId: blacklistUuid(body.mutationId), fingerprint: body.fingerprint.toLowerCase(), confirmed: true };
}

async function readItems(db: BlacklistDatabase, documentos: string[]) {
  if (!documentos.length) return [];
  return db.$queryRawUnsafe<BlacklistItem[]>(
    `SELECT ${columns} FROM public."ListaNegraDocumento" WHERE "documento" IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    JSON.stringify(documentos),
  );
}

function buildPreview(input: BulkInput, actor: BlacklistActor, items: BlacklistItem[]): BulkPreview {
  const existing = new Map(items.map((item) => [item.documento, item]));
  const summary: BulkSummary = { total: input.parsed.rows.length, nuevas: 0, reactivar: 0, yaBloqueadas: 0, duplicadas: 0, invalidas: 0 };
  const rows: BulkRow[] = input.parsed.rows.map((row) => {
    const base = { position: row.position, input: row.input, documento: row.documento };
    if (row.error || !row.documento) {
      summary.invalidas += 1;
      return { ...base, status: "INVALIDA", message: row.error || "Cédula no válida." };
    }
    if (row.duplicateOf !== null) {
      summary.duplicadas += 1;
      return { ...base, status: "DUPLICADA", message: `Repetida en la entrada ${row.duplicateOf}; no se volverá a registrar.` };
    }
    const current = existing.get(row.documento);
    if (current?.activa) {
      summary.yaBloqueadas += 1;
      return { ...base, status: "YA_BLOQUEADA", message: "Ya tiene un bloqueo activo; se conserva su motivo e historial." };
    }
    if (current) {
      summary.reactivar += 1;
      return { ...base, status: "REACTIVAR", message: "El bloqueo está inactivo; se reactivará con el motivo de esta carga." };
    }
    summary.nuevas += 1;
    return { ...base, status: "NUEVA", message: "Se registrará un nuevo bloqueo." };
  });
  const fingerprint = hash([actor.id, input.motivo, input.parsed.documentos.map((documento) => {
    const item = existing.get(documento);
    return [documento, item?.id ?? null, item?.activa ?? null, item?.version ?? null];
  })]);
  return { rows, summary, fingerprint, canConfirm: summary.invalidas === 0 && summary.nuevas + summary.reactivar > 0, maxEntries: BULK_MAX_ENTRIES, motivo: input.motivo };
}

export async function previewBlacklistBulk(db: BlacklistDatabase, input: BulkInput, actor: BlacklistActor): Promise<BulkPreview> {
  try {
    return buildPreview(input, actor, await readItems(db, input.parsed.documentos));
  } catch (error) {
    if (error instanceof DocumentBlacklistError) throw error;
    throw blacklistUnavailable();
  }
}

/** Caller must provide a transaction: locks, rows, individual audit and batch receipt are atomic. */
export async function commitBlacklistBulk(db: BlacklistDatabase, input: BulkCommitInput, actor: BlacklistActor): Promise<BulkResult> {
  try {
    if (input.parsed.rows.some((row) => row.error || !row.documento)) {
      throw new DocumentBlacklistError("BULK_INVALID_ROWS", "Corrige las cédulas inválidas y vuelve a previsualizar. No se ha guardado ninguna cédula.");
    }
    const requestHash = hash([input.texto, input.motivo, input.fingerprint, actor.id]);
    await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `DOCUMENT_BLACKLIST_BULK_MUTATION:${input.mutationId}`);
    const previous = await db.$queryRawUnsafe<Array<{ requestHash: string; actorUserId: number; result: BulkResult }>>(
      `SELECT "requestHash", "actorUserId", "result" FROM public."ListaNegraImportacion" WHERE "id"=$1::uuid`, input.mutationId,
    );
    if (previous[0]) {
      if (previous[0].requestHash !== requestHash || previous[0].actorUserId !== actor.id) {
        throw new DocumentBlacklistError("MUTATION_CONFLICT", "La operación ya fue utilizada con otros datos.", 409);
      }
      // Replay precedes state checks: a later unblock must not rerun an already completed import.
      return { ...previous[0].result, idempotent: true };
    }
    // PostgreSQL evaluates output expressions after sorting when ORDER BY does not
    // reference them: https://www.postgresql.org/docs/18/sql-select.html#SQL-SELECT-LIST
    // One statement avoids 500 network round trips while retaining lexical lock order.
    // executeRaw is required because pg_advisory_xact_lock returns PostgreSQL void.
    await db.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext('DOCUMENT_BLACKLIST:' || docs."documento"))
       FROM (SELECT value AS "documento" FROM jsonb_array_elements_text($1::jsonb) ORDER BY value COLLATE "C") AS docs
       ORDER BY docs."documento" COLLATE "C"`,
      JSON.stringify(input.parsed.documentos),
    );
    const beforeItems = await readItems(db, input.parsed.documentos);
    const preview = buildPreview(input, actor, beforeItems);
    if (preview.fingerprint !== input.fingerprint) {
      throw new DocumentBlacklistError("BULK_PREVIEW_CHANGED", "La lista negra cambió desde la previsualización. Revisa nuevamente antes de confirmar. No se ha guardado ninguna cédula.", 409);
    }
    if (!preview.canConfirm) {
      throw new DocumentBlacklistError("BULK_NOTHING_TO_IMPORT", "Todas las cédulas válidas ya están bloqueadas. No hay registros para importar.", 409);
    }
    const previousByDocument = new Map(beforeItems.map((item) => [item.documento, item]));
    const changes = input.parsed.documentos.filter((documento) => !previousByDocument.get(documento)?.activa)
      .map((documento) => ({ id: previousByDocument.get(documento)?.id ?? randomUUID(), documento }));
    const saved = await db.$queryRawUnsafe<BlacklistItem[]>(
      `INSERT INTO public."ListaNegraDocumento" ("id","documento","motivo","activa","createdByUserId","createdByName","updatedByUserId","updatedByName")
       SELECT item.id::uuid,item.documento,$2,true,$3,$4,$3,$4
       FROM jsonb_to_recordset($1::jsonb) AS item(id text, documento text)
       ON CONFLICT ("documento") DO UPDATE SET "activa"=true,"motivo"=EXCLUDED."motivo",
         "version"="ListaNegraDocumento"."version"+1,"updatedByUserId"=EXCLUDED."updatedByUserId",
         "updatedByName"=EXCLUDED."updatedByName","updatedAt"=CURRENT_TIMESTAMP
       WHERE NOT "ListaNegraDocumento"."activa"
       RETURNING ${columns}`,
      JSON.stringify(changes), input.motivo, actor.id, actor.nombre,
    );
    if (saved.length !== changes.length) throw blacklistUnavailable();
    const events = saved.map((item) => {
      const mutationId = randomUUID();
      return {
        id: randomUUID(), registroId: item.id, mutationId,
        requestHash: hash([{ kind: "CREATE", documento: item.documento, motivo: input.motivo, mutationId }, actor.id]),
        before: previousByDocument.get(item.documento) ?? null, after: item,
      };
    });
    await db.$executeRawUnsafe(
      `INSERT INTO public."ListaNegraDocumentoEvento" ("id","registroId","mutationId","requestHash","accion","motivo","actorUserId","actorName","before","after")
       SELECT event.id::uuid,event."registroId"::uuid,event."mutationId"::uuid,event."requestHash",'BLOQUEAR',$2,$3,$4,
         NULLIF(event."before",'null'::jsonb),event."after"
       FROM jsonb_to_recordset($1::jsonb) AS event(id text,"registroId" text,"mutationId" text,"requestHash" text,"before" jsonb,"after" jsonb)`,
      JSON.stringify(events), input.motivo, actor.id, actor.nombre,
    );
    const times = await db.$queryRawUnsafe<Array<{ createdAt: Date | string }>>(`SELECT CURRENT_TIMESTAMP AS "createdAt"`);
    if (!times[0]) throw blacklistUnavailable();
    const createdAt = new Date(times[0].createdAt).toISOString();
    const result: BulkResult = {
      importId: input.mutationId, summary: preview.summary,
      items: input.parsed.documentos.map((documento) => {
        const before = previousByDocument.get(documento);
        return { documento, accion: before?.activa ? "OMITIDA" : before ? "REACTIVADA" : "BLOQUEADA" };
      }),
      createdAt, actorName: actor.nombre, idempotent: false,
    };
    await db.$executeRawUnsafe(
      `INSERT INTO public."ListaNegraImportacion" ("id","requestHash","actorUserId","actorName","motivo","result","createdAt")
       VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
      input.mutationId, requestHash, actor.id, actor.nombre, input.motivo, JSON.stringify(result), createdAt,
    );
    return result;
  } catch (error) {
    if (error instanceof DocumentBlacklistError) throw error;
    throw blacklistUnavailable();
  }
}
