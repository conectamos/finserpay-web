import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import {
  DataCreditoManualCreditLimitConflictError,
  DataCreditoManualCreditLimitMutationConflictError,
  DataCreditoManualCreditLimitNotFoundError,
  DataCreditoManualCreditLimitValidationError,
  listDataCreditoManualCreditLimits,
  updateDataCreditoManualCreditLimit,
  upsertDataCreditoManualCreditLimit,
  type DataCreditoManualCreditLimitStatus,
} from "@/lib/datacredito/manual-credit-limits";
import { DataCreditoStorageConfigurationError } from "@/lib/datacredito/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function accessError(status: 401 | 403) {
  return NextResponse.json(
    {
      ok: false,
      error:
        status === 401
          ? "No autenticado"
          : "Solo el administrador central de FINSER PAY puede administrar cupos manuales",
    },
    { status, headers: NO_STORE_HEADERS }
  );
}

function parseStatus(value: unknown): DataCreditoManualCreditLimitStatus {
  const normalized = String(value || "ALL").trim().toUpperCase();
  if (normalized === "ALL" || normalized === "TODOS") return "ALL";
  if (normalized === "ACTIVE" || normalized === "ACTIVO") return "ACTIVE";
  if (normalized === "INACTIVE" || normalized === "INACTIVO") return "INACTIVE";
  throw new DataCreditoManualCreditLimitValidationError([
    "El estado solicitado no es válido.",
  ]);
}

function errorResponse(error: unknown, correlationId: string) {
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
  if (error instanceof DataCreditoManualCreditLimitNotFoundError) {
    return NextResponse.json(
      {
        ok: false,
        code: "MANUAL_CREDIT_LIMIT_NOT_FOUND",
        error: error.message,
        correlationId,
      },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }
  if (error instanceof DataCreditoManualCreditLimitConflictError) {
    return NextResponse.json(
      {
        ok: false,
        code: "MANUAL_CREDIT_LIMIT_VERSION_CONFLICT",
        error: error.message,
        currentVersion: error.currentVersion,
        correlationId,
      },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }
  if (error instanceof DataCreditoManualCreditLimitMutationConflictError) {
    return NextResponse.json(
      {
        ok: false,
        code: "MANUAL_CREDIT_LIMIT_MUTATION_CONFLICT",
        error: error.message,
        correlationId,
      },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }
  if (error instanceof DataCreditoStorageConfigurationError) {
    return NextResponse.json(
      {
        ok: false,
        code: error.code,
        error: "DataCrédito requiere el preflight de base de datos para administrar cupos manuales.",
        correlationId,
      },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  console.error("ERROR CUPOS MANUALES DATACREDITO:", {
    correlationId,
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json(
    {
      ok: false,
      code: "MANUAL_CREDIT_LIMIT_ERROR",
      error: "No se pudo completar la operación de cupo manual.",
      correlationId,
    },
    { status: 500, headers: NO_STORE_HEADERS }
  );
}

export async function GET(request: Request) {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) return accessError(access.status);
  const correlationId = randomUUID();
  try {
    const url = new URL(request.url);
    const items = await listDataCreditoManualCreditLimits({
      status: parseStatus(url.searchParams.get("estado")),
    });
    return NextResponse.json(
      { ok: true, items, correlationId },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return errorResponse(error, correlationId);
  }
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
    const result = await upsertDataCreditoManualCreditLimit({
      documentNumber: body.documentNumber,
      maxFinancedAmount: body.maxFinancedAmount,
      reason: body.reason,
      mutationId: body.mutationId,
      actorUserId: access.user.id,
    });
    return NextResponse.json(
      { ok: true, ...result, correlationId },
      { status: result.created ? 201 : 200, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}

export async function PATCH(request: Request) {
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
    const result = await updateDataCreditoManualCreditLimit({
      id: body.id,
      maxFinancedAmount: body.maxFinancedAmount,
      reason: body.reason,
      active: body.active,
      expectedVersion: body.expectedVersion,
      mutationId: body.mutationId,
      actorUserId: access.user.id,
    });
    return NextResponse.json(
      { ok: true, ...result, correlationId },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}
