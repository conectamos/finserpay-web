import type { Prisma } from "@/app/generated/prisma/client";

/** Must be called under the solicitud operation lock, before changing its audit or flags. */
export async function isCurrentDraftCorrectionProcess(
  database: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  draftId: number,
  processUuid: string,
) {
  const rows = await database.$queryRawUnsafe<Array<{ processUuid: string }>>(
    `SELECT process."processUuid" FROM "FirmaSeguroProcess" process
     JOIN "CreditoBorrador" draft ON draft."id"=process."draftId"
     WHERE process."draftId"=$1 AND process."creditoId" IS NULL
       AND process."supersededAt" IS NULL AND draft."estado"='ABIERTO'
       AND draft."creditoId" IS NULL
       AND COALESCE(draft."expiresAt",draft."createdAt"+INTERVAL '15 days') > CURRENT_TIMESTAMP
     ORDER BY process."createdAt" DESC,process."id" DESC LIMIT 1`, draftId);
  return rows[0]?.processUuid === processUuid;
}
