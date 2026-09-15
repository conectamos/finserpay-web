import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import {
  DataCreditoAdminRetryError,
  findDataCreditoAdminRetryCandidate,
} from "@/lib/datacredito/admin-retry-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) {
    return json(
      {
        ok: false,
        code: access.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
        error:
          access.status === 401
            ? "No autenticado"
            : "Solo el administrador central de FINSER PAY puede liberar consultas DataCrédito.",
      },
      access.status
    );
  }

  const correlationId = randomUUID();
  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || Array.isArray(body)) {
      return json(
        {
          ok: false,
          code: "INVALID_REQUEST",
          error: "Envía una cédula válida para realizar la búsqueda.",
          correlationId,
        },
        400
      );
    }

    const result = await findDataCreditoAdminRetryCandidate({
      documentNumber: body.documentNumber,
      providerEnvironment: getDataCreditoPublicConfig().environment,
    });
    if (!result) {
      return json(
        {
          ok: false,
          code: "ASSESSMENT_NOT_FOUND",
          error:
            "No se encontró una consulta DataCrédito vigente para la cédula indicada.",
          correlationId,
        },
        404
      );
    }
    return json({ ok: true, result, correlationId });
  } catch (error) {
    if (error instanceof DataCreditoAdminRetryError) {
      return json(
        {
          ok: false,
          code: error.code,
          error: error.message,
          correlationId,
        },
        error.status
      );
    }
    console.error("[datacredito-admin-retry-search]", {
      correlationId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return json(
      {
        ok: false,
        code: "RETRY_SEARCH_UNAVAILABLE",
        error: "No se pudo buscar la consulta DataCrédito.",
        correlationId,
      },
      500
    );
  }
}
