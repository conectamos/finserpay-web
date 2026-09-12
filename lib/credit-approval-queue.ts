import { buildCreditApprovalRequiredSql } from "@/lib/credit-approval-policy";
import { buildCurrentCreditApprovalSql } from "@/lib/credit-approval-actor";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import type { NoveltyDatabase } from "@/lib/credit-approval-novelty-core";

type Cursor = { createdAt: string; id: number };
export type CreditApprovalQueueInput = { cursor?: string | null; limit?: number; documento?: string | null; q?: string | null };
export function approvalQueueSearch(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CreditApprovalError("INVALID_SEARCH", "Busca por cliente, cédula, folio o aliado con hasta 100 caracteres.");
  }
  return value.trim() || null;
}
// strpos treats %, _ and SQL punctuation as literal text. The search value is always a parameter.
function queueSearchSql(parameter: number) {
  return `(strpos(lower(COALESCE(credit."clienteNombre",'')),lower($${parameter}::text))>0
    OR strpos(lower(COALESCE(credit."clienteDocumento",'')),lower($${parameter}::text))>0
    OR strpos(lower(COALESCE(credit."folio",'')),lower($${parameter}::text))>0
    OR strpos(lower(COALESCE(ally."nombre",'')),lower($${parameter}::text))>0)`;
}
function queueVisibleScopeSql() {
  return `${buildCreditApprovalQueueScopeSql("credit")}
      AND UPPER(BTRIM(COALESCE(ally."codigo",'')))<>'FINSERPAY'
      AND UPPER(BTRIM(COALESCE(credit."estado",''))) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA')`;
}
function queuePendingSql() {
  return `NOT EXISTS (SELECT 1 FROM "LiquidacionAliadoCredito" paid WHERE paid."creditoId"=credit."id")
      AND (review."status" IS DISTINCT FROM 'APPROVED' OR review."approvedRevision" IS DISTINCT FROM review."revision")`;
}

export function parseApprovalQueueCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!cursor || Object.keys(cursor).sort().join(",") !== "createdAt,id" || !Number.isSafeInteger(cursor.id) || cursor.id < 1 || cursor.id > 2147483647 ||
      typeof cursor.createdAt !== "string" || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw new Error();
    return cursor;
  } catch { throw new CreditApprovalError("INVALID_CURSOR", "Actualiza la bandeja para continuar."); }
}
export function approvalQueueLimit(value: unknown) {
  if (value === null || value === undefined || value === "") return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CreditApprovalError("INVALID_LIMIT", "Selecciona una página de hasta 100 créditos.");
  return limit;
}
export function approvalQueuePage<T extends { id: number; createdAt: Date | string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items.at(-1);
  return { items, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: new Date(last.createdAt).toISOString(), id: last.id })).toString("base64url") : null };
}
// The pending wall only exposes credits created after activation; a residual
// review row must not bring historical/imported credits into this access scope.
export function buildCreditApprovalQueueScopeSql(alias: string) {
  return `(${buildCreditApprovalRequiredSql(alias)}
    AND ${alias}."createdAt">=(SELECT "activatedAt" FROM "CreditApprovalPolicy" WHERE "id"=1)
    AND NOT (COALESCE(${alias}."equalityService",'')='IMPORTACION_MASIVA'
      AND COALESCE(${alias}."contratoSnapshot" #>> '{origen,tipo}','')='IMPORTACION_MASIVA'))`;
}
export async function listCreditApprovalQueue(db: NoveltyDatabase, input: CreditApprovalQueueInput = {}) {
  const policy = await db.$queryRawUnsafe<Array<{ id: number }>>('SELECT "id" FROM "CreditApprovalPolicy" WHERE "id"=1');
  if (!policy.length) throw new CreditApprovalError("APPROVAL_UNAVAILABLE", "La revisión de créditos no está disponible.", 503);
  const cursor = parseApprovalQueueCursor(input.cursor);
  const limit = approvalQueueLimit(input.limit);
  const search = approvalQueueSearch(input.q);
  const rows = await db.$queryRawUnsafe<Array<{ id: number; createdAt: Date }>>(`SELECT credit."id",credit."folio",credit."clienteDocumento",credit."clienteNombre",
    ally."nombre" AS "aliadoNombre",site."nombre" AS "sedeNombre",credit."fechaCredito",credit."createdAt",
    true AS required,'PENDING' AS status,COALESCE(review."revision",1) AS revision,
    CASE WHEN novelty."id" IS NULL THEN NULL ELSE json_build_object('id',novelty."id",'status',novelty."status",'version',novelty."version",
      'pendingCount',counts.pending,'answeredCount',counts.answered) END AS novelty,
    json_build_object('blocked',COALESCE(reissue."status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN'),false),'status',reissue."status") AS reissue
    FROM "Credito" credit JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    LEFT JOIN "CreditApprovalReview" review ON review."creditoId"=credit."id"
    LEFT JOIN "CreditApprovalNovelty" novelty ON novelty."creditoId"=credit."id" AND novelty."status"<>'RESOLVED'
    LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE i."status"='OPEN')::integer AS pending,
      COUNT(*) FILTER (WHERE i."status"='RESPONDED')::integer AS answered FROM "CreditApprovalNoveltyItem" i WHERE i."noveltyId"=novelty."id") counts ON true
    LEFT JOIN LATERAL (SELECT r."status" FROM "CreditApprovalReissue" r WHERE r."creditoId"=credit."id"
      ORDER BY CASE WHEN r."status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN') THEN 0 ELSE 1 END,r."requestedAt" DESC,r."id" DESC LIMIT 1) reissue ON true
    WHERE ${queueVisibleScopeSql()}
      AND ${queuePendingSql()}
      AND ($1::text IS NULL OR credit."clienteDocumento"=$1)
      ${search ? `AND ${queueSearchSql(5)}` : ""}
      AND ($2::timestamp IS NULL OR (credit."createdAt",credit."id")>($2::timestamp,$3::integer))
    ORDER BY credit."createdAt",credit."id" LIMIT $4::integer`, input.documento || null, cursor?.createdAt || null, cursor?.id || null, limit + 1, ...(search ? [search] : []));
  return approvalQueuePage(rows, limit);
}

