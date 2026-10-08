import "server-only";
import prisma from "@/lib/prisma";
import { lockSolicitudOperationMutation, type FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";
import { correctionRecord, requestDataValues } from "@/lib/approval-request-correction-core";
import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { isFirmaSeguroVerifiedCompletedStatus } from "@/lib/firmaseguro-status";

/** A receipt is not a signature: clear the gate only with the verified new PDF. */
export async function completeDraftClientCorrection(process: FirmaSeguroProcessRow) {
  const signed = process.signedDocumentBase64 && Buffer.from(process.signedDocumentBase64, "base64");
  const signedPayload = correctionRecord(process.draftPayload);
  const correctionId = signedPayload.firmaSeguroClientCorrectionId;
  if (!process.draftId || process.creditoId || process.supersededAt || !process.completedAt ||
    !isFirmaSeguroVerifiedCompletedStatus(process.status) ||
    !signed || signed.subarray(0, 5).toString() !== "%PDF-" || typeof correctionId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(correctionId) || !readFinancingTermsSeal(signedPayload.financialTermsSeal)) return false;
  return prisma.$transaction(async db => {
    await lockSolicitudOperationMutation(db, process.draftId!);
    const rows = await db.$queryRawUnsafe<Array<{ payload: unknown; active: boolean }>>(`SELECT draft."payload",
      EXISTS(SELECT 1 FROM "FirmaSeguroProcess" signature WHERE signature."draftId"=draft."id"
        AND signature."processUuid"=$2 AND signature."supersededAt" IS NULL
        AND signature."completedAt" IS NOT NULL AND signature."signedDocumentBase64" IS NOT NULL) AS "active"
      FROM "CreditoBorrador" draft WHERE draft."id"=$1 AND draft."estado"='ABIERTO'
        AND draft."creditoId" IS NULL FOR UPDATE OF draft`, process.draftId, process.processUuid);
    const current = correctionRecord(rows[0]?.payload);
    const signedSeal = readFinancingTermsSeal(signedPayload.financialTermsSeal);
    const currentSeal = readFinancingTermsSeal(current.financialTermsSeal);
    if (!rows[0]?.active || current.firmaSeguroClientCorrectionId !== correctionId ||
      current.firmaSeguroClientCorrectionPending !== true || !signedSeal ||
      currentSeal?.checksum !== signedSeal.checksum) return false;
    const values = requestDataValues(current);
    const expected = requestDataValues(signedPayload);
    if (Object.keys(expected).some(field => values[field] !== expected[field])) return false;
    await db.$executeRawUnsafe(`UPDATE "CreditoBorrador" SET "payload"=("payload"-'firmaSeguroClientCorrectionPending') ||
      jsonb_build_object('firmaSeguroClientCorrectionReissuedAt',CURRENT_TIMESTAMP::text,
        'firmaSeguroClientCorrectionReissueProcessUuid',$2::text),"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1 AND "payload"->>'firmaSeguroClientCorrectionId'=$3`,
      process.draftId, process.processUuid, correctionId);
    return true;
  });
}
