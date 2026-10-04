import "server-only";

import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { isVerifiedTerminalSignatureFailure, signedPdfBytes } from "@/lib/approval-operations-core";
import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";

/** A signed warranty revision closes its own ledger, not the original credit contract. */
export async function completeOperationalSignatureVersion(
  db: Prisma.TransactionClient | typeof prisma,
  creditId: number,
  processUuid: string,
  signedDocumentBase64: string | null,
) {
  const existing = await db.$queryRawUnsafe<Array<{ installed: string | null }>>(
    `SELECT to_regclass('public."ApprovalOperationalContractVersion"')::text AS installed`);
  if (!existing[0]?.installed) return false;
  const rows = await db.$queryRawUnsafe<Array<{ id: string; status: string; newProcessUuid: string | null }>>(
    `SELECT "id"::text,"status","newProcessUuid" FROM "ApprovalOperationalContractVersion"
      WHERE "creditoId"=$1 AND ("newProcessUuid"=$2
        OR "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN'))
      ORDER BY CASE WHEN "newProcessUuid"=$2 THEN 0 ELSE 1 END,"version" DESC
      LIMIT 1 FOR UPDATE`, creditId, processUuid);
  const operation = rows[0];
  if (!operation) return false;
  if (operation.newProcessUuid === processUuid && ["AWAITING_SIGNATURE", "UNCERTAIN", "TECHNICAL_ERROR"].includes(operation.status)
    && Buffer.from(signedDocumentBase64 || "", "base64").subarray(0, 5).toString() === "%PDF-") {
    await db.$executeRawUnsafe(`UPDATE "ApprovalOperationalContractVersion"
      SET "status"='COMPLETED',"completedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
          "lastCheckedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
      WHERE "id"=$1::uuid AND "newProcessUuid"=$2
        AND "status" IN ('AWAITING_SIGNATURE','UNCERTAIN','TECHNICAL_ERROR')`,
      operation.id, processUuid);
  }
  return true;
}

/** Called only after a fresh provider status lookup, never from an unverified callback. */
export async function markOperationalSignatureTerminalFailure(
  db: Prisma.TransactionClient | typeof prisma,
  creditId: number,
  processUuid: string,
  verifiedProviderStatus: unknown,
) {
  if (!isVerifiedTerminalSignatureFailure(verifiedProviderStatus)) return false;
  const installed = await db.$queryRawUnsafe<Array<{ installed: string | null }>>(
    `SELECT to_regclass('public."ApprovalOperationalContractVersion"')::text AS installed`);
  if (!installed[0]?.installed) return false;
  const changed = await db.$executeRawUnsafe(`UPDATE "ApprovalOperationalContractVersion" version
    SET "status"='TECHNICAL_ERROR',"lastCheckedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
        "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    WHERE version."creditoId"=$1 AND version."newProcessUuid"=$2
      AND version."status"='AWAITING_SIGNATURE'
      AND EXISTS (SELECT 1 FROM "FirmaSeguroProcess" process
        WHERE process."creditoId"=$1 AND process."processUuid"=$2
          AND process."status"=$3 AND process."supersededAt" IS NULL
          AND process."completedAt" IS NULL AND process."signedDocumentBase64" IS NULL)`,
    creditId, processUuid, verifiedProviderStatus);
  return changed === 1;
}

export async function isSupersededTerminalOperationalProcess(creditId: number, processUuid: string) {
  const installed = await prisma.$queryRawUnsafe<Array<{ installed: string | null }>>(
    `SELECT to_regclass('public."ApprovalOperationalContractVersion"')::text AS installed`);
  if (!installed[0]?.installed) return false;
  const rows = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT EXISTS (SELECT 1 FROM "ApprovalOperationalContractVersion" failed
      WHERE failed."creditoId"=$1 AND failed."newProcessUuid"=$2
        AND failed."status"='TECHNICAL_ERROR'
        AND EXISTS (SELECT 1 FROM "ApprovalOperationalContractVersion" newer
          WHERE newer."creditoId"=$1 AND newer."version">failed."version")) AS present`,
    creditId, processUuid);
  return rows[0]?.present === true;
}

/** Record a provider-confirmed late PDF without reactivating the archived process or credit snapshot. */
export async function recordLateSupersededOperationalSignature(input: {
  creditId: number; processUuid: string; status: string; signedDocumentBase64: string;
  signedDocumentFileName: string | null; statusPayload: unknown;
  signaturesPayload: unknown; documentsPayload: unknown;
}) {
  if (!signedPdfBytes(input.signedDocumentBase64)) return null;
  return prisma.$transaction(async (db) => {
    await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, input.creditId);
    const versions = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT failed."id"::text FROM "ApprovalOperationalContractVersion" failed
       WHERE failed."creditoId"=$1 AND failed."newProcessUuid"=$2
         AND failed."status"='TECHNICAL_ERROR'
         AND EXISTS (SELECT 1 FROM "ApprovalOperationalContractVersion" newer
           WHERE newer."creditoId"=$1 AND newer."version">failed."version")
         AND NOT EXISTS (SELECT 1 FROM "ApprovalOperationalContractVersion" source
           WHERE source."creditoId"=$1 AND source."previousProcessUuid"=$2)
       FOR UPDATE OF failed`, input.creditId, input.processUuid);
    if (!versions[0]) return null;
    const updated = await db.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
      `UPDATE "FirmaSeguroProcess" SET "status"=$3,"statusPayload"=$4::jsonb,
         "signaturesPayload"=$5::jsonb,"documentsPayload"=$6::jsonb,
         "signedDocumentBase64"=$7,"signedDocumentFileName"=$8,
         "completedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',"lastError"=NULL,
         "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
       WHERE "creditoId"=$1 AND "processUuid"=$2 AND "supersededAt" IS NOT NULL
         AND "completedAt" IS NULL AND "signedDocumentBase64" IS NULL RETURNING *`,
      input.creditId,input.processUuid,input.status,JSON.stringify(input.statusPayload),
      JSON.stringify(input.signaturesPayload),JSON.stringify(input.documentsPayload),
      input.signedDocumentBase64,input.signedDocumentFileName);
    if (!updated[0]) return null;
    await db.$executeRawUnsafe(`UPDATE "ApprovalOperationalContractVersion"
      SET "status"='COMPLETED',"completedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
          "lastCheckedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
          "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
      WHERE "id"=$1::uuid AND "status"='TECHNICAL_ERROR'`, versions[0].id);
    return updated[0];
  });
}
