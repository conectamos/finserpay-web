import { buildVeriffRetryPolicy } from "@/lib/veriff-retry-policy-core";
export {
  buildVeriffRetryPolicy,
  MAX_VERIFF_DECLINED_ATTEMPTS,
} from "@/lib/veriff-retry-policy-core";
export type { VeriffRetryPolicy } from "@/lib/veriff-retry-policy-core";
import prisma from "@/lib/prisma";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
import {
  ensureVeriffSchema,
  serializeVeriffValidation,
  type VeriffValidationRow,
} from "@/lib/veriff-storage";

type DeclinedCountRow = {
  count: bigint | number | string;
};

export async function getVeriffRetryPolicy(draftId: number | null | undefined) {
  if (!draftId) {
    return buildVeriffRetryPolicy(0);
  }

  await Promise.all([ensureSolicitudSchema(), ensureVeriffSchema()]);
  const rows = await prisma.$queryRawUnsafe<DeclinedCountRow[]>(
    `
      SELECT COUNT(*)::bigint AS "count"
      FROM "VeriffIdentityValidation"
      WHERE "draftId" = $1
        AND "status" = 'DECLINED'
    `,
    draftId
  );

  return buildVeriffRetryPolicy(Number(rows[0]?.count || 0));
}

export async function enforceVeriffRetryPolicy(
  row: VeriffValidationRow | null
) {
  const serialized = serializeVeriffValidation(row);
  const retryPolicy = await getVeriffRetryPolicy(row?.draftId);

  if (
    row?.draftId &&
    serialized?.status === "DECLINED" &&
    retryPolicy.applicationRejected
  ) {
    await prisma.$executeRawUnsafe(
      `
        UPDATE "CreditoBorrador"
        SET "estado" = 'CERRADO',
            "closedReason" = 'RECHAZADA',
            "closedAt" = COALESCE("closedAt", CURRENT_TIMESTAMP),
            "payload" = COALESCE("payload", '{}'::jsonb) || jsonb_build_object(
              'veriffStatus', 'DECLINED',
              'veriffDeclinedAttempts', $2::integer,
              'veriffRejectedAt', CURRENT_TIMESTAMP
            ),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
          AND "estado" = 'ABIERTO'
          AND "creditoId" IS NULL
      `,
      row.draftId,
      retryPolicy.declinedAttempts
    );
  }

  return retryPolicy;
}
