import { NextResponse } from "next/server";

import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import {
  DataCreditoQuerySalesReportInputError,
  getDataCreditoQuerySalesReport,
} from "@/lib/datacredito/admin-query-sales-report";
import { getDataCreditoRetentionDays } from "@/lib/datacredito/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
};

function errorResponse(error: string, status: number) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: NO_STORE_HEADERS }
  );
}

export async function POST(request: Request) {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) {
    return errorResponse(
      access.status === 401
        ? "No autenticado"
        : "Solo el administrador central de FINSER PAY puede consultar este reporte",
      access.status
    );
  }

  try {
    const payload = await request.json().catch(() => null);
    const input =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const provider = getDataCreditoPublicConfig();
    const retentionDays = getDataCreditoRetentionDays();
    const report = await getDataCreditoQuerySalesReport(
      input,
      provider.environment
    );

    return NextResponse.json(
      {
        ok: true,
        ...report,
        provider: {
          environment: provider.environment,
          enabled: provider.enabled,
          configured: provider.configured,
          isProduction: provider.productionReady,
        },
        retentionDays,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof DataCreditoQuerySalesReportInputError) {
      return errorResponse(error.message, 400);
    }

    console.error("ERROR REPORTE CONSULTAS DATACREDITO VS VENTAS:", error);
    return errorResponse(
      "No se pudo cargar el reporte de consultas DataCredito vs ventas",
      500
    );
  }
}
