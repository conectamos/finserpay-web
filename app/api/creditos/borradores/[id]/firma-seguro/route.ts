import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { assertDocumentNotBlacklisted } from "@/lib/document-blacklist";
import { documentBlacklistErrorResponse } from "@/lib/document-blacklist-response";
import { getCreditApprovalSessionUser, getSessionUser } from "@/lib/auth";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isDirectSalesProfile } from "@/lib/solicitud-operation-access";
import prisma from "@/lib/prisma";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import {
  generateCreditFolio,
  generatePaymentReference,
  resolveActivationFirstPaymentDate,
  sanitizeDeviceValue,
  sanitizeText,
  toNumber,
} from "@/lib/credit-factory";
import {
  createFinancingTermsSeal,
  readFinancingTermsSeal,
} from "@/lib/credit-amortization-contract";
import { creditRemissionFromSignedSnapshot } from "@/lib/credit-remission";
import {
  FirmaSeguroApiError,
  isFirmaSeguroCompletedStatus,
} from "@/lib/firmaseguro";
import { isFirmaSeguroFailedStatus } from "@/lib/firmaseguro-status";
import {
  buildDraftCredit,
  CreditValidationError,
  type DraftPayload,
  type DraftRow,
} from "@/lib/firmaseguro-draft-credit-builder";
import {
  getLatestFirmaSeguroProcessForDraft,
  refreshFirmaSeguroProcess,
  serializeFirmaSeguroProcess,
} from "@/lib/firmaseguro-credit";
import { buildFirmaSeguroCreditPdf } from "@/lib/firmaseguro-folio-pdf";
import { buildFrozenDraftCorrection } from "@/lib/firmaseguro-draft-frozen";
import { DraftDispatchError, dispatchReservedDraft, finalizeDraftDispatch, getDraftDispatch,
  getDraftDispatchReceipt,
  getUnresolvedDraftDispatch, reserveDraftDispatch } from "@/lib/firmaseguro-draft-dispatch-ledger";
import {
  correctFirmaSeguroDraftImei,
  FirmaSeguroImeiCorrectionError,
  recordFirmaSeguroImeiCorrectionReissue,
} from "@/lib/firmaseguro-imei-correction";
import { recordFirmaSeguroFinancialCorrectionReissue } from "@/lib/firmaseguro-financial-correction";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";
import {
  getFirmaSeguroProcessByUuid,
  tryAcquireFirmaSeguroDraftDispatchLock,
} from "@/lib/firmaseguro-storage";
import { isAdminRole } from "@/lib/roles";
import { expireStaleSolicitudes } from "@/lib/solicitudes-storage";
import {
  getVeriffValidationById,
  isVeriffApproved,
} from "@/lib/veriff-storage";
import { isVeriffRequired } from "@/lib/veriff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function canReuseFirmaSeguroProcess(process: {
  completedAt?: unknown;
  lastError?: unknown;
  signedDocumentBase64?: unknown;
  status?: unknown;
}) {
  const normalized = sanitizeText(process.status).toUpperCase();

  if (
    process.completedAt ||
    sanitizeText(process.signedDocumentBase64) ||
    isFirmaSeguroCompletedStatus(normalized)
  ) {
    return true;
  }

  if (sanitizeText(process.lastError)) {
    return false;
  }

  return Boolean(normalized && !isFirmaSeguroFailedStatus(normalized));
}

function logFirmaSeguroDraftError(
  operation: "GET" | "POST" | "PATCH",
  draftId: number | null,
  error: unknown
) {
  console.error("ERROR FIRMASEGURO BORRADOR:", {
    operation,
    draftId,
    errorType: error instanceof Error ? error.name : "UnknownError",
    status:
      error instanceof DraftDispatchError ||
      error instanceof CreditValidationError ||
      error instanceof FirmaSeguroApiError ||
      error instanceof FirmaSeguroImeiCorrectionError
        ? error.status
        : 500,
    code:
      error instanceof DraftDispatchError ||
      error instanceof CreditValidationError ||
      error instanceof FirmaSeguroImeiCorrectionError
        ? error.code
        : error instanceof FirmaSeguroApiError
          ? "FIRMASEGURO_PROVIDER_ERROR"
          : "FIRMASEGURO_UNEXPECTED_ERROR",
  });
}


function parseDraftId(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function payloadObject(value: unknown): DraftPayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as DraftPayload)
    : {};
}

async function ensureDraftTable() {
  await expireStaleSolicitudes();
}

