import { buildVeriffRetryPolicy } from "@/lib/veriff-retry-policy-core";
export {
  buildVeriffRetryPolicy,
  MAX_VERIFF_DECLINED_ATTEMPTS,
} from "@/lib/veriff-retry-policy-core";
export type { VeriffRetryPolicy } from "@/lib/veriff-retry-policy-core";
import prisma from "@/lib/prisma";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
import { extractVeriffIdentityDocumentEvidence } from "@/lib/veriff";
import {
  compareDataCreditoVeriffIdentityEvidence,
  getDataCreditoVeriffIdentityRejectionCode,
} from "@/lib/veriff-identity";
import {
  ensureVeriffSchema,
  lockVeriffDraftAttempts,
  serializeVeriffValidation,
  type VeriffValidationRow,
} from "@/lib/veriff-storage";

type DeclinedCountRow = {
  count: bigint | number | string;
};

type DataCreditoDraftIdentityRow = {
  clienteDocumento: string | null;
  dataCreditoAssessmentId: string | null;
  activeVeriffValidationId: number | null;
};

type RejectedDraftRow = {
  dataCreditoAssessmentId: string;
};

function normalizeIdentityRejectionCode(value: unknown) {
  return (
    String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")
      .slice(0, 64) || "DATACREDITO_VERIFF_IDENTITY_REJECTED"
  );
}

function normalizeAssessmentId(value: unknown) {
  const assessmentId = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    assessmentId
  )
    ? assessmentId
    : null;
}

export async function rejectVeriffDraftForIdentityFailure(
  row: VeriffValidationRow | null | undefined,
  rejectionCode: string,
  dataCreditoAssessmentId?: string | null
) {
  if (!row?.draftId) {
    return false;
  }

  await ensureSolicitudSchema();
  const safeRejectionCode = normalizeIdentityRejectionCode(rejectionCode);
  const expectedAssessmentId = normalizeAssessmentId(dataCreditoAssessmentId);

  return prisma.$transaction(async (transaction) => {
    await lockVeriffDraftAttempts(transaction, row.draftId!);
    const drafts = await transaction.$queryRawUnsafe<RejectedDraftRow[]>(
      `
        UPDATE "CreditoBorrador"
        SET "estado" = 'CERRADO',
            "closedReason" = 'RECHAZADA',
            "closedAt" = COALESCE("closedAt", CURRENT_TIMESTAMP),
            "dataCreditoAssessmentId" = COALESCE(
              "dataCreditoAssessmentId", $4::uuid
            ),
            "payload" = COALESCE("payload", '{}'::jsonb) || jsonb_build_object(
              'solicitudOrigen', 'DATACREDITO',
              'dataCreditoAssessmentId', COALESCE(
                "dataCreditoAssessmentId", $4::uuid
              )::text,
              'dataCreditoStatus', 'NO_EVALUADO',
              'dataCreditoErrorCode', $2::text,
              'veriffStatus', 'IDENTITY_DOCUMENT_REJECTED',
              'veriffIdentityRejectionCode', $2::text,
              'veriffValidationId', $3::integer,
              'veriffRejectedAt', CURRENT_TIMESTAMP
            ),
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
          AND "estado" = 'ABIERTO'
          AND "creditoId" IS NULL
          AND $3 = (
            SELECT MAX(validation."id")
            FROM "VeriffIdentityValidation" validation
            WHERE validation."draftId" = $1
          )
          AND (
            (
              "dataCreditoAssessmentId" IS NOT NULL
              AND ($4::uuid IS NULL OR "dataCreditoAssessmentId" = $4::uuid)
            )
            OR (
              "dataCreditoAssessmentId" IS NULL
              AND $4::uuid IS NOT NULL
            )
          )
        RETURNING "dataCreditoAssessmentId"::text AS "dataCreditoAssessmentId"
      `,
      row.draftId,
      safeRejectionCode,
      row.id,
      expectedAssessmentId
    );
    const rejectedDraft = drafts[0];

    if (!rejectedDraft?.dataCreditoAssessmentId) {
      return false;
    }

    await transaction.$executeRawUnsafe(
      `
        UPDATE "DataCreditoAssessment"
        SET "expiresAt" = LEAST("expiresAt", CURRENT_TIMESTAMP),
            "errorCode" = $2::text,
            "claimedAt" = NULL,
            "claimTokenHash" = NULL,
            "claimExpiresAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid
          AND "status" = 'APROBADO'
          AND "consumedAt" IS NULL
      `,
      rejectedDraft.dataCreditoAssessmentId,
      safeRejectionCode
    );

    return true;
  });
}

