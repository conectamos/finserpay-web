import { NextResponse } from "next/server";
import { FirmaSeguroApiError } from "@/lib/firmaseguro";
import {
  createFirmaSeguroProcessForCredit,
  getAuthorizedFirmaSeguroCredit,
  getLatestFirmaSeguroProcessForCredit,
  refreshFirmaSeguroProcess,
  serializeFirmaSeguroProcess,
} from "@/lib/firmaseguro-credit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function firmaSeguroErrorResponse(error: unknown) {
  if (error instanceof FirmaSeguroApiError) {
    return NextResponse.json(
      {
        ok: false,
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

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const authorized = await getAuthorizedFirmaSeguroCredit(params.id);

    if (!authorized.ok) {
      return NextResponse.json(
        { ok: false, error: authorized.error },
        { status: authorized.status }
      );
    }

    const current = await getLatestFirmaSeguroProcessForCredit(
      authorized.credito.id
    );

    if (!current) {
      return NextResponse.json({ ok: true, process: null });
    }

    const url = new URL(request.url);
    const shouldRefresh = url.searchParams.get("refresh") === "1";
    const process = shouldRefresh
      ? await refreshFirmaSeguroProcess(current, {
          credito: authorized.credito,
        })
      : current;

    return NextResponse.json({
      ok: true,
      process: serializeFirmaSeguroProcess(process),
      documentUrl: process?.signedDocumentBase64
        ? `/api/creditos/${authorized.credito.id}/firma-seguro/documento`
        : null,
    });
  } catch (error) {
    return firmaSeguroErrorResponse(error);
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const authorized = await getAuthorizedFirmaSeguroCredit(params.id);

    if (!authorized.ok) {
      return NextResponse.json(
        { ok: false, error: authorized.error },
        { status: authorized.status }
      );
    }

    const process = await createFirmaSeguroProcessForCredit(authorized.credito);

    return NextResponse.json({
      ok: true,
      process: serializeFirmaSeguroProcess(process),
      message: "Proceso de firma enviado a FirmaSeguro",
    });
  } catch (error) {
    return firmaSeguroErrorResponse(error);
  }
}