async function readAuthorizedDraft(
  draftId: number,
  options: { operate?: boolean } = {}
) {
  const user = await getSessionUser();

  if (!user) {
    return { ok: false as const, status: 401, error: "No autenticado" };
  }

  const admin = isAdminRole(user.rolNombre);
  const centralAdmin = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
  const sellerSession = admin ? null : await getSellerSessionUser(user);

  if (!admin && !isDirectSalesProfile(sellerSession?.tipoPerfil)) {
    return {
      ok: false as const,
      status: 403,
      error: "Debes abrir primero un perfil comercial",
    };
  }

  await ensureDraftTable();

  const where = [
    `d."id" = $1`,
    `d."estado" = 'ABIERTO'`,
    `d."creditoId" IS NULL`,
    `COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP`,
  ];
  const values: unknown[] = [draftId];

  if (admin && !centralAdmin) {
    values.push(user.aliadoAccesoId || -1);
    where.push(`s."aliadoId" = $${values.length}`);
  } else if (!admin) {
    values.push(sellerSession?.id || 0);
    where.push(`d."vendedorId" = $${values.length}`);

    values.push(user.aliadoId || -1);
    where.push(`s."aliadoId" = $${values.length}`);
  }
  if (options.operate && admin && !centralAdmin) {
    return {
      ok: false as const,
      status: 403,
      error: "Solo el administrador central puede operar esta solicitud",
    };
  }

  const rows = await prisma.$queryRawUnsafe<DraftRow[]>(
    `
      SELECT
        d.*,
        u."nombre" AS "usuarioNombre",
        u."usuario" AS "usuarioLogin",
        v."nombre" AS "vendedorNombre",
        v."documento" AS "vendedorDocumento",
        v."telefono" AS "vendedorTelefono",
        v."email" AS "vendedorEmail",
        s."nombre" AS "sedeNombre",
        s."codigo" AS "sedeCodigo",
        s."aliadoId" AS "sedeAliadoId"
      FROM "CreditoBorrador" d
      LEFT JOIN "Usuario" u ON u."id" = d."usuarioId"
      LEFT JOIN "Vendedor" v ON v."id" = d."vendedorId"
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      WHERE ${where.join(" AND ")}
      LIMIT 1
    `,
    ...values
  );

  const row = rows[0];
  if (!row) {
    return { ok: false as const, status: 404, error: "Borrador no encontrado" };
  }
  await assertDocumentNotBlacklisted(row.clienteDocumento);
  await assertDocumentNotBlacklisted(payloadObject(row.payload).clienteDocumento);

  return { ok: true as const, row, centralAdmin };
}

function getDraftFirstPaymentDateState(
  process: { draftPayload?: unknown } | null,
  activatedAt: Date | number | string = new Date()
) {
  const processPayload = payloadObject(process?.draftPayload);
  const signedSeal = readFinancingTermsSeal(
    processPayload.financialTermsSeal
  );
  const resolution = resolveActivationFirstPaymentDate({
    frequency:
      signedSeal?.snapshot.frecuenciaPago || processPayload.frecuenciaPago,
    activatedAt,
    signedFirstPaymentDate:
      signedSeal?.snapshot.fechaPrimerPago || processPayload.fechaPrimerPago,
  });

  return {
    firstPaymentDate: resolution.signedDateKey,
    canonicalFirstPaymentDate: resolution.dateKey,
    requiresFirstPaymentDateReissue:
      !signedSeal || !resolution.signedDateMatches,
  };
}

function serializeDraftFirmaSeguroProcess(
  process: Parameters<typeof serializeFirmaSeguroProcess>[0],
  options: Parameters<typeof serializeFirmaSeguroProcess>[1] = {}
) {
  const serialized = serializeFirmaSeguroProcess(process, options);
  if (!serialized) return null;
  const processPayload = payloadObject(process?.draftPayload);
  const signedSeal = readFinancingTermsSeal(
    processPayload.financialTermsSeal
  );

  return {
    ...serialized,
    ...getDraftFirstPaymentDateState(process),
    financialTermsChecksum: signedSeal?.checksum || null,
    financialCorrectionReissue: Boolean(
      processPayload.firmaSeguroFinancialCorrectionId,
    ),
    remission: signedSeal
      ? creditRemissionFromSignedSnapshot(signedSeal.snapshot)
      : null,
  };
}

async function recordDraftCorrectionReissue(
  draftId: number,
  process: import("@/lib/firmaseguro-storage").FirmaSeguroProcessRow | null,
) {
  await recordFirmaSeguroImeiCorrectionReissue(draftId, process);
  await recordFirmaSeguroFinancialCorrectionReissue(draftId, process);
}

