import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getActiveSolicitudCreditContext } from "@/lib/solicitudes-storage";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { normalizeDataCreditoPlatform } from "@/lib/datacredito/policy";
import {
  buildDataCreditoIdentityHashes,
  dataCreditoAssessmentMatchesScope,
  getDataCreditoAssessmentById,
  getDataCreditoAssessmentDocumentState,
  getDataCreditoAssessmentResumeIdentity,
  normalizeDataCreditoDocument,
  normalizeDataCreditoSurname,
  serializeDataCreditoAssessment,
  type DataCreditoAssessmentScope,
} from "@/lib/datacredito/storage";
import { isAdminRole } from "@/lib/roles";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { canOperateSolicitud } from "@/lib/solicitud-operation-access";

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
  if (!admin && seller?.tipoPerfil !== "VENDEDOR") {
    return NextResponse.json(
      { ok: false, error: "Selecciona e ingresa con el perfil del asesor" },
      { status: 403 }
    );
  }
  const central = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);

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
  const requestedDocumentNumber = requestUrl.searchParams.get("documentNumber");
  const requestedFirstSurname = requestUrl.searchParams.get("firstSurname");
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
    const requestedDraft =
      row && draftId ? await getActiveSolicitudCreditContext(draftId) : null;
    const authorizedDraft = Boolean(
      canOperateSolicitud({
        central,
        seller,
        viewerAllyId: user.aliadoId,
        owner: requestedDraft,
      }) &&
        requestedDraft?.dataCreditoAssessmentId &&
        requestedDraft.dataCreditoAssessmentId.toLowerCase() === id.toLowerCase()
    );
    if (draftId && !authorizedDraft) {
      return NextResponse.json(
        { ok: false, error: "Evaluacion no encontrada" },
        { status: 404 }
      );
    }
    const scope: DataCreditoAssessmentScope = requestedDraft
      ? {
          userId: requestedDraft.usuarioId,
          sellerId: requestedDraft.vendedorId,
          sedeId: requestedDraft.sedeId,
          aliadoId: requestedDraft.aliadoId,
        }
      : {
          userId: user.id,
          sellerId: seller?.id || null,
          sedeId: user.sedeId,
          aliadoId: user.aliadoId || null,
        };
    if (!row || !dataCreditoAssessmentMatchesScope(row, scope)) {
      return NextResponse.json(
        { ok: false, error: "Evaluacion no encontrada" },
        { status: 404 }
      );
    }

    if (
      draftId &&
      (!requestedDraft?.dataCreditoAssessmentId ||
        requestedDraft.dataCreditoAssessmentId.toLowerCase() !== id.toLowerCase())
    ) {
      return NextResponse.json(
        { ok: false, error: "Evaluacion no encontrada" },
        { status: 404 }
      );
    }

    const draftDocument = requestedDraft?.clienteDocumento || "";
    const draftSurname = requestedDraft?.clientePrimerApellido || "";
    const draftIdentity =
      draftId && draftDocument && draftSurname
        ? buildDataCreditoIdentityHashes({
            documentNumber: draftDocument,
            firstSurname: draftSurname,
          })
        : null;
    const draftIdentityMatches = Boolean(
      draftIdentity &&
        draftIdentity.documentHash === row.documentHash &&
        draftIdentity.surnameHash === row.surnameHash
    );
    const resumeIdentity =
      draftId && requestedDraft && !draftIdentityMatches
        ? await getDataCreditoAssessmentResumeIdentity(
            id,
            requestedDraft.clienteDocumento
          )
        : null;
    const identityDocument = draftId
      ? resumeIdentity?.documentNumber || draftDocument
      : requestedDocumentNumber || "";
    const identitySurname = draftId
      ? resumeIdentity?.firstSurname || draftSurname
      : requestedFirstSurname || "";

    if (
      draftId ||
      requestedDocumentNumber !== null ||
      requestedFirstSurname !== null
    ) {
      const identity = buildDataCreditoIdentityHashes({
        documentNumber: identityDocument,
        firstSurname: identitySurname,
      });

      if (
        !identityDocument ||
        !identitySurname ||
        identity.documentHash !== row.documentHash ||
        identity.surnameHash !== row.surnameHash
      ) {
        return NextResponse.json(
          {
            ok: false,
            status: "NO_EVALUADO",
            code: "ASSESSMENT_IDENTITY_MISMATCH",
            error:
              "La cedula o el primer apellido ya no coinciden con la consulta de DataCredito. Recarga los datos del titular antes de continuar.",
            correlationId: row.correlationId,
          },
          { status: 409 }
        );
      }
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

    return NextResponse.json({
      ok: true,
      ...serializeDataCreditoAssessment(row),
      ...(draftId
        ? {
            documentNumber: normalizeDataCreditoDocument(identityDocument),
            firstSurname: normalizeDataCreditoSurname(identitySurname),
          }
        : {}),
    });
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
