import "server-only";
import type { Prisma } from "@/app/generated/prisma/client";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { queuePendingSql, queueVisibleScopeSql } from "@/lib/credit-approval-queue";

type WelcomeAlertsDatabase = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;
export type ApprovalWelcomeAlerts = {
  pendingCount: number;
  attentionCount: number;
  fingerprint: string;
  href: "/dashboard/aprobaciones";
};

/** A fixed-size, read-only summary of the complete pending wall, independent of its filters or pagination. */
export async function getApprovalWelcomeAlerts(db: WelcomeAlertsDatabase): Promise<ApprovalWelcomeAlerts> {
  const policy = await db.$queryRawUnsafe<Array<{ id: number }>>('SELECT "id" FROM "CreditApprovalPolicy" WHERE "id"=1');
  if (!policy.length) throw new CreditApprovalError("APPROVAL_UNAVAILABLE", "La revisión de créditos no está disponible.", 503);

  const rows = await db.$queryRawUnsafe<Array<Omit<ApprovalWelcomeAlerts, "href">>>(`WITH pending AS (
    SELECT credit."id",COALESCE(review."revision",1) AS revision,
      COALESCE(responses.versions,'') AS response_versions,
      (novelty."id" IS NULL OR responses.versions IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM "CreditApprovalReissue" reissue
          WHERE reissue."creditoId"=credit."id"
            AND reissue."status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN')) AS actionable
    FROM "Credito" credit JOIN "Sede" site ON site."id"=credit."sedeId"
    JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    LEFT JOIN "CreditApprovalReview" review ON review."creditoId"=credit."id"
    LEFT JOIN "CreditApprovalNovelty" novelty ON novelty."creditoId"=credit."id" AND novelty."status"<>'RESOLVED'
    LEFT JOIN LATERAL (
      SELECT STRING_AGG(item."id"::text||':'||item."version"::text||':'||item."status",',' ORDER BY item."id") AS versions
      FROM "CreditApprovalNoveltyItem" item
      WHERE item."noveltyId"=novelty."id" AND item."status" IN ('RESPONDED','VERIFIED')
    ) responses ON true
    WHERE ${queueVisibleScopeSql()} AND ${queuePendingSql()}
  ) SELECT COUNT(*)::integer AS "pendingCount",
    COUNT(*) FILTER (WHERE actionable)::integer AS "attentionCount",
    MD5(COALESCE(STRING_AGG("id"::text||':'||revision::text||':'||response_versions,'|' ORDER BY "id")
      FILTER (WHERE actionable),'')) AS fingerprint FROM pending`);

  const summary = rows[0];
  if (!summary || !Number.isSafeInteger(summary.pendingCount) || summary.pendingCount < 0
    || !Number.isSafeInteger(summary.attentionCount) || summary.attentionCount < 0
    || summary.attentionCount > summary.pendingCount || !/^[a-f0-9]{32}$/.test(summary.fingerprint)) {
    throw new CreditApprovalError("APPROVAL_UNAVAILABLE", "No se pudieron verificar las bienvenidas pendientes.", 503);
  }
  return { ...summary, href: "/dashboard/aprobaciones" };
}