function firmaSeguroErrorResponse(error: unknown) {
  if (error instanceof DraftDispatchError) {
    return NextResponse.json({ ok: false, code: error.code, stage: "provider_dispatch",
      error: error.message }, { status: error.status });
  }
  if (error instanceof FirmaSeguroImeiCorrectionError) {
    return NextResponse.json(
      {
        ok: false,
        code: error.code,
        stage: "imei_correction",
        error: error.message,
      },
      { status: error.status }
    );
  }

  if (error instanceof CreditValidationError) {
    return NextResponse.json(
      {
        ok: false,
        code: error.code,
        stage: "credit_validation",
        error: error.message,
      },
      { status: error.status }
    );
  }

  if (error instanceof FirmaSeguroApiError) {
    return NextResponse.json(
      {
        ok: false,
        code: "FIRMASEGURO_PROVIDER_ERROR",
        stage: "provider_dispatch",
        error: error.message,
        detail: error.detail,
      },
      { status: error.status || 500 }
    );
  }

  const message =
    error instanceof Error
      ? error.message
      : "No se pudo procesar la solicitud de FirmaSeguro";

  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}

// A confirmed provider response can be finalized without creating another contract.
async function resumeAcknowledgedDraftDispatch(draftId: number) {
  const pending = await getUnresolvedDraftDispatch(draftId);
  if (pending && await getDraftDispatchReceipt(pending.id)) {
    await finalizeDraftDispatch(pending.id);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let draftIdForLog: number | null = null;
  try {
    const params = await context.params;
    const draftId = parseDraftId(params.id);
    draftIdForLog = draftId;

    if (!draftId) {
      return NextResponse.json(
        { ok: false, error: "Borrador invalido" },
        { status: 400 }
      );
    }

    const authorized = await readAuthorizedDraft(draftId);
    if (!authorized.ok) {
      return NextResponse.json(
        { ok: false, error: authorized.error },
        { status: authorized.status }
      );
    }


    await resumeAcknowledgedDraftDispatch(draftId);
    const current = await getLatestFirmaSeguroProcessForDraft(draftId);
    if (!current) {
      return NextResponse.json({ ok: true, process: null });
    }

    const url = new URL(request.url);
    const shouldRefresh = url.searchParams.get("refresh") === "1";
    const process = shouldRefresh ? await refreshFirmaSeguroProcess(current) : current;
    await recordDraftCorrectionReissue(draftId, process);

    return NextResponse.json({
      ok: true,
      process: serializeDraftFirmaSeguroProcess(process, {
        includeDraftImei: authorized.centralAdmin,
      }),
    });
  } catch (error) {
    const blacklistResponse = documentBlacklistErrorResponse(error);
    if (blacklistResponse) return blacklistResponse;
    logFirmaSeguroDraftError("GET", draftIdForLog, error);
    return firmaSeguroErrorResponse(error);
  }
}

async function requireApprovedVeriffBeforeFirmaSeguro(row: DraftRow) {
  const payload = payloadObject(row.payload);
  const mustRequireVeriff =
    getDataCreditoPublicConfig().enabled || isVeriffRequired();
  if (!mustRequireVeriff) {
    return;
  }

  const validationId = Math.trunc(toNumber(payload.veriffValidationId));
  if (!Number.isInteger(validationId) || validationId <= 0) {
    throw new CreditValidationError(
      "Aprueba primero la identidad con Veriff antes de enviar el contrato.",
      409,
      "FIRMASEGURO_VERIFF_REQUIRED"
    );
  }

  const validation = await getVeriffValidationById(validationId);
  const draftDocument = sanitizeText(payload.clienteDocumento).replace(/\D/g, "");
  const validationDocument = String(
    validation?.clienteDocumento || ""
  ).replace(/\D/g, "");

  if (
    !validation ||
    validation.draftId !== row.id ||
    validation.creditoId ||
    !isVeriffApproved(validation) ||
    !draftDocument ||
    validationDocument !== draftDocument
  ) {
    throw new CreditValidationError(
      "La aprobación Veriff no corresponde a esta solicitud o ya no está vigente.",
      409,
      "FIRMASEGURO_VERIFF_INVALID"
    );
  }

  const latestRows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `
      SELECT validation."id"
      FROM "VeriffIdentityValidation" validation
      WHERE validation."draftId" = $1
        AND validation."creditoId" IS NULL
      ORDER BY validation."id" DESC
      LIMIT 1
    `,
    row.id
  );
  if (Number(latestRows[0]?.id || 0) !== validation.id) {
    throw new CreditValidationError(
      "Existe una validación Veriff más reciente. Actualiza el estado antes de enviar el contrato.",
      409,
      "FIRMASEGURO_VERIFF_SUPERSEDED"
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let draftIdForLog: number | null = null;
  try {
    const params = await context.params;
    const draftId = parseDraftId(params.id);
    draftIdForLog = draftId;
    if (!draftId) {
      return NextResponse.json(
        { ok: false, code: "SOLICITUD_INVALIDA", error: "Borrador invalido" },
        { status: 400 }
      );
    }

    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, code: "NO_AUTENTICADO", error: "No autenticado" },
        { status: 401 }
      );
    }
    if (
      !isAdminRole(user.rolNombre) ||
      !isFinserPayCentralAlly(user.aliadoAccesoCodigo)
    ) {
      return NextResponse.json(
        {
          ok: false,
          code: "CORRECCION_IMEI_NO_AUTORIZADA",
          error: "Solo el administrador central FINSER PAY puede corregir el IMEI.",
        },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => null)) as
      | {
          action?: unknown;
          imei?: unknown;
          reason?: unknown;
          expectedCurrentImei?: unknown;
          expectedProcessUuid?: unknown;
          expectedEnrollmentReviewId?: unknown;
        }
      | null;
    if (String(body?.action || "").trim().toUpperCase() !== "CORREGIR_IMEI") {
      return NextResponse.json(
        {
          ok: false,
          code: "ACCION_CORRECCION_INVALIDA",
          error: "La accion solicitada no es valida.",
        },
        { status: 400 }
      );
    }

    const result = await correctFirmaSeguroDraftImei({
      draftId,
      imei: body?.imei,
      reason: body?.reason,
      expectedCurrentImei: body?.expectedCurrentImei,
      expectedProcessUuid: body?.expectedProcessUuid,
      expectedEnrollmentReviewId: body?.expectedEnrollmentReviewId,
      actorUserId: user.id,
      actorName: user.nombre,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logFirmaSeguroDraftError("PATCH", draftIdForLog, error);
    return firmaSeguroErrorResponse(error);
  }
}

async function readOperationalDraft(draftId: number, actorUserId: number) {
  const user = await getCreditApprovalSessionUser();
  if (!user || user.id !== actorUserId) {
    throw new DraftDispatchError("DRAFT_DISPATCH_UNAUTHORIZED",
      "La sesión de Aprobaciones cambió. Actualiza el caso.", 403);
  }
  const rows = await prisma.$queryRawUnsafe<DraftRow[]>(`
    SELECT d.*, u."nombre" AS "usuarioNombre", u."usuario" AS "usuarioLogin",
      v."nombre" AS "vendedorNombre", v."documento" AS "vendedorDocumento",
      v."telefono" AS "vendedorTelefono", v."email" AS "vendedorEmail",
      s."nombre" AS "sedeNombre", s."codigo" AS "sedeCodigo", s."aliadoId" AS "sedeAliadoId"
    FROM "CreditoBorrador" d
    LEFT JOIN "Usuario" u ON u."id"=d."usuarioId"
    LEFT JOIN "Vendedor" v ON v."id"=d."vendedorId"
    LEFT JOIN "Sede" s ON s."id"=d."sedeId"
    WHERE d."id"=$1 AND d."estado"='ABIERTO' AND d."creditoId" IS NULL
      AND d."currentStep" IN (3,4)
      AND COALESCE(d."expiresAt",d."createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP
      AND UPPER(COALESCE(d."plataforma",d."payload"->>'plataformaDispositivo',''))='IPHONE'
    LIMIT 1`, draftId);
  const row = rows[0];
  if (!row) throw new DraftDispatchError("DRAFT_DISPATCH_CASE_UNAVAILABLE",
    "La solicitud iPhone ya no está abierta en Identidad y firma.", 409);
  await assertDocumentNotBlacklisted(row.clienteDocumento);
  await assertDocumentNotBlacklisted(payloadObject(row.payload).clienteDocumento);
  return { ok: true as const, row, centralAdmin: false };
}

async function requestDraftSignatureCore(
  draftId: number,
  authorized: { ok: true; row: DraftRow; centralAdmin: boolean },
  actorUser: { id: number; nombre: string },
  body: Record<string, unknown>,
  scope: "commercial" | "operational"
) {
    if (body.actorUserId !== undefined && body.actorUserId !== actorUser.id) {
      return NextResponse.json({ ok: false, code: "DRAFT_DISPATCH_ACTOR_CHANGED",
        error: "La sesión cambió. Actualiza el caso antes de enviar." }, { status: 409 });
    }
    const key = body.idempotencyKey === undefined ? randomUUID() : String(body.idempotencyKey);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
      return NextResponse.json({ ok: false, code: "DRAFT_DISPATCH_ID_INVALID",
        error: "Actualiza el caso antes de confirmar el envío." }, { status: 400 });
    }
    const reason = body.reason === undefined
      ? "Envío del contrato de la solicitud a FirmaSeguro"
      : String(body.reason).normalize("NFKC").trim().replace(/\s+/g, " ");
    if (reason.length < 5 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
      return NextResponse.json({ ok: false, code: "DRAFT_DISPATCH_REASON_INVALID",
        error: "Describe el motivo en 5 a 500 caracteres." }, { status: 400 });
    }
    const explicitExpected = Object.prototype.hasOwnProperty.call(body, "expectedProcessUuid");
    const expectedProcessUuid = explicitExpected
      ? (typeof body.expectedProcessUuid === "string" ? body.expectedProcessUuid.trim() || null : null)
      : undefined;
    const replay = await getDraftDispatch(key);
    if (replay) {
      if (replay.draftId !== draftId || replay.actorUserId !== actorUser.id || replay.reason !== reason
        || (explicitExpected && replay.expectedProcessUuid !== expectedProcessUuid)) {
        throw new DraftDispatchError("DRAFT_DISPATCH_IDEMPOTENCY_CONFLICT",
          "Esta confirmación corresponde a otra solicitud de firma.");
      }
      const resumed = replay.status === "PREPARING"
        ? await dispatchReservedDraft(key)
        : await getDraftDispatchReceipt(key) ? await finalizeDraftDispatch(key) : replay;
      if (resumed.status !== "AWAITING_SIGNATURE" || !resumed.processUuid) {
        throw new DraftDispatchError("DRAFT_DISPATCH_UNRESOLVED",
          "El resultado del envío aún no está confirmado. Requiere conciliación antes de reenviar.");
      }
      const process = await getFirmaSeguroProcessByUuid(resumed.processUuid);
      if (!process) throw new DraftDispatchError("DRAFT_DISPATCH_PROCESS_MISSING",
        "FirmaSeguro confirmó el envío, pero el proceso ya no está vigente. Actualiza el caso.");
      await recordDraftCorrectionReissue(draftId, process);
      return NextResponse.json({ ok: true, id: key, status: resumed.status, idempotent: true,
        process: serializeDraftFirmaSeguroProcess(process),
        message: "FirmaSeguro confirmó este envío anteriormente." });
    }
    await resumeAcknowledgedDraftDispatch(draftId);
    if (await getUnresolvedDraftDispatch(draftId)) {
      throw new DraftDispatchError("DRAFT_DISPATCH_UNRESOLVED",
        "Existe un envío de firma sin resultado confirmado. Requiere conciliación antes de reenviar.");
    }

    const current = await getLatestFirmaSeguroProcessForDraft(draftId);
    if (explicitExpected && (current?.processUuid || null) !== expectedProcessUuid) {
      throw new DraftDispatchError("DRAFT_DISPATCH_PROCESS_CHANGED",
        "La firma vigente cambió. Actualiza el caso.");
    }
    const currentPayload = payloadObject(authorized.row.payload);
    if (body.requireCorrection === true &&
      currentPayload.firmaSeguroCorrectionPending !== true &&
      currentPayload.firmaSeguroContactCorrectionPending !== true &&
      currentPayload.firmaSeguroFinancialCorrectionPending !== true) {
      throw new DraftDispatchError("DRAFT_DISPATCH_CORRECTION_REQUIRED",
        "Corrige primero el IMEI o el contacto y actualiza el expediente.");
    }
    const currentFirstPaymentState = getDraftFirstPaymentDateState(current);
    if (
      current &&
      canReuseFirmaSeguroProcess(current) &&
      !currentFirstPaymentState.requiresFirstPaymentDateReissue
    ) {
      await recordDraftCorrectionReissue(draftId, current);
      return NextResponse.json({
        ok: true,
        idempotent: true,
        process: serializeDraftFirmaSeguroProcess(current),
        message: "La solicitud ya tiene un proceso activo en FirmaSeguro",
      });
    }
    const dispatchLock = await tryAcquireFirmaSeguroDraftDispatchLock(draftId);
    if (!dispatchLock) {
      const concurrentProcess = await getLatestFirmaSeguroProcessForDraft(draftId);
      const concurrentFirstPaymentState =
        getDraftFirstPaymentDateState(concurrentProcess);
      if (
        concurrentProcess &&
        canReuseFirmaSeguroProcess(concurrentProcess) &&
        !concurrentFirstPaymentState.requiresFirstPaymentDateReissue
      ) {
        await recordDraftCorrectionReissue(draftId, concurrentProcess);
        return NextResponse.json({
          ok: true,
          idempotent: true,
          process: serializeDraftFirmaSeguroProcess(concurrentProcess),
          message: "La solicitud ya tiene un proceso activo en FirmaSeguro",
        });
      }
      return NextResponse.json(
        {
          ok: false,
          code: "FIRMASEGURO_DISPATCH_IN_PROGRESS",
          stage: "provider_dispatch",
          error:
            "El expediente ya se esta enviando a FirmaSeguro. Espera unos segundos y actualiza el estado.",
        },
        { status: 409, headers: { "Retry-After": "2" } }
      );
    }

    try {
      const lockedAuthorized = scope === "operational"
        ? await readOperationalDraft(draftId, actorUser.id)
        : await readAuthorizedDraft(draftId, { operate: true });
      if (!lockedAuthorized.ok) {
        return NextResponse.json(
          { ok: false, error: lockedAuthorized.error },
          { status: lockedAuthorized.status }
        );
      }

      if (await getUnresolvedDraftDispatch(draftId)) {
        throw new DraftDispatchError("DRAFT_DISPATCH_UNRESOLVED",
          "Existe un envío de firma sin resultado confirmado. Requiere conciliación antes de reenviar.");
      }

      const lockedCurrent = await getLatestFirmaSeguroProcessForDraft(draftId);
      if (explicitExpected && (lockedCurrent?.processUuid || null) !== expectedProcessUuid) {
        throw new DraftDispatchError("DRAFT_DISPATCH_PROCESS_CHANGED",
          "La firma vigente cambió. Actualiza el caso.");
      }
      const lockedCurrentFirstPaymentState =
        getDraftFirstPaymentDateState(lockedCurrent);
      const lockedCurrentReusable = Boolean(
        lockedCurrent && canReuseFirmaSeguroProcess(lockedCurrent)
      );
      const requiresFirstPaymentDateReissue =
        lockedCurrentReusable &&
        lockedCurrentFirstPaymentState.requiresFirstPaymentDateReissue;
      if (lockedCurrentReusable && !requiresFirstPaymentDateReissue) {
        await recordDraftCorrectionReissue(draftId, lockedCurrent);
        return NextResponse.json({
          ok: true,
          idempotent: true,
          process: serializeDraftFirmaSeguroProcess(lockedCurrent),
          message: "La solicitud ya tiene un proceso activo en FirmaSeguro",
        });
      }

      await requireApprovedVeriffBeforeFirmaSeguro(lockedAuthorized.row);
      const sourcePayload = payloadObject(lockedAuthorized.row.payload);
      const frozenCorrectionPending =
        sourcePayload.firmaSeguroCorrectionPending === true ||
        sourcePayload.firmaSeguroContactCorrectionPending === true;
      const financialCorrectionPending =
        sourcePayload.firmaSeguroFinancialCorrectionPending === true;
      const correctionPending =
        frozenCorrectionPending || financialCorrectionPending;
      const sourceRows = correctionPending ? await prisma.$queryRawUnsafe<
        Array<import("@/lib/firmaseguro-storage").FirmaSeguroProcessRow>>(
        `SELECT * FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "creditoId" IS NULL
          AND "supersededAt" IS NOT NULL
          AND ("completedAt" IS NOT NULL OR "signedDocumentBase64" IS NOT NULL)
          ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, draftId) : [];
      const source = sourceRows[0] || null;
      const priorProcess = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
        `SELECT "id" FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "creditoId" IS NULL
          ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, draftId);
      const financialRetryProcess = Boolean(
        financialCorrectionPending &&
        lockedCurrent &&
        !lockedCurrentReusable &&
        payloadObject(lockedCurrent.draftPayload)
          .firmaSeguroFinancialCorrectionId ===
          sourcePayload.firmaSeguroFinancialCorrectionId
      );
      if ((lockedCurrent || correctionPending || priorProcess.length > 0) &&
        (!source ||
          (source.id !== priorProcess[0]?.id &&
            !(financialRetryProcess && lockedCurrent?.id === priorProcess[0]?.id)))) {
        throw new CreditValidationError(
          "No se puede conservar de forma verificable el contrato anterior. Requiere revisión técnica antes de reenviar.",
          409, "FIRMASEGURO_SIGNED_SOURCE_UNAVAILABLE");
      }
      const draftFolio = lockedCurrent?.draftFolio ||
        sanitizeText(sourcePayload.firmaSeguroDraftFolio) || generateCreditFolio();
      const dispatchFolio = requiresFirstPaymentDateReissue ? generateCreditFolio() : draftFolio;
      let credit: CreditForFirmaSeguroPdf;
      let firstPaymentDateKey: string;
      let seal: ReturnType<typeof createFinancingTermsSeal>;
      if (source && frozenCorrectionPending) {
        try {
          const frozen = buildFrozenDraftCorrection({ draft: lockedAuthorized.row, source,
            folio: dispatchFolio, imei: sanitizeDeviceValue(sourcePayload.imei || sourcePayload.deviceUid).replace(/\D/g, "") });
          credit = frozen.credit;
          firstPaymentDateKey = frozen.firstPaymentDateKey;
          seal = frozen.seal;
        } catch (error) {
          throw new CreditValidationError(
            error instanceof Error && error.message === "FIRMASEGURO_FIRST_PAYMENT_DATE_CHANGED"
              ? "La fecha de primer pago del contrato firmado cambió. Revisa las condiciones antes de emitir otra firma."
              : "No se puede conservar el contrato firmado anterior. Requiere revisión técnica antes de reenviar.",
            409,
            error instanceof Error ? error.message : "FIRMASEGURO_SIGNED_SOURCE_UNAVAILABLE");
        }
      } else {
        const built = await buildDraftCredit(lockedAuthorized.row);
        credit = built.credit;
        firstPaymentDateKey = built.firstPaymentDateKey;
        credit.folio = dispatchFolio;
        credit.referenciaPago = generatePaymentReference(dispatchFolio, credit.clienteDocumento || "");
        seal = createFinancingTermsSeal({
          folio: dispatchFolio,
          documento: credit.clienteDocumento || "",
          contrato: { tipoDocumento: credit.clienteTipoDocumento || "", clienteNombre: credit.clienteNombre,
            clienteTelefono: credit.clienteTelefono || "", clienteCorreo: credit.clienteCorreo || "",
            clienteDireccion: credit.clienteDireccion || "", equipoMarca: credit.equipoMarca || "",
            equipoModelo: credit.equipoModelo || "", referenciaEquipo: credit.referenciaEquipo || "",
            imei: credit.imei || credit.deviceUid || "" },
          amortizacion: built.amortizationPlan,
          parametros: built.financingParameters,
        });
      }
      // Persist the exact values used to build the contract. Policy rules may
      // raise the minimum initial payment, so keeping the browser inputs here
      // would make the draft disagree with the signed seal and the remision.
      const payload: Record<string, unknown> = {
        ...sourcePayload,
        firmaSeguroDraftFolio: dispatchFolio,
        valorEquipoTotal: String(credit.valorEquipoTotal),
        cuotaInicial: String(credit.cuotaInicial),
        plazoMeses: String(credit.plazoMeses),
        frecuenciaPago: credit.frecuenciaPago,
        fechaPrimerPago: firstPaymentDateKey,
      };
      delete payload.financialTermsSeal;
      const firmaSeguroDraftPayload: Record<string, unknown> = { ...payload,
        financialTermsSeal: seal };
      delete firmaSeguroDraftPayload.iphoneSelfieCedulaDataUrl;
      delete firmaSeguroDraftPayload.iphoneSelfieCedulaCapturedAt;
      delete firmaSeguroDraftPayload.iphoneSelfieCedulaSource;
      const document = await buildFirmaSeguroCreditPdf(credit);
      const reserved = await reserveDraftDispatch({ id: key, draftId,
        actor: { id: actorUser.id, nombre: actorUser.nombre }, reason,
        expectedProcessUuid: lockedCurrent?.processUuid || null,
        sourcePayload: lockedAuthorized.row.payload, updatedPayload: payload,
        draftPayload: firmaSeguroDraftPayload, draftFolio: dispatchFolio,
        frozenCredit: credit, document,
        supersedeActive:
          requiresFirstPaymentDateReissue || financialRetryProcess });
      const dispatched = await dispatchReservedDraft(reserved.id);
      if (dispatched.status !== "AWAITING_SIGNATURE" || !dispatched.processUuid) {
        throw new DraftDispatchError("DRAFT_DISPATCH_UNRESOLVED",
          "El resultado del envío aún no está confirmado. Requiere conciliación antes de reenviar.");
      }
      const process = await getFirmaSeguroProcessByUuid(dispatched.processUuid);
      if (!process) throw new DraftDispatchError("DRAFT_DISPATCH_PROCESS_MISSING",
        "FirmaSeguro confirmó el envío, pero el proceso ya no está vigente. Actualiza el caso.");
      await recordDraftCorrectionReissue(draftId, process);
      return NextResponse.json({ ok: true, id: key, status: dispatched.status,
        process: serializeDraftFirmaSeguroProcess(process),
        message: financialCorrectionPending
          ? "FirmaSeguro confirmó el nuevo contrato con los valores corregidos."
          : requiresFirstPaymentDateReissue
          ? "El proceso anterior quedó en el historial. FirmaSeguro confirmó el nuevo envío con la fecha de pago actualizada."
          : "FirmaSeguro confirmó la solicitud de firma." });
    } finally {
      await dispatchLock.release();
    }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let draftIdForLog: number | null = null;
  try {
    const params = await context.params;
    const draftId = parseDraftId(params.id);
    draftIdForLog = draftId;

    if (!draftId) {
      return NextResponse.json(
        { ok: false, error: "Borrador invalido" },
        { status: 400 }
      );
    }

    const authorized = await readAuthorizedDraft(draftId, { operate: true });
    if (!authorized.ok) {
      return NextResponse.json(
        { ok: false, error: authorized.error },
        { status: authorized.status }
      );
    }

    const actorUser = await getSessionUser();
    if (!actorUser) {
      return NextResponse.json(
        { ok: false, error: "No autenticado" },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    return await requestDraftSignatureCore(draftId, authorized, actorUser, body, "commercial");
  } catch (error) {
    const blacklistResponse = documentBlacklistErrorResponse(error);
    if (blacklistResponse) return blacklistResponse;
    logFirmaSeguroDraftError("POST", draftIdForLog, error);
    return firmaSeguroErrorResponse(error);
  }
}

/** Shared business path with separate, nominal analyst authorization. */
export async function requestSafeDraftSignatureFromRoute(input: {
  draftId: number; actor: { id: number; nombre: string }; reason: string;
  idempotencyKey: string; expectedProcessUuid: string | null;
}) {
  if ((await getApprovalSharedRequestActor()) !== undefined) {
    throw new DraftDispatchError("DRAFT_DISPATCH_SHARED_ACCESS",
      "Usa tu cuenta personal de Aprobaciones.", 403);
  }
  const user = await getCreditApprovalSessionUser();
  if (!user || user.id !== input.actor.id) throw new DraftDispatchError(
    "DRAFT_DISPATCH_UNAUTHORIZED", "La sesión de Aprobaciones cambió. Actualiza el caso.", 403);
  const authorized = await readOperationalDraft(input.draftId, input.actor.id);
  let response: NextResponse;
  try {
    response = await requestDraftSignatureCore(input.draftId,
      authorized, user,
      { actorUserId: input.actor.id, reason: input.reason,
        idempotencyKey: input.idempotencyKey, expectedProcessUuid: input.expectedProcessUuid,
        requireCorrection: true }, "operational");
  } catch (error) {
    if (error instanceof CreditValidationError) {
      throw new DraftDispatchError(error.code, error.message, error.status);
    }
    throw error;
  }
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || body.ok !== true) {
    throw new DraftDispatchError(String(body.code || "DRAFT_DISPATCH_FAILED"),
      String(body.error || "No se pudo confirmar el envío de firma."), response.status);
  }
  if (body.id !== input.idempotencyKey || body.status !== "AWAITING_SIGNATURE") {
    throw new DraftDispatchError("DRAFT_DISPATCH_ALREADY_ACTIVE",
      "La solicitud ya tiene una firma vigente. Actualiza el caso antes de reenviar.");
  }
  const process = body.process && typeof body.process === "object"
    ? body.process as Record<string, unknown> : {};
  return { id: input.idempotencyKey,
    status: "AWAITING_SIGNATURE",
    message: String(body.message || "FirmaSeguro confirmó la solicitud de firma."),
    processUuid: typeof process.processUuid === "string" ? process.processUuid : undefined };
}
