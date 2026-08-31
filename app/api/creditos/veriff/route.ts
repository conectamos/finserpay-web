import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  PAYMENT_FREQUENCY_OPTIONS,
  sanitizeText,
  toNumber,
} from "@/lib/credit-factory";
import prisma from "@/lib/prisma";
import {
  createVeriffValidation,
  getVeriffValidationById,
  getReusableVeriffValidationForDraft,
  serializeVeriffValidation,
  updateVeriffValidation,
} from "@/lib/veriff-storage";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { canOperateVeriffDraft } from "@/lib/veriff-access";
import { expireStaleSolicitudes } from "@/lib/solicitudes-storage";
import { tryAcquireSolicitudOperationLock } from "@/lib/firmaseguro-storage";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { getApprovedDataCreditoAssessmentForCredit } from "@/lib/datacredito/storage";
import {
  extractVeriffSessionId,
  extractVeriffSessionUrl,
  getVeriffPublicSummary,
  isVeriffConfigured,
  redactVeriffPayload,
  veriffCreateSession,
  VeriffApiError,
} from "@/lib/veriff";
import { buildVeriffCompletionUrl } from "@/lib/veriff-callback";
import { getVeriffRetryPolicy } from "@/lib/veriff-retry-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VeriffCreateBody = {
  captureToken?: string | null;
  clienteDocumento?: string | null;
  clientePrimerApellido?: string | null;
  clientePrimerNombre?: string | null;
  clienteTipoDocumento?: string | null;
  currentValidationId?: number | string | null;
  draftId?: number | string | null;
  regenerate?: boolean | null;
};

type VeriffDraftAccessRow = {
  id: number;
  estado: string;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  aliadoId: number | null;
  clienteDocumento: string | null;
  currentStep: number;
  payload: unknown;
  plataforma: string | null;
};

type DraftPayload = Record<string, unknown>;

function parsePositiveId(value: unknown) {
  const parsed = Math.trunc(toNumber(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function payloadObject(value: unknown): DraftPayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as DraftPayload)
    : {};
}

async function readVeriffDraftAccess(draftId: number) {
  await expireStaleSolicitudes();
  const rows = await prisma.$queryRawUnsafe<VeriffDraftAccessRow[]>(
    `
      SELECT d."id", d."estado", d."usuarioId", d."vendedorId", d."sedeId",
        d."clienteDocumento", d."currentStep", d."payload", s."aliadoId",
        COALESCE(
          NULLIF(d."plataforma", ''),
          NULLIF(d."payload"->>'plataformaDispositivo', '')
        ) AS "plataforma"
      FROM "CreditoBorrador" d
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      WHERE d."id" = $1
        AND d."estado" = 'ABIERTO'
        AND d."creditoId" IS NULL
        AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
      LIMIT 1
    `,
    draftId
  );
  return rows[0] || null;
}

async function validateDraftReadyForVeriff(
  draft: VeriffDraftAccessRow,
  platform: "ANDROID" | "IPHONE"
) {
  if (Number(draft.currentStep || 0) < 4) {
    return {
      ok: false as const,
      code: "VERIFF_STEP_NOT_READY",
      error:
        "Completa primero la información del cliente y del equipo antes de validar la identidad.",
    };
  }

  const payload = payloadObject(draft.payload);
  const imei = sanitizeText(payload.imei || payload.deviceUid).replace(/\D/g, "");
  const equipmentValue = toNumber(payload.valorEquipoTotal);
  const initialPayment = toNumber(payload.cuotaInicial);
  const installmentCount = Math.trunc(toNumber(payload.plazoMeses));
  const paymentFrequency = sanitizeText(payload.frecuenciaPago).toUpperCase();
  const firstPaymentDate = sanitizeText(payload.fechaPrimerPago);
  const equipmentReady = Boolean(
    sanitizeText(payload.equipoMarca) &&
      sanitizeText(payload.equipoModelo) &&
      /^\d{15}$/.test(imei) &&
      equipmentValue > 0 &&
      initialPayment >= 0 &&
      equipmentValue - initialPayment > 0 &&
      installmentCount > 0 &&
      PAYMENT_FREQUENCY_OPTIONS.some(
        (option) => option.value === paymentFrequency
      ) &&
      /^\d{4}-\d{2}-\d{2}$/.test(firstPaymentDate)
  );

  if (!equipmentReady) {
    return {
      ok: false as const,
      code: "VERIFF_EQUIPMENT_NOT_READY",
      error:
        "Completa el equipo, el IMEI y el plan financiero antes de validar la identidad.",
    };
  }

  const dataCreditoConfig = getDataCreditoPublicConfig();
  if (!dataCreditoConfig.enabled) {
    return { ok: true as const };
  }
  const assessment = await getApprovedDataCreditoAssessmentForCredit({
    assessmentId: sanitizeText(payload.dataCreditoAssessmentId),
    documentNumber: String(draft.clienteDocumento || "").replace(/\D/g, ""),
    firstSurname: sanitizeText(payload.clientePrimerApellido),
    platform,
    providerEnvironment: dataCreditoConfig.environment,
    userId: draft.usuarioId,
    sellerId: draft.vendedorId,
    sedeId: draft.sedeId,
    aliadoId: draft.aliadoId,
  });

  if (!assessment) {
    return {
      ok: false as const,
      code: "VERIFF_DATACREDITO_NOT_APPROVED",
      error:
        "La solicitud no tiene una consulta DataCrédito aprobada y vigente para iniciar Veriff.",
    };
  }

  return { ok: true as const };
}

function buildVendorData(params: {
  draftId: number | null;
  sedeId: number;
}) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const draftPart = params.draftId ? `D${params.draftId}` : "SINBORRADOR";
  return `FINSERPAY-${params.sedeId}-${draftPart}-${suffix}`;
}

