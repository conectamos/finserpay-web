import { NextResponse } from "next/server";
import { getAllyPaymentAccess } from "@/lib/ally-payment-access";
import { buildSavedSettlementPdf } from "@/lib/ally-settlement-document";
import {
  AllyPaymentNotFoundError,
  AllyPaymentValidationError,
  getAllyPaymentDetail,
} from "@/lib/ally-payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function parseSettlementId(value: string) {
  const id = Number(value.trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AllyPaymentValidationError([
      "El identificador de la liquidacion no es valido.",
    ]);
  }
  return id;
}

function cleanFilePart(value: unknown) {
  return String(value || "aliado")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "aliado";
}

function jsonError(status: number, message: string) {
  return NextResponse.json(
    { ok: false, error: message },
    { status, headers: RESPONSE_SECURITY_HEADERS }
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const access = await getAllyPaymentAccess();
    if (!access.ok) {
      return jsonError(
        access.status,
        access.status === 401
          ? "No autenticado"
          : "No tienes permisos para consultar pagos a aliados"
      );
    }

    const params = await context.params;
    const settlement = await getAllyPaymentDetail({
      id: parseSettlementId(params.id),
      allyId: access.kind === "CENTRAL_ADMIN" ? null : access.allyId,
    });
    const pdf = await buildSavedSettlementPdf(settlement);
    const download = new URL(request.url).searchParams.get("download") === "1";
    const filename = `liquidacion-aliado-${cleanFilePart(
      settlement.aliado.nombre
    )}-LA-${settlement.id}.pdf`;

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        ...RESPONSE_SECURITY_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof AllyPaymentValidationError) {
      return jsonError(400, error.message);
    }
    if (error instanceof AllyPaymentNotFoundError) {
      return jsonError(404, error.message);
    }

    console.error("ERROR GENERANDO COMPROBANTE DE PAGO A ALIADO:", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return jsonError(500, "No se pudo generar el comprobante de la liquidacion.");
  }
}