export async function getVeriffRetryPolicy(draftId: number | null | undefined) {
  if (!draftId) {
    return buildVeriffRetryPolicy(0);
  }

  await Promise.all([ensureSolicitudSchema(), ensureVeriffSchema()]);
  const rows = await prisma.$queryRawUnsafe<DeclinedCountRow[]>(
    `
      SELECT COUNT(*)::bigint AS "count"
      FROM "VeriffIdentityValidation" declined
      WHERE declined."draftId" = $1
        AND declined."status" = 'DECLINED'
        AND NOT EXISTS (
          SELECT 1
          FROM "VeriffIdentityValidation" newer
          WHERE newer."draftId" = declined."draftId"
            AND newer."id" > declined."id"
            AND newer."createdAt" < COALESCE(
              declined."decidedAt",
              declined."updatedAt"
            )
        )
    `,
    draftId
  );

  return buildVeriffRetryPolicy(Number(rows[0]?.count || 0));
}

export async function enforceVeriffRetryPolicy(
  row: VeriffValidationRow | null
) {
  const serialized = serializeVeriffValidation(row);
  if (row && serialized?.status === "DECLINED" && row.status !== "DECLINED") {
    await prisma.$executeRawUnsafe(
      `
        UPDATE "VeriffIdentityValidation"
        SET "status" = 'DECLINED',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
          AND "status" <> 'DECLINED'
          AND "creditoId" IS NULL
      `,
      row.id
    );
  }
  const retryPolicy = await getVeriffRetryPolicy(row?.draftId);

  if (row?.draftId) {
    const drafts = await prisma.$queryRawUnsafe<DataCreditoDraftIdentityRow[]>(
      `
        SELECT "clienteDocumento",
          COALESCE(
            "dataCreditoAssessmentId"::text,
            NULLIF("payload"->>'dataCreditoAssessmentId', '')
          ) AS "dataCreditoAssessmentId",
          (
            SELECT MAX(validation."id")
            FROM "VeriffIdentityValidation" validation
            WHERE validation."draftId" = "CreditoBorrador"."id"
          ) AS "activeVeriffValidationId"
        FROM "CreditoBorrador"
        WHERE "id" = $1
          AND "estado" = 'ABIERTO'
          AND "creditoId" IS NULL
        LIMIT 1
      `,
      row.draftId
    );
    const draft = drafts[0];
    const activeValidation =
      Number(draft?.activeVeriffValidationId || 0) === row.id;
    const expectedDocument = draft?.dataCreditoAssessmentId
      ? draft.clienteDocumento
      : null;

    if (activeValidation && expectedDocument) {
      const identityComparison = compareDataCreditoVeriffIdentityEvidence(
        [
          extractVeriffIdentityDocumentEvidence(row.decisionPayload),
          extractVeriffIdentityDocumentEvidence(row.webhookPayload),
        ],
        expectedDocument
      );

      if (
        !identityComparison.ok &&
        identityComparison.status !== "missing" &&
        identityComparison.status !== "conflict"
      ) {
        const applicationRejected = await rejectVeriffDraftForIdentityFailure(
          row,
          getDataCreditoVeriffIdentityRejectionCode(identityComparison.status),
          draft.dataCreditoAssessmentId
        );

        if (!applicationRejected) {
          return getVeriffRetryPolicy(row.draftId);
        }

        return {
          ...retryPolicy,
          applicationRejected: true,
          remainingAttempts: 0,
          retryAllowed: false,
        };
      }
    }
  }

  if (
    row?.draftId &&
    serialized?.status === "DECLINED" &&
    retryPolicy.applicationRejected
  ) {
    await prisma.$transaction(async (transaction) => {
      await lockVeriffDraftAttempts(transaction, row.draftId!);
      await transaction.$executeRawUnsafe(
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
            AND $3 = (
              SELECT MAX(validation."id")
              FROM "VeriffIdentityValidation" validation
              WHERE validation."draftId" = $1
            )
        `,
        row.draftId,
        retryPolicy.declinedAttempts,
        row.id
      );
    });
  }

  return retryPolicy;
}
