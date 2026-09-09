import { CreditApprovalError } from "@/lib/credit-approval-errors";
import type { ApprovalActor } from "@/lib/credit-approval-actor";
import { appendNoveltyEvent, EMPTY_CREDIT_APPROVAL_NOVELTY_STATE, noveltyIso, noveltyLabel,
  type CreditApprovalNoveltyState, type NoveltyDatabase, type NoveltyItem, type NoveltyStatus } from "@/lib/credit-approval-novelty-core";
export type { CreditApprovalNoveltyState } from "@/lib/credit-approval-novelty-core";
export { EMPTY_CREDIT_APPROVAL_NOVELTY_STATE } from "@/lib/credit-approval-novelty-core";

type CaseRow = { id: string; status: NoveltyStatus; version: number };
export async function getCreditApprovalNoveltyState(db: NoveltyDatabase, creditId: number): Promise<CreditApprovalNoveltyState> {
  const cases = await db.$queryRawUnsafe<CaseRow[]>(`SELECT "id"::text,"status","version" FROM "CreditApprovalNovelty"
    WHERE "creditoId"=$1 ORDER BY CASE WHEN "status"<>'RESOLVED' THEN 0 ELSE 1 END,"createdAt" DESC,"id" DESC LIMIT 1`, creditId);
  const current = cases[0];
  if (!current) return { ...EMPTY_CREDIT_APPROVAL_NOVELTY_STATE };
  const rows = await db.$queryRawUnsafe<Array<Omit<NoveltyItem, "label" | "openedAt" | "respondedAt"> & { openedAt: Date; respondedAt: Date | null }>>(
    `SELECT "id"::text,"key","status","version","reason","openedAt","respondedAt","responseText","responsePhotoHash"
      FROM "CreditApprovalNoveltyItem" WHERE "noveltyId"=$1::uuid ORDER BY "openedAt","id"`, current.id);
  const items = rows.map(row => ({ ...row, label: noveltyLabel(row.key), openedAt: noveltyIso(row.openedAt)!, respondedAt: noveltyIso(row.respondedAt) }));
  const pendingCount = items.filter(item => item.status === "OPEN").length;
  const answeredCount = items.length - pendingCount;
  return { available: true, blocksApproval: current.status !== "RESOLVED" && (pendingCount > 0 || !items.length),
    blocksSettlement: current.status !== "RESOLVED", pendingCount, answeredCount,
    novelty: { ...current, pendingCount, answeredCount, items } };
}

/** Caller already holds Credit then Review locks and has validated the current review. */
export async function resolveCreditApprovalNoveltyForApproval(db: NoveltyDatabase, creditId: number, actor: ApprovalActor) {
  const cases = await db.$queryRawUnsafe<CaseRow[]>(`SELECT "id"::text,"status","version" FROM "CreditApprovalNovelty"
    WHERE "creditoId"=$1 AND "status"<>'RESOLVED' FOR UPDATE`, creditId);
  if (!cases[0]) return false;
  const current = cases[0];
  const items = await db.$queryRawUnsafe<Array<{ id: string; status: string }>>(
    'SELECT "id"::text,"status" FROM "CreditApprovalNoveltyItem" WHERE "noveltyId"=$1::uuid ORDER BY "id" FOR UPDATE', current.id);
  if (current.status !== "RESPONDED" || !items.length || items.some(item => item.status !== "RESPONDED")) {
    throw new CreditApprovalError("NOVELTY_PENDING", "Aún hay novedades sin responder. Revisa cada fotografía o respuesta pendiente antes del OK.", 409);
  }
  await db.$executeRawUnsafe(`UPDATE "CreditApprovalNovelty" SET "status"='RESOLVED',"resolvedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
    "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',"version"="version"+1 WHERE "id"=$1::uuid`, current.id);
  await appendNoveltyEvent(db, { noveltyId: current.id, type: "APPROVED_RESOLVED", actor, payload: { itemIds: items.map(item => item.id) } });
  return true;
}

/** Photo correction and this transition share the same Credit-locked transaction. */
export async function markNoveltyPhotoCorrected(db: NoveltyDatabase, creditId: number, key: string, sha256: string, actor: ApprovalActor) {
  const cases = await db.$queryRawUnsafe<CaseRow[]>(`SELECT "id"::text,"status","version" FROM "CreditApprovalNovelty"
    WHERE "creditoId"=$1 AND "status"<>'RESOLVED' FOR UPDATE`, creditId);
  if (!cases[0]) return false;
  const items = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id"::text FROM "CreditApprovalNoveltyItem"
    WHERE "noveltyId"=$1::uuid AND "key"=$2 AND "status"='OPEN' FOR UPDATE`, cases[0].id, key);
  if (!items[0] || key === "GENERAL") return false;
  await db.$executeRawUnsafe(`UPDATE "CreditApprovalNoveltyItem" SET "status"='RESPONDED',"responsePhotoHash"=$2,
    "responseText"='Fotografía actualizada durante revisión',"respondedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id"=$1::uuid`, items[0].id, sha256);
  await appendNoveltyEvent(db, { noveltyId: cases[0].id, itemId: items[0].id, type: "PHOTO_RESPONDED", actor,
    payload: { key, nextSha256: sha256, text: "Fotografía actualizada durante revisión" } });
  return true;
}
