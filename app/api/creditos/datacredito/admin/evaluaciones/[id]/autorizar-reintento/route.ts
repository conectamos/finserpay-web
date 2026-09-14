import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import {
  authorizeDataCreditoAdminRetry,
  DataCreditoAdminRetryError,
} from "@/lib/datacredito/admin-retry-storage";
import { hashDataCreditoRequestMetadata } from "@/lib/datacredito/storage";

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

function requestMetadata(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") || "";
  const ip =
    forwardedFor.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "";
  return {
    ipHash: hashDataCreditoRequestMetadata("ip", ip),
    userAgentHash: hashDataCreditoRequestMetadata(
      "user-agent",
      request.headers.get("user-agent") || ""
    ),
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
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
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || Array.isArray(body)) {
      return json(
        {
          ok: false,
          code: "INVALID_REQUEST",
          error: "La solicitud de liberación no es válida.",
          correlationId,
        },
        400
      );
    }

    const metadata = requestMetadata(request);
    const result = await authorizeDataCreditoAdminRetry({
      assessmentId: id,
      documentNumber: body.documentNumber,
      firstSurname: body.firstSurname,
      mutationId: body.mutationId,
      providerEnvironment: getDataCreditoPublicConfig().environment,
      actorUserId: access.user.id,
      ...metadata,
    });
    return json({
      ok: true,
      result: {
        ...result,
        eligible: false,
        eligibilityMessage:
          "Esta consulta ya fue liberada para un nuevo intento.",
      },
      correlationId,
    });
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
    console.error("[datacredito-admin-retry-authorize]", {
      correlationId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return json(
      {
        ok: false,
        code: "RETRY_AUTHORIZATION_UNAVAILABLE",
        error: "No se pudo autorizar el nuevo intento.",
        correlationId,
      },
      500
    );
  }
}
