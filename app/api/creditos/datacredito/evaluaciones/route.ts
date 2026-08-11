import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  DataCreditoError,
  getDataCreditoPublicConfig,
  queryDataCreditoNaturalPerson,
} from "@/lib/datacredito";
import { isDataCreditoUniqueViolation } from "@/lib/datacredito/database-errors";
import {
  normalizeDataCreditoPlatform,
  resolveDataCreditoDecision,
} from "@/lib/datacredito/policy";
import {
  buildDataCreditoIdentityHashes,
  completeDataCreditoAssessment,
  DataCreditoStorageConfigurationError,
  failDataCreditoAssessment,
  getCurrentDataCreditoPolicy,
  hashDataCreditoRequestMetadata,
  isDataCreditoAuditConfigured,
  normalizeDataCreditoDocument,
  normalizeDataCreditoSurname,
  reserveDataCreditoAssessment,
  serializeDataCreditoAssessment,
  type DataCreditoAssessmentScope,
} from "@/lib/datacredito/storage";
import { isAdminRole } from "@/lib/roles";
import { getSellerSessionUser } from "@/lib/seller-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EvaluationBody = {
  documentNumber?: unknown;
  firstSurname?: unknown;
  platform?: unknown;
  consentAccepted?: unknown;
};

function technicalResponse(input: {
  correlationId: string;
  code: string;
  error: string;
  status: number;
}) {
  return NextResponse.json(
    {
      ok: false,
      status: "NO_EVALUADO",
      error: input.error,
      code: input.code,
      correlationId: input.correlationId,
    },
    { status: input.status }
  );
}