function veriffErrorResponse(error: unknown) {
  if (error instanceof VeriffApiError) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        remoteStatus: error.status,
        remotePayload: redactVeriffPayload(error.payload),
      },
      { status: error.status >= 500 ? 502 : error.status }
    );
  }

  const message =
    error instanceof Error
      ? error.message
      : "No se pudo procesar la validacion con Veriff";

  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}

export async function GET() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    veriff: getVeriffPublicSummary(),
  });
}

export async function POST(request: Request) {
  let operationLock:
    | Awaited<ReturnType<typeof tryAcquireSolicitudOperationLock>>
    | null = null;

  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    if (!isVeriffConfigured()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Veriff no esta configurado. Define VERIFF_BASE_URL, VERIFF_API_KEY y VERIFF_SHARED_SECRET.",
        },
        { status: 503 }
      );
    }

    const sellerSession = await getSellerSessionUser(user);
    const body = (await request.json().catch(() => ({}))) as VeriffCreateBody;
    const draftId = parsePositiveId(body.draftId);

    if (!draftId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Primero guarda el borrador de la venta antes de crear la validacion Veriff.",
        },
        { status: 400 }
      );
    }

    let draft = await readVeriffDraftAccess(draftId);
    if (!draft || !canOperateVeriffDraft(user, draft, sellerSession)) {
      return NextResponse.json(
        { ok: false, error: "Borrador no encontrado" },
        { status: 404 }
      );
    }

    const requestedDocument = sanitizeText(body.clienteDocumento).replace(/\D/g, "");
    let clienteDocumento = String(draft.clienteDocumento || "").replace(/\D/g, "");
    if (!clienteDocumento || requestedDocument !== clienteDocumento) {
      return NextResponse.json(
        {
          ok: false,
          error: "La cedula no corresponde al borrador autorizado",
        },
        { status: 409 }
      );
    }

    operationLock = await tryAcquireSolicitudOperationLock(draftId);
    if (!operationLock) {
      return NextResponse.json(
        {
          ok: false,
          code: "SOLICITUD_OPERACION_EN_PROCESO",
          error:
            "La solicitud ya se está procesando. Intenta nuevamente en unos segundos.",
          retryable: true,
        },
        { status: 409, headers: { "Retry-After": "2" } }
      );
    }

    draft = await readVeriffDraftAccess(draftId);
    if (!draft || !canOperateVeriffDraft(user, draft, sellerSession)) {
      return NextResponse.json(
        { ok: false, error: "Borrador no encontrado" },
        { status: 404 }
      );
    }

    clienteDocumento = String(draft.clienteDocumento || "").replace(/\D/g, "");
    if (!clienteDocumento || requestedDocument !== clienteDocumento) {
      return NextResponse.json(
        {
          ok: false,
          error: "La cedula no corresponde al borrador autorizado",
        },
        { status: 409 }
      );
    }
    const lockedPlatform = String(draft.plataforma || "").trim().toUpperCase();
    if (!["ANDROID", "IPHONE"].includes(lockedPlatform)) {
      return NextResponse.json(
        {
          ok: false,
          code: "SOLICITUD_PLATAFORMA_INVALIDA",
          error: "La plataforma de la solicitud no está definida correctamente.",
        },
        { status: 409 }
      );
    }
    const platform = lockedPlatform === "IPHONE" ? "IPHONE" : "ANDROID";
    const readiness = await validateDraftReadyForVeriff(draft, platform);
    if (!readiness.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: readiness.code,
          error: readiness.error,
        },
        { status: 409 }
      );
    }

    const clientePrimerNombre = sanitizeText(body.clientePrimerNombre);
    const clientePrimerApellido = sanitizeText(body.clientePrimerApellido);
    const clienteNombre = [clientePrimerNombre, clientePrimerApellido]
      .filter(Boolean)
      .join(" ");
    const retryPolicy = await getVeriffRetryPolicy(draftId);

    if (retryPolicy.applicationRejected) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "La solicitud fue rechazada despues de agotar los intentos de validacion de identidad.",
          retryPolicy,
        },
        { status: 409 }
      );
    }

    const regenerate = body.regenerate === true;
    const currentValidationId = parsePositiveId(body.currentValidationId);
    if (regenerate && !currentValidationId) {
      return NextResponse.json(
        {
          ok: false,
          code: "VERIFF_REGENERATION_TARGET_REQUIRED",
          error:
            "Actualiza la validación antes de regenerar el código QR.",
        },
        { status: 409 }
      );
    }

    const reusableValidation = await getReusableVeriffValidationForDraft({
      aliadoId: draft.aliadoId,
      clienteDocumento,
      draftId,
      sedeId: draft.sedeId,
    });

    if (regenerate && currentValidationId) {
      const expectedValidation = await getVeriffValidationById(
        currentValidationId
      );
      const expectedDocument = String(
        expectedValidation?.clienteDocumento || ""
      ).replace(/\D/g, "");
      const latestRows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
        `
          SELECT validation."id"
          FROM "VeriffIdentityValidation" validation
          WHERE validation."draftId" = $1
            AND validation."creditoId" IS NULL
          ORDER BY validation."id" DESC
          LIMIT 1
        `,
        draftId
      );
      const expectedSerialized = serializeVeriffValidation(expectedValidation);

      if (
        !expectedValidation ||
        expectedValidation.draftId !== draftId ||
        expectedValidation.creditoId ||
        expectedDocument !== clienteDocumento ||
        Number(latestRows[0]?.id || 0) !== currentValidationId ||
        (reusableValidation && reusableValidation.id !== currentValidationId)
      ) {
        return NextResponse.json(
          {
            ok: false,
            code: "VERIFF_REGENERATION_STALE",
            error:
              "La validación cambió. Actualiza el estado antes de regenerar el código QR.",
          },
          { status: 409 }
        );
      }

      const technicalRetryStatus = expectedSerialized?.identityDocumentStatus;
      if (
        expectedSerialized?.approved &&
        technicalRetryStatus !== "conflict" &&
        technicalRetryStatus !== "missing"
      ) {
        return NextResponse.json(
          {
            ok: false,
            code: "VERIFF_ALREADY_APPROVED",
            error: "La identidad ya fue aprobada y no requiere otro código QR.",
          },
          { status: 409 }
        );
      }

      if (reusableValidation) {
        await updateVeriffValidation(reusableValidation.id, {
          decidedAt: new Date(),
          decision: "ABANDONED",
          lastError: null,
          reason: "Código QR regenerado por el asesor",
          reasonCode: "QR_REGENERATED",
          status: "ABANDONED",
        });
      }
    } else if (reusableValidation) {
      return NextResponse.json({
        ok: true,
        retryPolicy,
        reused: true,
        validation: serializeVeriffValidation(reusableValidation),
        veriff: getVeriffPublicSummary(),
      });
    }

    const vendorData = buildVendorData({
      draftId,
      sedeId: draft.sedeId,
    });
    const endUserId = randomUUID();
    const validationReservation = await createVeriffValidation({
      aliadoId: draft.aliadoId,
      captureToken: sanitizeText(body.captureToken) || null,
      clienteDocumento,
      clienteNombre,
      draftId,
      endUserId,
      requestPayload: {
        clienteDocumento,
        clienteNombre,
        draftId,
        flow: "veriff-qr",
      },
      sedeId: draft.sedeId,
      usuarioId: draft.usuarioId,
      vendedorId: draft.vendedorId,
      vendorData,
    });

    const validation = validationReservation.row;

    if (!validation) {
      return NextResponse.json(
        {
          ok: false,
          code: "VERIFF_DRAFT_UNAVAILABLE",
          error:
            "La solicitud ya no está disponible para iniciar otra validación facial.",
        },
        { status: 409 }
      );
    }

    if (!validationReservation.created) {
      const serializedValidation = serializeVeriffValidation(validation);

      if (serializedValidation?.sessionUrl) {
        return NextResponse.json({
          ok: true,
          retryPolicy,
          reused: true,
          validation: serializedValidation,
          veriff: getVeriffPublicSummary(),
        });
      }

      return NextResponse.json(
        {
          ok: false,
          code: "VERIFF_SESSION_PREPARING",
          error:
            "Ya se está preparando una validación facial para esta solicitud. Intenta nuevamente en unos segundos.",
          retryable: true,
          retryPolicy,
          validation: serializedValidation,
        },
        { status: 409 }
      );
    }

    const createPayload = await veriffCreateSession({
      callbackUrl: buildVeriffCompletionUrl(request),
      documentNumber: clienteDocumento,
      documentType: sanitizeText(body.clienteTipoDocumento),
      endUserId,
      firstName: clientePrimerNombre,
      lastName: clientePrimerApellido,
      vendorData,
    });
    const sessionId = extractVeriffSessionId(createPayload);
    const sessionUrl = extractVeriffSessionUrl(createPayload);

    if (!sessionId || !sessionUrl) {
      await updateVeriffValidation(validation.id, {
        createPayload,
        lastError: "Veriff no retorno session id o URL",
        status: "ERROR",
      });
      return NextResponse.json(
        { ok: false, error: "Veriff no retorno session id o URL" },
        { status: 502 }
      );
    }

    const row = await updateVeriffValidation(validation.id, {
      createPayload,
      status: "CREATED",
      veriffSessionId: sessionId,
    });

    return NextResponse.json({
      retryPolicy,
      ok: true,
      validation: serializeVeriffValidation(row),
      veriff: getVeriffPublicSummary(),
    });
  } catch (error) {
    return veriffErrorResponse(error);
  } finally {
    await operationLock?.release();
  }
}
