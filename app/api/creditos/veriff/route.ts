import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { sanitizeText, toNumber } from "@/lib/credit-factory";
import prisma from "@/lib/prisma";
import {
  createVeriffValidation,
  getReusableVeriffValidationForDraft,
  serializeVeriffValidation,
  updateVeriffValidation,
} from "@/lib/veriff-storage";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { canOperateVeriffDraft } from "@/lib/veriff-access";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
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
  draftId?: number | string | null;
};

type VeriffDraftAccessRow = {
  id: number;
  estado: string;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  aliadoId: number | null;
  clienteDocumento: string | null;
};

function parsePositiveId(value: unknown) {
  const parsed = Math.trunc(toNumber(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function readVeriffDraftAccess(draftId: number) {
  await ensureSolicitudSchema();
  const rows = await prisma.$queryRawUnsafe<VeriffDraftAccessRow[]>(
    `
      SELECT d."id", d."estado", d."usuarioId", d."vendedorId", d."sedeId",
        d."clienteDocumento", s."aliadoId"
      FROM "CreditoBorrador" d
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      WHERE d."id" = $1
      LIMIT 1
    `,
    draftId
  );
  return rows[0] || null;
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

    const draft = await readVeriffDraftAccess(draftId);
    if (!draft || !canOperateVeriffDraft(user, draft, sellerSession)) {
      return NextResponse.json(
        { ok: false, error: "Borrador no encontrado" },
        { status: 404 }
      );
    }

    const requestedDocument = sanitizeText(body.clienteDocumento).replace(/\D/g, "");
    const clienteDocumento = String(draft.clienteDocumento || "").replace(/\D/g, "");
    if (!clienteDocumento || requestedDocument !== clienteDocumento) {
      return NextResponse.json(
        {
          ok: false,
          error: "La cedula no corresponde al borrador autorizado",
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


    const reusableValidation = await getReusableVeriffValidationForDraft({
      aliadoId: draft.aliadoId,
      clienteDocumento,
      draftId,
      sedeId: draft.sedeId,
    });

    if (reusableValidation) {
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
      usuarioId: user.id,
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
  }
}