function safeProviderValue(value: unknown, maximumLength: number) {
  const normalized = String(value || "")
    .replace(/[^A-Za-z0-9 _.:/-]/g, "")
    .trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function safeDuration(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 300_000 ? parsed : null;
}

function clientErrorStatus(error: DataCreditoError) {
  const status = Number(error.httpStatus);
  return [400, 409, 422, 429, 502, 503, 504].includes(status) ? status : 502;
}

function extractRequestMetadata(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") || "";
  const ip = forwardedFor.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "";
  const userAgent = request.headers.get("user-agent") || "";
  return {
    ipHash: hashDataCreditoRequestMetadata("ip", ip),
    userAgentHash: hashDataCreditoRequestMetadata("user-agent", userAgent),
  };
}

export async function POST(request: Request) {
  const correlationId = randomUUID();
  let pendingAssessmentId: string | null = null;
  let providerStartedAt: number | null = null;

  try {
    const user = await getSessionUser();
    if (!user) {
      return technicalResponse({
        correlationId,
        code: "UNAUTHENTICATED",
        error: "No autenticado",
        status: 401,
      });
    }

    const admin = isAdminRole(user.rolNombre);
    const seller = admin ? null : await getSellerSessionUser(user);
    if (!admin && !seller) {
      return technicalResponse({
        correlationId,
        code: "SELLER_SESSION_REQUIRED",
        error: "Selecciona e ingresa con el perfil del asesor antes de consultar",
        status: 403,
      });
    }

    const body = (await request.json().catch(() => null)) as EvaluationBody | null;
    if (!body) {
      return technicalResponse({
        correlationId,
        code: "INVALID_REQUEST",
        error: "La solicitud no tiene un formato valido",
        status: 400,
      });
    }

    const platform = normalizeDataCreditoPlatform(body.platform);
    const rawDocumentNumber = String(body.documentNumber || "").trim();
    const documentNumber = normalizeDataCreditoDocument(rawDocumentNumber);
    const firstSurname = normalizeDataCreditoSurname(body.firstSurname);

    if (!platform) {
      return technicalResponse({
        correlationId,
        code: "INVALID_PLATFORM",
        error: "Selecciona Android o iPhone",
        status: 400,
      });
    }
    if (
      rawDocumentNumber !== documentNumber ||
      !/^\d{3,13}$/.test(documentNumber)
    ) {
      return technicalResponse({
        correlationId,
        code: "INVALID_DOCUMENT",
        error: "La cedula debe tener entre 3 y 13 digitos",
        status: 400,
      });
    }
    if (
      firstSurname.length > 80 ||
      !/^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u.test(firstSurname)
    ) {
      return technicalResponse({
        correlationId,
        code: "INVALID_SURNAME",
        error: "Ingresa el primer apellido usando solo letras",
        status: 400,
      });
    }
    if (body.consentAccepted !== true) {
      return technicalResponse({
        correlationId,
        code: "CONSENT_REQUIRED",
        error: "Debes confirmar la autorizacion previa del titular antes de consultar",
        status: 400,
      });
    }

    const provider = getDataCreditoPublicConfig();
    if (!provider.enabled) {
      return technicalResponse({
        correlationId,
        code: "DATACREDITO_DISABLED",
        error: "La evaluacion crediticia no esta habilitada en este ambiente",
        status: 503,
      });
    }
    if (!provider.configured) {
      return technicalResponse({
        correlationId,
        code: "DATACREDITO_NOT_CONFIGURED",
        error: "La evaluacion crediticia aun no esta configurada",
        status: 503,
      });
    }
    if (!isDataCreditoAuditConfigured()) {
      return technicalResponse({
        correlationId,
        code: "AUDIT_NOT_CONFIGURED",
        error: "La auditoria segura de la evaluacion aun no esta configurada",
        status: 503,
      });
    }

    const policy = await getCurrentDataCreditoPolicy();
    if (!policy) {
      return technicalResponse({
        correlationId,
        code: "POLICY_NOT_CONFIGURED",
        error: "La politica de evaluacion aun no esta configurada",
        status: 503,
      });
    }

    const scope: DataCreditoAssessmentScope = {
      userId: user.id,
      sellerId: seller?.id || null,
      sedeId: user.sedeId,
      aliadoId: user.aliadoId || null,
    };
    const hashes = buildDataCreditoIdentityHashes({ documentNumber, firstSurname });

    const metadata = extractRequestMetadata(request);
    let reservation;
    try {
      reservation = await reserveDataCreditoAssessment({
        platform,
        ...scope,
        ...hashes,
        correlationId,
        consentAt: new Date(),
        ...metadata,
        policyVersion: policy.version,
      });
    } catch (error) {
      if (isDataCreditoUniqueViolation(error)) {
        return technicalResponse({
          correlationId,
          code: "EVALUATION_IN_PROGRESS",
          error: "Ya existe una evaluacion en proceso para esta solicitud",
          status: 409,
        });
      }
      throw error;
    }

    if (reservation.kind === "REUSED") {
      return NextResponse.json({
        ok: true,
        reused: true,
        ...serializeDataCreditoAssessment(reservation.assessment),
      });
    }
    if (reservation.kind === "IN_PROGRESS") {
      return technicalResponse({
        correlationId,
        code: "EVALUATION_IN_PROGRESS",
        error: "Ya existe una evaluacion en proceso para esta solicitud",
        status: 409,
      });
    }
    if (reservation.kind === "RATE_LIMITED") {
      return technicalResponse({
        correlationId,
        code: "RATE_LIMITED",
        error: "Se alcanzo el limite temporal de consultas. Intenta mas tarde.",
        status: 429,
      });
    }

    const pending = reservation.assessment;
    if (!pending) {
      throw new Error("No se pudo crear la auditoria de evaluacion");
    }
    pendingAssessmentId = pending.id;

    providerStartedAt = Date.now();
    const result = await queryDataCreditoNaturalPerson({
      documentNumber,
      firstSurname,
      correlationId,
    });
    const transactionCode = safeProviderValue(result.transactionCode, 32);
    const providerStatus = safeProviderValue(result.providerStatus, 64);
    const durationMs = safeDuration(result.durationMs);

    if (
      !result.hasInformation ||
      !Number.isInteger(result.score) ||
      Number(result.score) < 0 ||
      Number(result.score) > 950
    ) {
      await failDataCreditoAssessment({
        id: pending.id,
        errorCode: "NO_EVALUABLE_INFORMATION",
        transactionCode,
        providerStatus,
        durationMs,
      });
      return technicalResponse({
        correlationId,
        code: "NO_EVALUABLE_INFORMATION",
        error: "DataCredito no retorno informacion suficiente para evaluar la solicitud",
        status: 422,
      });
    }

    const resolution = resolveDataCreditoDecision(policy, platform, result.score);
    if (!resolution) {
      await failDataCreditoAssessment({
        id: pending.id,
        errorCode: "POLICY_NO_MATCH",
        transactionCode,
        providerStatus,
        durationMs,
      });
      return technicalResponse({
        correlationId,
        code: "POLICY_NO_MATCH",
        error: "La politica activa no permite evaluar este puntaje",
        status: 500,
      });
    }

    const completed = await completeDataCreditoAssessment({
      id: pending.id,
      score: Number(result.score),
      decision: resolution.decision,
      offer: resolution.offer,
      transactionCode,
      providerStatus,
      durationMs,
    });
    if (!completed) {
      throw new Error("No se pudo finalizar la auditoria de evaluacion");
    }

    return NextResponse.json({
      ok: true,
      reused: false,
      ...serializeDataCreditoAssessment(completed),
    });
  } catch (error) {
    const code =
      error instanceof DataCreditoError
        ? safeProviderValue(error.code, 64) || "PROVIDER_ERROR"
        : error instanceof DataCreditoStorageConfigurationError
          ? error.code
          : "EVALUATION_ERROR";

    if (pendingAssessmentId) {
      await failDataCreditoAssessment({
        id: pendingAssessmentId,
        errorCode: code,
        providerStatus:
          error instanceof DataCreditoError && error.providerHttpStatus
            ? `HTTP ${error.providerHttpStatus}`
            : null,
        durationMs: providerStartedAt ? Date.now() - providerStartedAt : null,
      }).catch(() => undefined);
    }

    console.error("ERROR EVALUACION DATACREDITO:", {
      correlationId,
      code,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });

    return technicalResponse({
      correlationId,
      code,
      error: "No fue posible completar la evaluacion crediticia. Intenta nuevamente.",
      status:
        error instanceof DataCreditoError
          ? clientErrorStatus(error)
          : error instanceof DataCreditoStorageConfigurationError
            ? 503
            : 500,
    });
  }
}
