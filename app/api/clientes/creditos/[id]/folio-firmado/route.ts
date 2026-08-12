import { NextResponse } from "next/server";
import { sanitizeSearch } from "@/lib/credit-factory";
import { getLatestSignedFirmaSeguroProcessByCredit } from "@/lib/firmaseguro-storage";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseCreditId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const creditId = parseCreditId(params.id);
    const documento = sanitizeSearch(
      new URL(request.url).searchParams.get("documento")
    ).replace(/\D/g, "");

    if (!creditId || !/^\d{5,20}$/.test(documento)) {
      return NextResponse.json(
        { error: "Credito o documento invalido" },
        { status: 400 }
      );
    }

    const credito = await prisma.credito.findFirst({
      where: {
        clienteDocumento: documento,
        estado: { not: "ANULADO" },
        id: creditId,
      },
      select: {
        folio: true,
        id: true,
      },
    });

    if (!credito) {
      return NextResponse.json(
        { error: "Credito no encontrado para ese documento" },
        { status: 404 }
      );
    }

    const process = await getLatestSignedFirmaSeguroProcessByCredit(credito.id);

    if (!process?.signedDocumentBase64) {
      return NextResponse.json(
        { error: "El folio firmado aun no esta disponible" },
        { status: 409 }
      );
    }

    const pdfBase64 = process.signedDocumentBase64.replace(
      /^data:application\/pdf;base64,/i,
      ""
    );
    const bytes = Buffer.from(pdfBase64, "base64");

    if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      return NextResponse.json(
        { error: "El folio firmado almacenado no es un PDF valido" },
        { status: 409 }
      );
    }

    const safeFolio =
      credito.folio.replace(/[^A-Za-z0-9_-]/g, "-") || String(credito.id);
    const fileName = `folio-firmado-${safeFolio}.pdf`;

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    console.error("ERROR DESCARGANDO FOLIO FIRMADO CLIENTE:", error);
    return NextResponse.json(
      { error: "No se pudo descargar el folio firmado" },
      {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
        },
        status: 500,
      }
    );
  }
}
