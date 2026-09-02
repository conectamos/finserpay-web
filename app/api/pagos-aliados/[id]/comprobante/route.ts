import { NextResponse } from "next/server";
import { getAllyPaymentAccess } from "@/lib/ally-payment-access";
import { buildAllyPaymentSettlementPdf } from "@/lib/ally-payment-settlement-pdf";
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
    const paidAt = new Date(settlement.pagadoAt);
    if (Number.isNaN(paidAt.getTime())) {
      throw new Error("La liquidacion no tiene una fecha de pago valida.");
    }

    const pdf = await buildAllyPaymentSettlementPdf({
      settlementId: settlement.id,
      allyName: settlement.aliado.nombre,
      periodStart: settlement.periodoInicio,
      periodEnd: settlement.periodoFin,
      bankApprovalNumber: settlement.numeroAprobacionBancaria,
      status: settlement.estado,
      paidAt,
      registeredBy: settlement.registradoPorNombre,
      creditCount: settlement.numeroCreditos,
      totalSaleValue: settlement.totalValorVenta,
      totalInitialPayment: settlement.totalCuotaInicial,
      totalAuthorizedCredit: settlement.totalCreditoAutorizado,
      totalIntermediation: settlement.totalIntermediacion,
      totalPayable: settlement.totalPagar,
      platformSummary: {
        ANDROID: {
          creditCount: settlement.summary.ANDROID.numeroCreditos,
          intermediationPercentage:
            settlement.summary.ANDROID.porcentajeIntermediacion,
          payableValue: settlement.summary.ANDROID.totalPagar,
        },
        IPHONE: {
          creditCount: settlement.summary.IPHONE.numeroCreditos,
          intermediationPercentage:
            settlement.summary.IPHONE.porcentajeIntermediacion,
          payableValue: settlement.summary.IPHONE.totalPagar,
        },
      },
      lines: settlement.items.map((item) => ({
        creditId: item.creditoId,
        creditDate: item.fechaCredito,
        allyName: settlement.aliado.nombre,
        clientName: item.clienteNombre,
        clientDocument: item.clienteDocumento,
        equipment: item.equipo,
        imei: item.imei,
        platform: item.plataforma,
        saleValue: item.valorVenta,
        initialPayment: item.cuotaInicial,
        authorizedCredit: item.creditoAutorizado,
        intermediationPercentage: item.porcentajeIntermediacion,
        intermediationValue: item.valorIntermediacion,
        payableValue: item.valorPagar,
        status: item.estado,
      })),
    });
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
