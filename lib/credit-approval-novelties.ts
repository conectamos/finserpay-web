import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getCreditApprovalDetail, approvalImage } from "@/lib/credit-approval";
import { assertApprovalActorActive, assertApprovalActorCreditAccess, approvalActorAudit, type ApprovalActor } from "@/lib/credit-approval-actor";
import { sanitizeIphoneDeliveryEvidenceDataUrl } from "@/lib/iphone-delivery-evidence";
import { correctedEvidenceSnapshot, evidenceSha256 } from "@/lib/credit-approval-evidence-history";
import { getCreditApprovalReissueState } from "@/lib/credit-approval-reissue-state";
import { getCreditApprovalNoveltyState } from "@/lib/credit-approval-novelty-state";
import { buildCreditApprovalQueueScopeSql, approvalQueueLimit, approvalQueuePage, parseApprovalQueueCursor } from "@/lib/credit-approval-queue";
import { NOVELTY_PHOTOS, appendNoveltyEvent, noveltyError, noveltyText, noveltyUuidPattern,
  type NoveltyDatabase, type NoveltyItem, type NoveltyKey } from "@/lib/credit-approval-novelty-core";

export type PendingAllyActor = { id: number; nombre: string; aliadoId: number };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const requestHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function uuid(value: unknown) {
  if (typeof value !== "string" || !noveltyUuidPattern.test(value)) noveltyError("Actualiza la novedad antes de continuar.", "INVALID_NOVELTY", 400);
  return value;
}
function positiveVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) noveltyError("Actualiza la versión de la novedad.", "INVALID_NOVELTY", 400);
  return value;
}
function exactKeys(body: Record<string, unknown>, expected: string[]) {
  if (Object.keys(body).sort().join(",") !== [...expected].sort().join(",")) noveltyError("La solicitud contiene campos no permitidos.", "INVALID_NOVELTY", 400);
}
export function parseCreateNovelty(value: unknown) {
  const body = record(value);
  exactKeys(body, ["keys", "reason", "revision", "reviewHash", "idempotencyKey"]);
  if (!Array.isArray(body.keys) || body.keys.length > 5 || body.keys.some(key => !NOVELTY_PHOTOS.some(photo => photo.key === key)) || new Set(body.keys).size !== body.keys.length) {
    noveltyError("Selecciona las fotografías exactas o registra una novedad general.", "INVALID_NOVELTY", 400);
  }
  if (typeof body.reviewHash !== "string" || !/^[a-f0-9]{64}$/.test(body.reviewHash)) noveltyError("Actualiza el expediente.", "INVALID_NOVELTY", 400);
  return { keys: (body.keys.length ? [...body.keys].sort() : ["GENERAL"]) as NoveltyKey[], reason: noveltyText(body.reason, 1000),
    revision: positiveVersion(body.revision), reviewHash: body.reviewHash, idempotencyKey: uuid(body.idempotencyKey) };
}
export function parseNoveltyResponse(value: unknown, photo: boolean) {
  const body = record(value);
  exactKeys(body, ["noveltyId", "itemId", "expectedVersion", "idempotencyKey", ...(photo ? ["dataUrl", "expectedPhotoHash"] : ["text"])]);
  const common = { noveltyId: uuid(body.noveltyId), itemId: uuid(body.itemId), expectedVersion: positiveVersion(body.expectedVersion), idempotencyKey: uuid(body.idempotencyKey) };
  if (!photo) return { ...common, action: "GENERAL" as const, text: noveltyText(body.text, 2000) };
  if (typeof body.dataUrl !== "string" || (body.expectedPhotoHash !== null && (typeof body.expectedPhotoHash !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedPhotoHash)))) {
    noveltyError("Selecciona una fotografía PNG o JPEG y actualiza la novedad.", "INVALID_NOVELTY", 400);
  }
  return { ...common, action: "PHOTO" as const, dataUrl: body.dataUrl, expectedPhotoHash: body.expectedPhotoHash as string | null };
}
export async function prepareNoveltyResponse(value: unknown, photo: boolean) {
  const parsed = parseNoveltyResponse(value, photo);
  if (parsed.action === "GENERAL") return parsed;
  const dataUrl = await sanitizeIphoneDeliveryEvidenceDataUrl(parsed.dataUrl);
  if (!dataUrl) noveltyError("La fotografía debe ser PNG o JPEG válida y estar dentro del tamaño permitido.", "INVALID_EVIDENCE", 400);
  return { ...parsed, dataUrl };
}
async function lockCreditReview(db: NoveltyDatabase, creditId: number) {
  const rows = await db.$queryRawUnsafe<Array<{ id: number }>>('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE', creditId);
  if (!rows.length) noveltyError("Crédito no encontrado.", "CREDIT_NOT_FOUND", 404);
  const reviews = await db.$queryRawUnsafe<Array<{ revision: number }>>('SELECT "revision" FROM "CreditApprovalReview" WHERE "creditoId"=$1 FOR UPDATE', creditId);
  if (!reviews.length) noveltyError("Este crédito no tiene una revisión activa.", "NOVELTY_NOT_ALLOWED");
  return reviews[0];
}
type Header = { id: number; folio: string; clienteNombre: string; clienteDocumento: string | null; aliadoNombre: string; sedeNombre: string; fechaCredito: Date; createdAt: Date; required: boolean; paid: boolean; estado: string };
async function readHeader(db: NoveltyDatabase, creditId: number, actor?: PendingAllyActor) {
  await requireNoveltyPolicy(db);
  const rows = await db.$queryRawUnsafe<Header[]>(`SELECT credit."id",credit."folio",credit."clienteNombre",credit."clienteDocumento",
    ally."nombre" AS "aliadoNombre",site."nombre" AS "sedeNombre",credit."fechaCredito",credit."createdAt",credit."estado",
    ${buildCreditApprovalQueueScopeSql("credit")} AS required,
    EXISTS(SELECT 1 FROM "LiquidacionAliadoCredito" WHERE "creditoId"=credit."id") AS paid
    FROM "Credito" credit JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    WHERE credit."id"=$1 AND UPPER(BTRIM(COALESCE(ally."codigo",'')))<>'FINSERPAY'
      AND ($2::integer IS NULL OR (ally."id"=$2 AND EXISTS (SELECT 1 FROM "Usuario" account
        JOIN "Rol" role ON role."id"=account."rolId" JOIN "Sede" actor_site ON actor_site."id"=account."sedeId"
        WHERE account."id"=$3 AND account."activo" AND UPPER(BTRIM(role."nombre"))='ADMIN'
          AND actor_site."aliadoId"=$2 AND actor_site."activa" AND ally."activo")))`, creditId, actor?.aliadoId || null, actor?.id || null);
  if (!rows[0]) noveltyError("Crédito no encontrado.", "CREDIT_NOT_FOUND", 404);
  return rows[0];
}
function editableReason(credit: Header, blocked: boolean) {
  return !credit.required ? "Este crédito conserva sus reglas anteriores." : credit.paid ? "El crédito ya fue liquidado."
    : ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(credit.estado.trim().toUpperCase()) ? "El crédito está anulado o cancelado."
    : blocked ? "La firma está pendiente de verificación. Actualiza el expediente cuando finalice." : null;
}
async function previousRequest(db: NoveltyDatabase, creditId: number, key: string, hash: string, actor: ApprovalActor) {
  const rows = await db.$queryRawUnsafe<Array<{ creditoId: number; requestHash: string; actorKind: string; actorUserId: number | null; actorGrantId: string | null; actorSessionId: string | null }>>(
    `SELECT novelty."creditoId",event."requestHash",event."actorKind",event."actorUserId",event."actorGrantId"::text,event."actorSessionId"::text
      FROM "CreditApprovalNoveltyEvent" event JOIN "CreditApprovalNovelty" novelty ON novelty."id"=event."noveltyId" WHERE event."requestKey"=$1::uuid`, key);
  if (!rows[0]) return false;
  const saved = rows[0];
  const audit = approvalActorAudit(actor);
  if (saved.creditoId !== creditId || saved.requestHash !== hash || saved.actorKind !== audit.actorKind || saved.actorUserId !== audit.actorUserId ||
    saved.actorGrantId !== audit.actorGrantId || saved.actorSessionId !== audit.actorSessionId) noveltyError("Esta confirmación corresponde a otra operación.", "IDEMPOTENCY_CONFLICT");
  return true;
}
export async function createCreditApprovalNovelty(db: NoveltyDatabase, creditId: number, input: ReturnType<typeof parseCreateNovelty>, actor: ApprovalActor) {
  await assertApprovalActorActive(db, actor);
  await lockCreditReview(db, creditId);
  await assertApprovalActorCreditAccess(db, creditId, actor);
  const credit = await readHeader(db, creditId);
  const hash = requestHash({ creditId, ...input });
  if (await previousRequest(db, creditId, input.idempotencyKey, hash, actor)) return { unchanged: true };
  const blocked = editableReason(credit, false);
  if (blocked) noveltyError(blocked, "NOVELTY_NOT_ALLOWED");
  const detail = await getCreditApprovalDetail(db, creditId);
  if (!detail.capabilities.canCorrectEvidence) noveltyError(detail.capabilities.correctionBlockedReason || "No se permiten novedades en este crédito.", "NOVELTY_NOT_ALLOWED");
  if (input.revision !== detail.review.revision || input.reviewHash !== detail.review.reviewHash) noveltyError("El expediente cambió. Actualízalo antes de registrar la novedad.", "REVIEW_CHANGED");
  const cases = await db.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id"::text FROM "CreditApprovalNovelty" WHERE "creditoId"=$1 AND "status"<>\'RESOLVED\' FOR UPDATE', creditId);
  const noveltyId = cases[0]?.id || randomUUID();
  if (!cases[0]) await db.$executeRawUnsafe('INSERT INTO "CreditApprovalNovelty" ("id","creditoId") VALUES ($1::uuid,$2)', noveltyId, creditId);
  const previousItems = await db.$queryRawUnsafe<NoveltyItem[]>('SELECT * FROM "CreditApprovalNoveltyItem" WHERE "noveltyId"=$1::uuid ORDER BY "id" FOR UPDATE', noveltyId);
  const changes: Record<string, unknown>[] = [];
  for (const key of input.keys) {
    const previous = previousItems.find(item => item.key === key);
    const itemId = previous?.id || randomUUID();
    if (previous) {
      await db.$executeRawUnsafe(`UPDATE "CreditApprovalNoveltyItem" SET "status"='OPEN',"reason"=$2,"openedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
        "respondedAt"=NULL,"responseText"=NULL,"responsePhotoHash"=NULL WHERE "id"=$1::uuid`, itemId, input.reason);
    } else await db.$executeRawUnsafe('INSERT INTO "CreditApprovalNoveltyItem" ("id","noveltyId","key","reason") VALUES ($1::uuid,$2::uuid,$3,$4)', itemId, noveltyId, key, input.reason);
    changes.push({ itemId, key, reason: input.reason, previousReason: previous?.reason || null, previousStatus: previous?.status || null,
      previousResponse: previous?.responseText || null, previousPhotoHash: previous?.responsePhotoHash || null });
  }
  await appendNoveltyEvent(db, { noveltyId, type: "REPORTED", actor, payload: { changes, reviewRevision: input.revision }, requestKey: input.idempotencyKey, requestHash: hash });
  return { unchanged: false };
}
export async function getCreditApprovalNoveltyHistory(db: NoveltyDatabase, creditId: number) {
  await readHeader(db, creditId);
  const events = await db.$queryRawUnsafe<Array<{ id: string; type: string; actorKind: string; actorName: string; createdAt: Date; payload: Record<string, unknown> }>>(`SELECT event."id"::text,event."type",event."actorKind",event."actorName",event."createdAt",event."payload"
    FROM "CreditApprovalNoveltyEvent" event JOIN "CreditApprovalNovelty" novelty ON novelty."id"=event."noveltyId"
    WHERE novelty."creditoId"=$1 ORDER BY event."createdAt" DESC,event."id" DESC LIMIT 100`, creditId);
  return { state: await getCreditApprovalNoveltyState(db, creditId), history: events.map(event => {
    const payload = { ...record(event.payload) }; delete payload.previousDataUrl;
    return { ...event, payload };
  }) };
}
export async function getPendingAllyCredit(db: NoveltyDatabase, creditId: number, actor: PendingAllyActor) {
  const credit = await readHeader(db, creditId, actor);
  const state = await getCreditApprovalNoveltyState(db, creditId);
  if (!state.novelty || state.novelty.status === "RESOLVED") noveltyError("El crédito no tiene novedades pendientes.", "NOVELTY_NOT_FOUND", 404);
  const reissue = await getCreditApprovalReissueState(db, creditId);
  const blockedReason = editableReason(credit, reissue.blocked || !reissue.available) || (state.novelty.status === "RESPONDED" ? "La respuesta ya está guardada y pendiente de revisión del analista." : null);
  const photoKeys = state.novelty.items.filter(item => item.key !== "GENERAL").map(item => item.key);
  const photos = photoKeys.length ? await db.$queryRawUnsafe<Array<Record<string, string | null>>>(
    `SELECT ${NOVELTY_PHOTOS.filter(photo => photoKeys.includes(photo.key)).map(photo => `"${photo.field}"`).join(",")} FROM "Credito" WHERE "id"=$1`, creditId) : [];
  const items = state.novelty.items.map(item => {
    const config = NOVELTY_PHOTOS.find(photo => photo.key === item.key);
    if (!config) return item;
    const dataUrl = photos[0]?.[config.field] || null;
    const sha256 = evidenceSha256(dataUrl);
    return { ...item, evidence: { available: Boolean(approvalImage(dataUrl)), sha256,
      href: `/api/pendientes/${creditId}/evidencias?tipo=${item.key}${sha256 ? `&v=${sha256}` : ""}` } };
  });
  return { id: credit.id, folio: credit.folio, clienteNombre: credit.clienteNombre, clienteDocumento: credit.clienteDocumento,
    aliadoNombre: credit.aliadoNombre, sedeNombre: credit.sedeNombre, fechaCredito: credit.fechaCredito,
    novelty: { ...state.novelty, items }, canRespond: !blockedReason && state.pendingCount > 0, blockedReason };
}
async function requireNoveltyPolicy(db: NoveltyDatabase) {
  const rows = await db.$queryRawUnsafe<Array<{ id: number }>>('SELECT "id" FROM "CreditApprovalPolicy" WHERE "id"=1');
  if (!rows.length) noveltyError("La revisión de créditos no está disponible.", "APPROVAL_UNAVAILABLE", 503);
}
export async function listPendingAllyCredits(db: NoveltyDatabase, actor: PendingAllyActor, input: { cursor?: string | null; limit?: unknown; status?: string | null } = {}) {
  await requireNoveltyPolicy(db);
  const cursor = parseApprovalQueueCursor(input.cursor);
  const limit = approvalQueueLimit(input.limit);
  if (input.status && !["WAITING_ALLY", "RESPONDED"].includes(input.status)) noveltyError("Estado de novedad no válido.", "INVALID_NOVELTY", 400);
  const rows = await db.$queryRawUnsafe<Array<Header>>(`SELECT credit."id",credit."folio",credit."clienteNombre",credit."clienteDocumento",credit."fechaCredito",credit."createdAt",
    ally."nombre" AS "aliadoNombre",site."nombre" AS "sedeNombre",json_build_object('id',novelty."id",'status',novelty."status",'version',novelty."version",
    'pendingCount',counts.pending,'answeredCount',counts.answered) AS novelty
    FROM "Credito" credit JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    JOIN "CreditApprovalNovelty" novelty ON novelty."creditoId"=credit."id" AND novelty."status"<>'RESOLVED'
    CROSS JOIN LATERAL (SELECT COUNT(*) FILTER(WHERE "status"='OPEN')::integer AS pending,COUNT(*) FILTER(WHERE "status"='RESPONDED')::integer AS answered FROM "CreditApprovalNoveltyItem" WHERE "noveltyId"=novelty."id") counts
    WHERE ally."id"=$1 AND UPPER(BTRIM(COALESCE(ally."codigo",'')))<>'FINSERPAY' AND ally."activo"
      AND EXISTS (SELECT 1 FROM "Usuario" account JOIN "Rol" role ON role."id"=account."rolId" JOIN "Sede" actor_site ON actor_site."id"=account."sedeId"
        WHERE account."id"=$2 AND account."activo" AND UPPER(BTRIM(role."nombre"))='ADMIN' AND actor_site."aliadoId"=$1 AND actor_site."activa")
      AND ${buildCreditApprovalQueueScopeSql("credit")} AND EXISTS(SELECT 1 FROM "CreditApprovalPolicy" WHERE "id"=1)
      AND UPPER(BTRIM(COALESCE(credit."estado",''))) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA')
      AND NOT EXISTS(SELECT 1 FROM "LiquidacionAliadoCredito" WHERE "creditoId"=credit."id")
      AND ($3::text IS NULL OR novelty."status"=$3)
      AND ($4::timestamp IS NULL OR (credit."createdAt",credit."id")>($4::timestamp,$5::integer))
    ORDER BY credit."createdAt",credit."id" LIMIT $6::integer`, actor.aliadoId, actor.id, input.status || null, cursor?.createdAt || null, cursor?.id || null, limit + 1);
  return approvalQueuePage(rows, limit);
}
export async function getPendingAllyEvidence(db: NoveltyDatabase, creditId: number, key: string, actor: PendingAllyActor) {
  await readHeader(db, creditId, actor);
  const state = await getCreditApprovalNoveltyState(db, creditId);
  const config = NOVELTY_PHOTOS.find(photo => photo.key === key);
  if (!config || !state.novelty || state.novelty.status === "RESOLVED" || !state.novelty.items.some(item => item.key === key)) noveltyError("Fotografía no disponible.", "EVIDENCE_NOT_FOUND", 404);
  const rows = await db.$queryRawUnsafe<Array<{ value: string | null }>>(`SELECT "${config.field}" AS value FROM "Credito" WHERE "id"=$1`, creditId);
  const image = approvalImage(rows[0]?.value || null);
  if (!image) noveltyError("Fotografía no disponible.", "EVIDENCE_NOT_FOUND", 404);
  return image;
}
export async function respondCreditApprovalNovelty(db: NoveltyDatabase, creditId: number, input: Awaited<ReturnType<typeof prepareNoveltyResponse>>, actor: PendingAllyActor) {
  await lockCreditReview(db, creditId);
  const credit = await readHeader(db, creditId, actor); // Fresh scope after waiting on the credit lock.
  const hash = requestHash({ creditId, ...input });
  if (await previousRequest(db, creditId, input.idempotencyKey, hash, actor)) return { unchanged: true };
  const reissue = await getCreditApprovalReissueState(db, creditId);
  const blocked = editableReason(credit, reissue.blocked || !reissue.available);
  if (blocked) noveltyError(blocked, "NOVELTY_NOT_ALLOWED");
  const cases = await db.$queryRawUnsafe<Array<{ id: string; status: string }>>('SELECT "id"::text,"status" FROM "CreditApprovalNovelty" WHERE "creditoId"=$1 AND "id"=$2::uuid AND "status"<>\'RESOLVED\' FOR UPDATE', creditId, input.noveltyId);
  if (!cases[0]) noveltyError("La novedad cambió o ya fue resuelta.");
  const items = await db.$queryRawUnsafe<NoveltyItem[]>('SELECT * FROM "CreditApprovalNoveltyItem" WHERE "id"=$1::uuid AND "noveltyId"=$2::uuid FOR UPDATE', input.itemId, input.noveltyId);
  const item = items[0];
  if (!item || item.status !== "OPEN" || item.version !== input.expectedVersion) noveltyError("La novedad cambió. Revisa su estado antes de responder.");
  if ((item.key === "GENERAL") !== (input.action === "GENERAL")) noveltyError("Solo puedes responder la fotografía o novedad señalada.", "NOVELTY_NOT_ALLOWED");
  if (input.action === "GENERAL") {
    await db.$executeRawUnsafe(`UPDATE "CreditApprovalNoveltyItem" SET "status"='RESPONDED',"responseText"=$2,
      "respondedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id"=$1::uuid`, item.id, input.text);
    await appendNoveltyEvent(db, { noveltyId: input.noveltyId, itemId: item.id, type: "GENERAL_RESPONDED", actor,
      payload: { key: "GENERAL", text: input.text, itemVersion: item.version }, requestKey: input.idempotencyKey, requestHash: hash });
  } else {
    const config = NOVELTY_PHOTOS.find(photo => photo.key === item.key);
    if (!config) noveltyError("Fotografía no permitida.", "INVALID_EVIDENCE", 400);
    const photos = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT "contratoSnapshot",${NOVELTY_PHOTOS.map(photo => `"${photo.field}"`).join(",")} FROM "Credito" WHERE "id"=$1`, creditId);
    const current = photos[0];
    const previousDataUrl = (current[config.field] as string | null) || null;
    const previousSha256 = evidenceSha256(previousDataUrl);
    if (previousSha256 !== input.expectedPhotoHash) noveltyError("La fotografía cambió. Actualiza y revisa la imagen vigente.", "REVIEW_CHANGED");
    const nextSha256 = evidenceSha256(input.dataUrl)!;
    if (previousSha256 === nextSha256) return { unchanged: true };
    if (NOVELTY_PHOTOS.slice(0, 3).some(photo => photo.key === item.key) && NOVELTY_PHOTOS.slice(0, 3).some(photo => photo.key !== item.key && evidenceSha256(current[photo.field] as string | null) === nextSha256)) {
      noveltyError("Las fotos de la cédula y la selfie deben ser imágenes diferentes.", "DUPLICATE_IDENTITY_EVIDENCE", 400);
    }
    const snapshot = correctedEvidenceSnapshot(current.contratoSnapshot, { key: item.key, field: config.field, previousSha256, nextSha256,
      correctedAt: new Date().toISOString(), actor, source: "CORRECCION_ALIADO_NOVEDAD" });
    await db.$executeRawUnsafe(`UPDATE "Credito" SET "${config.field}"=$2,"contratoSnapshot"=$3::jsonb,"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id"=$1`, creditId, input.dataUrl, JSON.stringify(snapshot));
    await db.$executeRawUnsafe(`UPDATE "CreditApprovalNoveltyItem" SET "status"='RESPONDED',"responsePhotoHash"=$2,
      "respondedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id"=$1::uuid`, item.id, nextSha256);
    await appendNoveltyEvent(db, { noveltyId: input.noveltyId, itemId: item.id, type: "PHOTO_RESPONDED", actor,
      payload: { key: item.key, previousDataUrl, previousSha256, nextSha256, itemVersion: item.version }, requestKey: input.idempotencyKey, requestHash: hash });
  }
  return { unchanged: false };
}
