import { NextResponse } from "next/server";
import {
  getAuthorizedFirmaSeguroCredit,
  getLatestFirmaSeguroProcessForCredit,
  refreshFirmaSeguroProcess,
} from "@/lib/firmaseguro-credit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const authorized = await getAuthorizedFirmaSeguroCredit(params.id, {
      requireSupervisorOrAdmin: true,
    });

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
      return NextResponse.json(
        { ok: false, error: "Este credito no tiene proceso FirmaSeguro" },
        { status: 404 }
      );
    }

    const url = new URL(request.url);
    const process = current.signedDocumentBase64
      ? current
      : url.searchParams.get("refresh") === "0"
        ? current
        : await refreshFirmaSeguroProcess(current, {
            credito: authorized.credito,
          });

    if (!process?.signedDocumentBase64) {
      return NextResponse.json(
        {
          ok: false,
          error: "El documento firmado aun no esta disponible",
          status: process?.status || current.status,
        },
        { status: 409 }
      );
    }

    const pdfBase64 = process.signedDocumentBase64.replace(
      /^data:application\/pdf;base64,/i,
      ""
    );
    const bytes = Buffer.from(pdfBase64, "base64");
    const fileName =
      process.signedDocumentFileName ||
      `finserpay-firmado-${authorized.credito.folio}.pdf`;

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fileName.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo descargar el documento firmado";

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
