import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  sanitizeImageDataUrl,
  sanitizeText,
  toNumber,
} from "@/lib/credit-factory";
import {
  createVeriffValidation,
  serializeVeriffValidation,
  updateVeriffValidation,
  updateVeriffValidationFromDecision,
} from "@/lib/veriff-storage";
import { getSellerSessionUser } from "@/lib/seller-auth";
import {
  extractVeriffSessionId,
  getVeriffPublicSummary,
  isVeriffConfigured,
  redactVeriffPayload,
  veriffCreateSession,
  veriffGetDecision,
  veriffSubmitSession,
  veriffUploadMedia,
  VeriffApiError,
} from "@/lib/veriff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VeriffCreateBody = {
  captureToken?: string | null;
  clienteDocumento?: string | null;
  clientePrimerApellido?: string | null;
  clientePrimerNombre?: string | null;
  clienteTipoDocumento?: string | null;
  contratoCedulaFrenteCapturedAt?: string | null;
  contratoCedulaFrenteDataUrl?: string | null;
  contratoCedulaRespaldoCapturedAt?: string | null;
  contratoCedulaRespaldoDataUrl?: string | null;
  contratoSelfieCapturedAt?: string | null;
  contratoSelfieDataUrl?: string | null;
  draftId?: number | string | null;
};

function parsePositiveId(value: unknown) {
  const parsed = Math.trunc(toNumber(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildVendorData(params: {
  documento: string;
  draftId: number | null;
  sedeId: number;
}) {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const documentPart = params.documento.replace(/\D/g, "").slice(-8) || "CLIENTE";
  const draftPart = params.draftId ? `D${params.draftId}` : "SINBORRADOR";
  return `FINSERPAY-${params.sedeId}-${draftPart}-${documentPart}-${suffix}`;
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
    const clienteDocumento = sanitizeText(body.clienteDocumento);
    const clientePrimerNombre = sanitizeText(body.clientePrimerNombre);
    const clientePrimerApellido = sanitizeText(body.clientePrimerApellido);
    const clienteNombre = [clientePrimerNombre, clientePrimerApellido]
      .filter(Boolean)
      .join(" ");
    const selfieDataUrl = sanitizeImageDataUrl(body.contratoSelfieDataUrl);
    const cedulaFrenteDataUrl = sanitizeImageDataUrl(
      body.contratoCedulaFrenteDataUrl
    );
    const cedulaRespaldoDataUrl = sanitizeImageDataUrl(
      body.contratoCedulaRespaldoDataUrl
    );

    if (!clienteDocumento || !clientePrimerNombre || !clientePrimerApellido) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Completa nombre, apellido y documento antes de validar identidad con Veriff.",
        },
        { status: 400 }
      );
    }

    if (!selfieDataUrl || !cedulaFrenteDataUrl || !cedulaRespaldoDataUrl) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Debes capturar selfie y cedula por ambos lados antes de validar con Veriff.",
        },
        { status: 400 }
      );
    }

    const vendorData = buildVendorData({
      documento: clienteDocumento,
      draftId,
      sedeId: user.sedeId,
    });
    const validation = await createVeriffValidation({
      aliadoId: user.aliadoId || null,
      captureToken: sanitizeText(body.captureToken) || null,
      clienteDocumento,
      clienteNombre,
      draftId,
      endUserId: vendorData,
      requestPayload: {
        clienteDocumento,
        clienteNombre,
        draftId,
        evidence: {
          cedulaFrente: Boolean(cedulaFrenteDataUrl),
          cedulaRespaldo: Boolean(cedulaRespaldoDataUrl),
          selfie: Boolean(selfieDataUrl),
        },
      },
      sedeId: user.sedeId,
      usuarioId: user.id,
      vendedorId: sellerSession?.id || null,
      vendorData,
    });

    if (!validation) {
      throw new Error("No se pudo crear la auditoria de Veriff");
    }

    const createPayload = await veriffCreateSession({
      documentNumber: clienteDocumento,
      documentType: sanitizeText(body.clienteTipoDocumento),
      endUserId: vendorData,
      firstName: clientePrimerNombre,
      lastName: clientePrimerApellido,
      vendorData,
    });
    const sessionId = extractVeriffSessionId(createPayload);

    if (!sessionId) {
      await updateVeriffValidation(validation.id, {
        createPayload,
        lastError: "Veriff no retorno session id",
        status: "ERROR",
      });
      return NextResponse.json(
        { ok: false, error: "Veriff no retorno session id" },
        { status: 502 }
      );
    }

    await updateVeriffValidation(validation.id, {
      createPayload,
      status: "CREATED",
      veriffSessionId: sessionId,
    });

    const mediaPayloads = [];
    mediaPayloads.push(
      await veriffUploadMedia(sessionId, {
        context: "face",
        content: selfieDataUrl,
        timestamp: sanitizeText(body.contratoSelfieCapturedAt) || null,
      })
    );
    mediaPayloads.push(
      await veriffUploadMedia(sessionId, {
        context: "document-front",
        content: cedulaFrenteDataUrl,
        timestamp: sanitizeText(body.contratoCedulaFrenteCapturedAt) || null,
      })
    );
    mediaPayloads.push(
      await veriffUploadMedia(sessionId, {
        context: "document-back",
        content: cedulaRespaldoDataUrl,
        timestamp: sanitizeText(body.contratoCedulaRespaldoCapturedAt) || null,
      })
    );

    const submitPayload = await veriffSubmitSession(sessionId);
    let row = await updateVeriffValidation(validation.id, {
      mediaPayload: mediaPayloads,
      status: "SUBMITTED",
      submitPayload,
      submittedAt: new Date(),
      veriffSessionId: sessionId,
    });

    try {
      const decisionPayload = await veriffGetDecision(sessionId);
      row = await updateVeriffValidationFromDecision(
        validation.id,
        decisionPayload,
        "decisionPayload"
      );
    } catch (error) {
      if (error instanceof VeriffApiError && [404, 409].includes(error.status)) {
        row = await updateVeriffValidation(validation.id, {
          lastError: null,
          status: "PENDING",
        });
      } else {
        throw error;
      }
    }

    return NextResponse.json({
      ok: true,
      validation: serializeVeriffValidation(row),
      veriff: getVeriffPublicSummary(),
    });
  } catch (error) {
    return veriffErrorResponse(error);
  }
}
