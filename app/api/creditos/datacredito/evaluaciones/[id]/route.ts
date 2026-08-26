import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getActiveSolicitudCreditContext } from "@/lib/solicitudes-storage";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { normalizeDataCreditoPlatform } from "@/lib/datacredito/policy";
import {
  dataCreditoAssessmentMatchesScope,
  getDataCreditoAssessmentById,
  getDataCreditoAssessmentDocumentState,
  serializeDataCreditoAssessment,
  type DataCreditoAssessmentScope,
} from "@/lib/datacredito/storage";
import { isAdminRole } from "@/lib/roles";
import { getSellerSessionUser } from "@/lib/seller-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
  }

  const admin = isAdminRole(user.rolNombre);
  const seller = admin ? null : await getSellerSessionUser(user);
  if (!admin && !seller) {
    return NextResponse.json(
      { ok: false, error: "Selecciona e ingresa con el perfil del asesor" },
      { status: 403 }
    );
  }

  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ ok: false, error: "Evaluacion no encontrada" }, { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const requestedDraftId = requestUrl.searchParams.get("draftId");
  const draftId =
    requestedDraftId && /^\d+$/.test(requestedDraftId)
      ? Number(requestedDraftId)
      : null;
  const requestedPlatform = requestUrl.searchParams.get("platform");
  const expectedPlatform =
    requestedPlatform === null
      ? null
      : normalizeDataCreditoPlatform(requestedPlatform);
  if (requestedPlatform !== null && !expectedPlatform) {
    return NextResponse.json(
      {
        ok: false,
        status: "NO_EVALUADO",
        code: "INVALID_PLATFORM",
        error: "La plataforma debe ser ANDROID o IPHONE.",
      },
      { status: 400 }
    );
  }

  try {
    const row = await getDataCreditoAssessmentById(id);
    const scope: DataCreditoAssessmentScope = {
      userId: user.id,
      sellerId: seller?.id || null,
      sedeId: user.sedeId,
      aliadoId: user.aliadoId || null,
    };

    const centralDraft =
      row &&
      admin &&
      isFinserPayCentralAlly(user.aliadoAccesoCodigo) &&
      draftId
        ? await getActiveSolicitudCreditContext(draftId)
        : null;
    const assessmentBelongsToCentralDraft = Boolean(
      centralDraft?.dataCreditoAssessmentId &&
        centralDraft.dataCreditoAssessmentId.toLowerCase() === id.toLowerCase()
    );
    if (
      !row ||
      (!dataCreditoAssessmentMatchesScope(row, scope) &&
        !assessmentBelongsToCentralDraft)
    ) {
      return NextResponse.json(
        { ok: false, error: "Evaluacion no encontrada" },
        { status: 404 }
      );
    }

    if (expectedPlatform && row.platform !== expectedPlatform) {
      return NextResponse.json(
        {
          ok: false,
          status: "NO_EVALUADO",
          code: "ASSESSMENT_PLATFORM_MISMATCH",
          error: "La evaluacion corresponde a otra plataforma.",
          correlationId: row.correlationId,
        },
        { status: 409 }
      );
    }

    if (row.consumedAt) {
      return NextResponse.json(
        {
          ok: false,
          status: "NO_EVALUADO",
          code: "ASSESSMENT_CONSUMED",
          error: "Esta evaluacion ya fue utilizada en una solicitud",
          creditId: row.creditId,
          correlationId: row.correlationId,
        },
        { status: 409 }
      );
    }

    const documentState = await getDataCreditoAssessmentDocumentState(row);
    if (documentState.consumedElsewhere) {
      return NextResponse.json(
        {
          ok: false,
          status: "NO_EVALUADO",
          code: "ASSESSMENT_CONSUMED_ELSEWHERE",
          error: "La consulta vigente ya fue utilizada en otra solicitud.",
          correlationId: row.correlationId,
        },
        { status: 409 }
      );
    }
    if (documentState.inProgress) {
      return NextResponse.json(
        {
          ok: false,
          status: "NO_EVALUADO",
          code: "EVALUATION_IN_PROGRESS",
          error: "La evaluacion ya se esta utilizando en otra solicitud.",
          correlationId: row.correlationId,
        },
        { status: 409 }
      );
    }

    const provider = getDataCreditoPublicConfig();
    if (row.providerEnvironment !== provider.environment) {
      return NextResponse.json(
        {
          ok: false,
          status: "NO_EVALUADO",
          code: "ASSESSMENT_ENVIRONMENT_MISMATCH",
          error: "La evaluacion corresponde a otro ambiente de DataCredito.",
          correlationId: row.correlationId,
        },
        { status: 409 }
      );
    }

    const expiresAt =
      row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      return NextResponse.json(
        {
          ok: false,
          status: "NO_EVALUADO",
          code: "ASSESSMENT_EXPIRED",
          error: "La evaluacion vencio. Realiza una nueva consulta.",
          correlationId: row.correlationId,
        },
        { status: 410 }
      );
    }

    if (row.status === "PENDING") {
      return NextResponse.json(
        {
          ok: false,
          status: "NO_EVALUADO",
          code: "EVALUATION_IN_PROGRESS",
          error: "La evaluacion continua en proceso",
          correlationId: row.correlationId,
        },
        { status: 202 }
      );
    }

    if (row.status === "NO_EVALUADO") {
      return NextResponse.json(
        {
          ok: false,
          status: "NO_EVALUADO",
          code: row.errorCode || "EVALUATION_ERROR",
          error: "No fue posible completar la evaluacion crediticia",
          correlationId: row.correlationId,
        },
        { status: 422 }
      );
    }

    return NextResponse.json({ ok: true, ...serializeDataCreditoAssessment(row) });
  } catch (error) {
    console.error("ERROR GET EVALUACION DATACREDITO:", {
      id,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { ok: false, error: "No se pudo consultar la evaluacion" },
      { status: 500 }
    );
  }
}
