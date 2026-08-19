import { NextResponse } from "next/server";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import {
  listDataCreditoAssessmentsForAdmin,
  type DataCreditoAdminQueryFilters,
} from "@/lib/datacredito/admin-storage";
import { getBogotaDayRangeFromInput } from "@/lib/ventas-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function parseDate(value: unknown, endOfDay: boolean) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const range = getBogotaDayRangeFromInput(raw);
  if (!range) {
    throw new Error("DATACREDITO_ADMIN_DATE_INVALID");
  }
  return endOfDay ? range.end : range.start;
}

export async function POST(request: Request) {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          access.status === 401
            ? "No autenticado"
            : "Solo el administrador central de FINSER PAY puede consultar este historial",
      },
      { status: access.status, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const filters: DataCreditoAdminQueryFilters = {
      documentNumber: String(body.documentNumber || "").trim() || null,
      status: String(body.status || "").trim() || null,
      platform: String(body.platform || "").trim() || null,
      dateFrom: parseDate(body.dateFrom, false),
      dateTo: parseDate(body.dateTo, true),
      cursor: String(body.cursor || "").trim() || null,
      limit: Number(body.limit) || undefined,
    };
    const result = await listDataCreditoAssessmentsForAdmin(filters);
    const provider = getDataCreditoPublicConfig();
    return NextResponse.json(
      {
        ok: true,
        provider: {
          enabled: provider.enabled,
          environment: provider.environment,
          isProduction: provider.productionReady,
        },
        ...result,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const clientError = code.startsWith("DATACREDITO_ADMIN_");
    return NextResponse.json(
      {
        ok: false,
        error: clientError
          ? "Revisa los filtros de la consulta"
          : "No se pudo cargar el historial de DataCrédito",
      },
      { status: clientError ? 400 : 500, headers: NO_STORE_HEADERS }
    );
  }
}
