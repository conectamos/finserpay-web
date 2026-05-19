import { NextResponse } from "next/server";
import { sanitizeSearch, sanitizeText } from "@/lib/credit-factory";
import { reconcileWompiIntentForClient } from "@/lib/wompi-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeDocument(value: unknown) {
  return sanitizeSearch(value).replace(/\D/g, "");
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const documento = normalizeDocument(searchParams.get("documento"));
    const reference = sanitizeText(searchParams.get("reference")).slice(0, 120);

    if (!documento || documento.length < 5 || !reference) {
      return NextResponse.json(
        { error: "Referencia o cedula invalida" },
        { status: 400 }
      );
    }

    const result = await reconcileWompiIntentForClient({ documento, reference });

    if (!result) {
      return NextResponse.json(
        { error: "No encontramos ese pago en FINSER PAY" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ...result,
      ok: true,
    });
  } catch (error) {
    console.error("ERROR CONSULTANDO ESTADO WOMPI:", error);
    return NextResponse.json(
      { error: "No se pudo consultar el estado del pago en Wompi" },
      { status: 500 }
    );
  }
}