type ApprovedCursor = { view: "approved"; approvedAt: string; id: number };
export function parseApprovedQueueCursor(value: string | null | undefined): ApprovedCursor | null {
  if (!value) return null;
  try {
    if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!cursor || Object.keys(cursor).sort().join(",") !== "approvedAt,id,view" || cursor.view !== "approved" ||
      !Number.isSafeInteger(cursor.id) || cursor.id < 1 || cursor.id > 2147483647 ||
      typeof cursor.approvedAt !== "string" || new Date(cursor.approvedAt).toISOString() !== cursor.approvedAt) throw new Error();
    return cursor;
  } catch { throw new CreditApprovalError("INVALID_CURSOR", "Actualiza la bandeja para continuar."); }
}
export function approvedQueuePage<T extends { id: number; approvedAt: Date | string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items.at(-1);
  return { items, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ view: "approved", approvedAt: new Date(last.approvedAt).toISOString(), id: last.id })).toString("base64url") : null };
}

export async function listApprovedCreditQueue(db: NoveltyDatabase, input: CreditApprovalQueueInput = {}) {
  const policy = await db.$queryRawUnsafe<Array<{ id: number }>>('SELECT "id" FROM "CreditApprovalPolicy" WHERE "id"=1');
  if (!policy.length) throw new CreditApprovalError("APPROVAL_UNAVAILABLE", "La revisión de créditos no está disponible.", 503);
  const cursor = parseApprovedQueueCursor(input.cursor);
  const limit = approvalQueueLimit(input.limit);
  const search = approvalQueueSearch(input.q);
  const rows = await db.$queryRawUnsafe<Array<{ id: number; approvedAt: Date }>>(`SELECT credit."id",credit."folio",credit."clienteDocumento",credit."clienteNombre",
    ally."nombre" AS "aliadoNombre",site."nombre" AS "sedeNombre",credit."fechaCredito",credit."createdAt",
    true AS required,'APPROVED' AS status,review."revision",review."approvedAt",review."approvedByName",
    EXISTS (SELECT 1 FROM "LiquidacionAliadoCredito" paid WHERE paid."creditoId"=credit."id") AS paid
    FROM "Credito" credit JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    JOIN "CreditApprovalReview" review ON review."creditoId"=credit."id"
    WHERE ${queueVisibleScopeSql()}
      AND ${buildCurrentCreditApprovalSql("credit", "review")}
      AND ($1::text IS NULL OR credit."clienteDocumento"=$1)
      ${search ? `AND ${queueSearchSql(5)}` : ""}
      AND ($2::timestamp IS NULL OR (review."approvedAt",credit."id")<($2::timestamp,$3::integer))
    ORDER BY review."approvedAt" DESC,credit."id" DESC LIMIT $4::integer`, input.documento || null, cursor?.approvedAt || null, cursor?.id || null, limit + 1, ...(search ? [search] : []));
  return approvedQueuePage(rows, limit);
}

/** Counts cover the complete filtered queues; cursor and page size never restrict them. */
export async function countCreditApprovalQueues(db: NoveltyDatabase, input: Pick<CreditApprovalQueueInput, "documento" | "q"> = {}) {
  const policy = await db.$queryRawUnsafe<Array<{ id: number }>>('SELECT "id" FROM "CreditApprovalPolicy" WHERE "id"=1');
  if (!policy.length) throw new CreditApprovalError("APPROVAL_UNAVAILABLE", "La revisión de créditos no está disponible.", 503);
  const search = approvalQueueSearch(input.q);
  const rows = await db.$queryRawUnsafe<Array<{ pending: number; approved: number }>>(`SELECT
    COUNT(*) FILTER (WHERE ${queuePendingSql()})::integer AS pending,
    COUNT(*) FILTER (WHERE ${buildCurrentCreditApprovalSql("credit", "review")})::integer AS approved
    FROM "Credito" credit JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    LEFT JOIN "CreditApprovalReview" review ON review."creditoId"=credit."id"
    WHERE ${queueVisibleScopeSql()}
      AND ($1::text IS NULL OR credit."clienteDocumento"=$1)
      ${search ? `AND ${queueSearchSql(2)}` : ""}`, input.documento || null, ...(search ? [search] : []));
  return rows[0] || { pending: 0, approved: 0 };
}
