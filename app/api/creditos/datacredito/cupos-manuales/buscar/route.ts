import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import {
  DataCreditoManualCreditLimitValidationError,
  listDataCreditoManualCreditLimits,
  type DataCreditoManualCreditLimitStatus,
} from "@/lib/datacredito/manual-credit-limits";
import { DataCreditoStorageConfigurationError } from "@/lib/datacredito/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function parseStatus(value: unknown): DataCreditoManualCreditLimitStatus {
  const normalized = String(value || "ALL").trim().toUpperCase();
  if (normalized === "ALL" || normalized === "TODOS") return "ALL";
  if (normalized === "ACTIVE" || normalized === "ACTIVO") return "ACTIVE";
  if (normalized === "INACTIVE" || normalized === "INACTIVO") return "INACTIVE";
  throw new DataCreditoManualCreditLimitValidationError([
    "El estado solicitado no es válido.",
  ]);
}

function accessError(status: 401 | 403) {
  return NextResponse.json(
    {
      ok: false,
      error:
        status === 401
          ? "No autenticado"
          : "Solo el administrador central de FINSER PAY puede buscar cupos manuales",
    },
    { status, headers: NO_STORE_HEADERS }
  );
}

export async function POST(request: Request) {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) return accessError(access.status);
  const correlationId = randomUUID();
  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return NextResponse.json(
        { ok: false, code: "INVALID_REQUEST", error: "Solicitud inválida" },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    const items = await listDataCreditoManualCreditLimits({
      documentNumber: body.documentNumber,
      status: parseStatus(body.estado),
    });
    return NextResponse.json(
      { ok: true, items, correlationId },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof DataCreditoManualCreditLimitValidationError) {
      return NextResponse.json(
        {
          ok: false,
          code: "MANUAL_CREDIT_LIMIT_VALIDATION_ERROR",
          error: error.message,
          issues: error.issues,
          correlationId,
        },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    if (error instanceof DataCreditoStorageConfigurationError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: "DataCrédito requiere el preflight de base de datos para buscar cupos manuales.",
          correlationId,
        },
        { status: 503, headers: NO_STORE_HEADERS }
      );
    }
    console.error("ERROR BUSQUEDA CUPO MANUAL DATACREDITO:", {
      correlationId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        code: "MANUAL_CREDIT_LIMIT_SEARCH_ERROR",
        error: "No se pudo buscar el cupo manual.",
        correlationId,
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
