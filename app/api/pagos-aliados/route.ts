import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  canCreateAllyPayment,
  getAllyPaymentAccess,
  type AllyPaymentAccess,
} from "@/lib/ally-payment-access";
import {
  AllyPaymentConflictError,
  AllyPaymentNotFoundError,
  AllyPaymentValidationError,
  createAllyPayment,
  getAllyPaymentPreview,
  listAllyPaymentAllies,
  listAllyPaymentHistory,
  listAllyPaymentPending,
} from "@/lib/ally-payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

type GrantedAccess = Extract<AllyPaymentAccess, { ok: true }>;

function response(body: unknown, init?: ResponseInit) {
  const result = NextResponse.json(body, init);
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    result.headers.set(name, value);
  }
  return result;
}

function accessError(status: 401 | 403, correlationId: string) {
  return response(
    {
      ok: false,
      code: status === 401 ? "UNAUTHENTICATED" : "ALLY_PAYMENT_FORBIDDEN",
      error:
        status === 401
          ? "No autenticado"
          : "No tienes permisos para consultar pagos a aliados",
      correlationId,
    },
    { status }
  );
}

function scopeError(correlationId: string) {
  return response(
    {
      ok: false,
      code: "ALLY_PAYMENT_SCOPE_FORBIDDEN",
      error: "Solo puedes consultar los pagos del aliado asociado a tu usuario",
      correlationId,
    },
    { status: 403 }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalAllyId(value: string | null) {
  if (value === null) return null;

  const allyId = Number(value.trim());
  if (!Number.isSafeInteger(allyId) || allyId <= 0) {
    throw new AllyPaymentValidationError(["aliadoId no es valido."]);
  }
  return allyId;
}

function parsePreviewPeriod(searchParams: URLSearchParams) {
  const hasStart = searchParams.has("fechaInicio");
  const hasEnd = searchParams.has("fechaFin");

  if (hasStart !== hasEnd) {
    throw new AllyPaymentValidationError([
      "Debes indicar fechaInicio y fechaFin para previsualizar un periodo.",
    ]);
  }

  if (!hasStart) return null;

  return {
    startDate: searchParams.get("fechaInicio"),
    endDate: searchParams.get("fechaFin"),
  };
}

function resolveAllyScope(
  access: GrantedAccess,
  requestedAllyId: number | null,
  correlationId: string
) {
  if (access.kind === "CENTRAL_ADMIN") {
    return { allyId: requestedAllyId, error: null };
  }

  if (requestedAllyId !== null && requestedAllyId !== access.allyId) {
    return { allyId: access.allyId, error: scopeError(correlationId) };
  }

  return { allyId: access.allyId, error: null };
}

function errorResponse(error: unknown, correlationId: string) {
  if (error instanceof AllyPaymentValidationError) {
    return response(
      {
        ok: false,
        code: "ALLY_PAYMENT_VALIDATION_ERROR",
        error: error.message,
        issues: error.issues,
        correlationId,
      },
      { status: 400 }
    );
  }

  if (error instanceof AllyPaymentNotFoundError) {
    return response(
      {
        ok: false,
        code: "ALLY_PAYMENT_NOT_FOUND",
        error: error.message,
        correlationId,
      },
      { status: 404 }
    );
  }

  if (error instanceof AllyPaymentConflictError) {
    return response(
      {
        ok: false,
        code: error.code,
        error: error.message,
        correlationId,
      },
      { status: 409 }
    );
  }

  console.error("ERROR PAGOS A ALIADOS:", {
    correlationId,
    errorType: error instanceof Error ? error.name : "UnknownError",
  });

  return response(
    {
      ok: false,
      code: "ALLY_PAYMENT_ERROR",
      error: "No se pudo completar la operacion de pagos a aliados.",
      correlationId,
    },
    { status: 500 }
  );
}

export async function GET(request: Request) {
  const correlationId = randomUUID();
  try {
    const access = await getAllyPaymentAccess();
    if (!access.ok) return accessError(access.status, correlationId);

    const searchParams = new URL(request.url).searchParams;
    const requestedAllyId = parseOptionalAllyId(searchParams.get("aliadoId"));
    const scope = resolveAllyScope(access, requestedAllyId, correlationId);
    if (scope.error) return scope.error;

    const period = parsePreviewPeriod(searchParams);
    if (period && scope.allyId === null) {
      throw new AllyPaymentValidationError([
        "Debes seleccionar un aliado para previsualizar el periodo.",
      ]);
    }

    const [allies, pending, settlements, previewResult] = await Promise.all([
      access.kind === "CENTRAL_ADMIN"
        ? listAllyPaymentAllies()
        : Promise.resolve([]),
      listAllyPaymentPending({ allyId: scope.allyId }),
      listAllyPaymentHistory({ allyId: scope.allyId }),
      period && scope.allyId !== null
        ? getAllyPaymentPreview({
            allyId: scope.allyId,
            startDate: period.startDate,
            endDate: period.endDate,
          })
        : Promise.resolve(null),
    ]);
    const preview =
      previewResult && previewResult.items.length > 0 ? previewResult : null;

    return response({
      ok: true,
      access: {
        adminCentral: access.kind === "CENTRAL_ADMIN",
        allyId: access.allyId,
      },
      allies,
      pending,
      settlements,
      preview,
      correlationId,
    });
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}

export async function POST(request: Request) {
  const correlationId = randomUUID();
  try {
    const access = await getAllyPaymentAccess();
    if (!access.ok) return accessError(access.status, correlationId);
    if (!canCreateAllyPayment(access)) {
      return response(
        {
          ok: false,
          code: "ALLY_PAYMENT_CREATE_FORBIDDEN",
          error: "Solo el administrador central de FINSER PAY puede registrar pagos",
          correlationId,
        },
        { status: 403 }
      );
    }

    if (
      !String(request.headers.get("content-type") || "")
        .toLowerCase()
        .startsWith("application/json")
    ) {
      throw new AllyPaymentValidationError([
        "La solicitud debe usar contenido JSON.",
      ]);
    }

    const body = await request.json().catch(() => null);
    if (!isRecord(body)) {
      throw new AllyPaymentValidationError(["La solicitud JSON no es valida."]);
    }

    const result = await createAllyPayment({
      mutationId: body.mutationId,
      allyId: body.aliadoId,
      startDate: body.fechaInicio,
      endDate: body.fechaFin,
      numeroAprobacionBancaria: body.numeroAprobacionBancaria,
      previewToken: body.previewToken,
      intermediationAdjustments: body.ajustesIntermediacion,
      registradoPorUsuarioId: access.user.id,
      registradoPorNombre: access.user.nombre,
    });

    return response(
      {
        ok: true,
        settlement: result,
        idempotent: result.idempotent,
        message: result.idempotent
          ? "El pago ya habia sido registrado con esta operacion."
          : "Pago registrado correctamente.",
        correlationId,
      },
      { status: result.idempotent ? 200 : 201 }
    );
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}
