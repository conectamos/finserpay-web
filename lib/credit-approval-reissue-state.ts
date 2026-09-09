import type { Prisma } from "@/app/generated/prisma/client";

export type ReissueDatabase = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export const REISSUE_BLOCKING_STATUSES = ["PREPARING", "DISPATCHING", "AWAITING_SIGNATURE", "UNCERTAIN"] as const;
export type CreditApprovalReissueStatus = typeof REISSUE_BLOCKING_STATUSES[number] | "COMPLETED" | "FAILED_SAFE";
export type CreditApprovalReissueState = {
  available: boolean;
  blocked: boolean;
  operation: null | {
    id: string; status: CreditApprovalReissueStatus; reason: string;
    requestedAt: string; lastCheckedAt: string | null; completedAt: string | null;
    canRefresh: boolean; message: string;
  };
};
export const EMPTY_CREDIT_APPROVAL_REISSUE_STATE: CreditApprovalReissueState = { available: true, blocked: false, operation: null };
const messages: Record<CreditApprovalReissueStatus, string> = {
  PREPARING: "Preparando la nueva solicitud de firma.",
  DISPATCHING: "La solicitud de firma se está enviando. No repitas el envío.",
  AWAITING_SIGNATURE: "El cliente debe completar la nueva firma. Después revisa el documento y confirma el OK.",
  COMPLETED: "La nueva firma está disponible. Revisa el documento antes de confirmar el OK.",
  FAILED_SAFE: "No se envió la solicitud. Puedes iniciar un nuevo intento.",
  UNCERTAIN: "No se pudo confirmar el resultado del envío. La liquidación sigue bloqueada; solicita revisión al administrador central.",
};
export async function getCreditApprovalReissueState(db: ReissueDatabase, creditoId: number): Promise<CreditApprovalReissueState> {
  const rows = await db.$queryRawUnsafe<Array<{
    id: string; status: CreditApprovalReissueStatus; reason: string; requestedAt: Date;
    lastCheckedAt: Date | null; completedAt: Date | null; newProcessUuid: string | null;
  }>>(`SELECT "id"::text, "status", "reason", "requestedAt", "lastCheckedAt", "completedAt", "newProcessUuid"
    FROM "CreditApprovalReissue" WHERE "creditoId" = $1
    ORDER BY CASE WHEN "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN') THEN 0 ELSE 1 END,
      "requestedAt" DESC, "id" DESC LIMIT 1`, creditoId);
  const row = rows[0];
  if (!row) return { ...EMPTY_CREDIT_APPROVAL_REISSUE_STATE };
  const blocked = (REISSUE_BLOCKING_STATUSES as readonly string[]).includes(row.status);
  return {
    available: !blocked, blocked,
    operation: {
      id: row.id, status: row.status, reason: row.reason,
      requestedAt: new Date(row.requestedAt).toISOString(),
      lastCheckedAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
      completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
      canRefresh: blocked && (Boolean(row.newProcessUuid) || row.status === "PREPARING" || row.status === "DISPATCHING"),
      message: messages[row.status] || "Solicita revisión al administrador central.",
    },
  };
}
