import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { canOperateSolicitud, isDirectSalesProfile } from "@/lib/solicitud-operation-access";
import prisma from "@/lib/prisma";
import { serializeVeriffValidation, type VeriffValidationRow } from "@/lib/veriff-storage";
import { redactVeriffValidationForOperator } from "@/lib/veriff-response";
import { buildVeriffRetryPolicy } from "@/lib/veriff-retry-policy-core";
import { resolveStoredDraftCorrectionPending, serializeStoredDraftSignature } from "@/lib/credit-process-status-summary";
import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";
import { resolveFirmaSeguroProcessUiState } from "@/app/dashboard/creditos/firmaseguro-ui";
import { serializeDraftSignatureDispatch } from "@/lib/firmaseguro-draft-dispatch-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, private", Vary: "Cookie" };
const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

type StatusRow = {
  id: number;
  vendedorId: number | null;
  aliadoId: number | null;
  estado: string;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  imei: string | null;
  updatedAt: Date | string | null;
  payload: Record<string, unknown> | null;
  validation: VeriffValidationRow | null;
  process: (FirmaSeguroProcessRow & { signedPdfVerified?: boolean }) | null;
  declinedAttempts: number | string;
  signatureDispatch?: unknown;
};

/** Reads persisted webhook evidence in one database snapshot. No provider or write operations. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) return response({ ok: false, error: "No autenticado" }, 401);
    const { id } = await context.params;
    const draftId = /^\d+$/.test(id) ? Number(id) : 0;
    if (!Number.isSafeInteger(draftId) || draftId <= 0 || draftId > 2_147_483_647) {
      return response({ ok: false, error: "Solicitud no disponible" }, 404);
    }
    const admin = isAdminRole(user.rolNombre);
    const central = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const seller = admin ? null : await getSellerSessionUser(user);
    if (!admin && !isDirectSalesProfile(seller?.tipoPerfil)) {
      return response({ ok: false, error: "Acceso no autorizado" }, 403);
    }
    const rows = await prisma.$queryRawUnsafe<StatusRow[]>(`
      SELECT d."id", d."vendedorId", s."aliadoId", d."estado", d."updatedAt", d."clienteNombre", d."clienteDocumento", d."imei",
        jsonb_build_object(
          'firmaSeguroIdentityCorrectionPending', d."payload"->'firmaSeguroIdentityCorrectionPending',
          'firmaSeguroCorrectionPending', d."payload"->'firmaSeguroCorrectionPending',
          'firmaSeguroFinancialCorrectionPending', d."payload"->'firmaSeguroFinancialCorrectionPending',
          'firmaSeguroIdentityCorrectionId', d."payload"->'firmaSeguroIdentityCorrectionId',
          'firmaSeguroCorrectionId', d."payload"->'firmaSeguroCorrectionId',
          'firmaSeguroFinancialCorrectionId', d."payload"->'firmaSeguroFinancialCorrectionId',
          'firmaSeguroFinancialCorrectionPreviousProcessUuid', d."payload"->'firmaSeguroFinancialCorrectionPreviousProcessUuid',
          'valorEquipoTotal', d."payload"->'valorEquipoTotal',
          'cuotaInicial', d."payload"->'cuotaInicial', 'plazoMeses', d."payload"->'plazoMeses'
        ) AS "payload", to_jsonb(validation) AS "validation", to_jsonb(signature) AS "process",
        to_jsonb(dispatch) AS "signatureDispatch",
        (SELECT COUNT(*)::integer FROM "VeriffIdentityValidation" declined
          WHERE declined."draftId" = d."id" AND declined."status" = 'DECLINED'
            AND NOT EXISTS (SELECT 1 FROM "VeriffIdentityValidation" newer
              WHERE newer."draftId" = declined."draftId" AND newer."id" > declined."id"
                AND newer."createdAt" < COALESCE(declined."decidedAt", declined."updatedAt"))) AS "declinedAttempts"
      FROM "CreditoBorrador" d
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      LEFT JOIN LATERAL (
        SELECT v.* FROM "VeriffIdentityValidation" v
        WHERE v."draftId" = d."id" AND v."creditoId" IS NULL
        ORDER BY v."id" DESC LIMIT 1
      ) validation ON TRUE
      LEFT JOIN LATERAL (
        SELECT p."id", p."creditoId", p."draftId", p."draftFolio", p."draftPayload", p."processUuid",
          p."status", p."signedDocumentFileName", p."lastError", p."createdAt", p."updatedAt", p."completedAt",
          CASE WHEN COALESCE(p."signedDocumentBase64", '') <> '' THEN 'stored' ELSE NULL END AS "signedDocumentBase64",
          SUBSTRING(COALESCE(p."signedDocumentBase64", ''),1,7) = 'JVBERi0' AS "signedPdfVerified"
        FROM "FirmaSeguroProcess" p WHERE p."draftId" = d."id" AND p."creditoId" IS NULL
          AND p."supersededAt" IS NULL ORDER BY p."createdAt" DESC, p."id" DESC LIMIT 1
      ) signature ON TRUE
      LEFT JOIN LATERAL (
        SELECT attempt."id"::text, attempt."status", attempt."createdAt", attempt."updatedAt",
          attempt."actorUserId", attempt."reason", attempt."expectedProcessUuid",
          CASE WHEN LEFT(attempt."lastError", LENGTH('provider_dispatch [')) = 'provider_dispatch [' THEN 'provider_dispatch'
            WHEN LEFT(attempt."lastError", LENGTH('receipt_persistence [')) = 'receipt_persistence [' THEN 'receipt_persistence'
            ELSE NULL END AS "failureStage",
          NULLIF(BTRIM(COALESCE(attempt."processUuid", '')), '') IS NOT NULL AS "hasProviderLocator",
          EXISTS (SELECT 1 FROM "FirmaSeguroDraftDispatchReceipt" receipt
            WHERE receipt."dispatchId" = attempt."id") AS "hasReceipt"
        FROM "FirmaSeguroDraftDispatch" attempt
        WHERE attempt."draftId" = d."id" AND attempt."status" IN ('PREPARING','DISPATCHING','UNCERTAIN')
        ORDER BY attempt."createdAt" DESC, attempt."id" DESC LIMIT 1
      ) dispatch ON TRUE
      WHERE d."id" = $1 AND d."creditoId" IS NULL
        AND (d."estado" = 'ABIERTO' OR (d."estado" = 'CERRADO' AND d."closedReason" = 'RECHAZADA'))
        AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
      LIMIT 1`, draftId);
    const row = rows[0];
    const allowed = row && (admin
      ? central || (user.aliadoAccesoId != null && user.aliadoAccesoId === row.aliadoId)
      : canOperateSolicitud({ central: false, seller, viewerAllyId: user.aliadoId, owner: row }));
    if (!allowed || !row) return response({ ok: false, error: "Solicitud no disponible" }, 404);

    const validation = serializeVeriffValidation(row.validation);
    const process = serializeStoredDraftSignature(row.process);
    const signatureDispatch = serializeDraftSignatureDispatch(row.signatureDispatch, { actorUserId: user.id });
    const signatureState = resolveFirmaSeguroProcessUiState(process);
    const pending = row.estado === "ABIERTO" && (validation?.pending === true || signatureState === "waiting" || signatureDispatch !== null);
    const iso = (value: Date | string | null | undefined) => value instanceof Date ? value.toISOString() : value || null;
    return response({
      ok: true, draftId: row.id,
      revision: {
        draftUpdatedAt: iso(row.updatedAt), processId: process?.id || null, processUpdatedAt: process?.updatedAt || null,
        validationId: validation?.id || null, validationUpdatedAt: validation?.updatedAt || null,
        signatureDispatchId: signatureDispatch?.id || null, signatureDispatchStatus: signatureDispatch?.status || null,
        signatureDispatchUpdatedAt: signatureDispatch?.updatedAt || null,
        signatureDispatchHasReceipt: signatureDispatch?.hasReceipt || false,
      },
      validation: central ? validation : redactVeriffValidationForOperator(validation),
      process, signatureDispatch, retryPolicy: buildVeriffRetryPolicy(Number(row.declinedAttempts || 0)), pending,
      ...resolveStoredDraftCorrectionPending({ draftId: row.id, documentNumber: row.clienteDocumento,
        clientName: row.clienteNombre, imei: row.imei, payload: row.payload, process: row.process }),
    });
  } catch {
    return response({ ok: false, error: "No se pudo consultar el estado. Reintenta sin repetir el envío." }, 500);
  }
}
