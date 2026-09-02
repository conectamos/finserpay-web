import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAllyPaymentAccess } from "@/lib/ally-payment-access";
import {
  AllyPaymentConflictError,
  AllyPaymentNotFoundError,
  AllyPaymentValidationError,
  getAllyPaymentDetail,
} from "@/lib/ally-payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

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

function parseSettlementId(value: string) {
  const id = Number(value.trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AllyPaymentValidationError([
      "El identificador de la liquidacion no es valido.",
    ]);
  }
  return id;
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

  console.error("ERROR DETALLE PAGO A ALIADO:", {
    correlationId,
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return response(
    {
      ok: false,
      code: "ALLY_PAYMENT_DETAIL_ERROR",
      error: "No se pudo cargar el detalle del pago al aliado.",
      correlationId,
    },
    { status: 500 }
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const correlationId = randomUUID();
  try {
    const access = await getAllyPaymentAccess();
    if (!access.ok) return accessError(access.status, correlationId);

    const params = await context.params;
    const settlement = await getAllyPaymentDetail({
      id: parseSettlementId(params.id),
      allyId: access.kind === "CENTRAL_ADMIN" ? null : access.allyId,
    });

    if (!settlement) {
      throw new AllyPaymentNotFoundError();
    }

    return response({ ok: true, settlement, correlationId });
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}
