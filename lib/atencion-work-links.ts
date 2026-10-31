import type { AttentionWorkDetail } from "./atencion-work-types";

/** Only the nominal manager's exact, canonical linked credit may open the wall. */
export function attentionWelcomeCreditWallHref(detail: AttentionWorkDetail): string | null {
  if (!detail.canManage || detail.item.kind !== "welcome") return null;
  const creditId = /^C-([1-9]\d{0,15})$/.exec(detail.item.target)?.[1];
  if (!creditId || !Number.isSafeInteger(Number(creditId))) return null;
  const href = `/dashboard/aprobaciones?credito=${creditId}`;
  return detail.operationHref === href ? href : null;
}
