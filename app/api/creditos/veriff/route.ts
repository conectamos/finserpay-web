import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { sanitizeText, toNumber } from "@/lib/credit-factory";
import {
  createVeriffValidation,
  serializeVeriffValidation,
  updateVeriffValidation,
} from "@/lib/veriff-storage";
import { getSellerSessionUser } from "@/lib/seller-auth";
import {
  extractVeriffSessionId,
  extractVeriffSessionUrl,
  getVeriffPublicSummary,
  isVeriffConfigured,
  redactVeriffPayload,
  veriffCreateSession,
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
        flow: "veriff-qr",
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
      ok: true,
      validation: serializeVeriffValidation(row),
      veriff: getVeriffPublicSummary(),
    });
  } catch (error) {
    return veriffErrorResponse(error);
  }
}
