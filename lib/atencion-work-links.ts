import type { AttentionWorkDetail } from "./atencion-work-types";

/** Only the nominal manager's exact, canonical linked credit may open the wall. */
export function attentionWelcomeCreditWallHref(detail: AttentionWorkDetail): string | null {
  if (!detail.canManage || detail.item.kind !== "welcome") return null;
  const creditId = /^C-([1-9]\d{0,15})$/.exec(detail.item.target)?.[1];
  if (!creditId || !Number.isSafeInteger(Number(creditId))) return null;
  const href = `/dashboard/aprobaciones?credito=${creditId}`;
  const workId = detail.item.id;
  if (!isWelcomeChatWorkId(workId)) return null;
  return detail.operationHref === href ? `${href}&solicitud=${encodeURIComponent(workId)}` : null;
}

/** Query identifiers select a case, never confer access to it. The detail API revalidates scope. */
export function isWelcomeChatWorkId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
