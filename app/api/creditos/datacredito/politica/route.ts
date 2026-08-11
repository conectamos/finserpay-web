import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import {
  DataCreditoPolicyValidationError,
  parseDataCreditoPolicyBands,
} from "@/lib/datacredito/policy";
import {
  createDataCreditoPolicyVersion,
  DATACREDITO_CONSENT_HASH,
  DATACREDITO_CONSENT_TEXT,
  DATACREDITO_CONSENT_VERSION,
  DataCreditoPolicyConflictError,
  DataCreditoStorageConfigurationError,
  getCurrentDataCreditoPolicy,
  isDataCreditoAuditConfigured,
} from "@/lib/datacredito/storage";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isCentralAdmin(user: Awaited<ReturnType<typeof getSessionUser>>) {
  return Boolean(
    user &&
      isAdminRole(user.rolNombre) &&
      isFinserPayCentralAlly(user.aliadoAccesoCodigo)
  );
}

function serializePolicyResponse(input: {
  centralAdmin: boolean;
  policy: Awaited<ReturnType<typeof getCurrentDataCreditoPolicy>>;
  provider: ReturnType<typeof getDataCreditoPublicConfig>;
}) {
  const auditConfigured = isDataCreditoAuditConfigured();
  const provider = {
    ...input.provider,
    configured: input.provider.configured && auditConfigured,
  };
  const hasPolicy = Boolean(input.policy);

  return {
    ok: true,
    enabled: provider.enabled,
    configured: provider.configured && hasPolicy,
    hasPolicy,
    provider,
    policy: input.policy
      ? input.centralAdmin
        ? input.policy
        : {
            version: input.policy.version,
            createdAt: input.policy.createdAt,
          }
      : null,
    consent: {
      version: DATACREDITO_CONSENT_VERSION,
      text: DATACREDITO_CONSENT_TEXT,
      hash: DATACREDITO_CONSENT_HASH,
    },
  };
}

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const provider = getDataCreditoPublicConfig();
    const centralAdmin = isCentralAdmin(user);

    if (!provider.enabled && !centralAdmin) {
      return NextResponse.json(
        serializePolicyResponse({ centralAdmin: false, policy: null, provider })
      );
    }

    const policy = await getCurrentDataCreditoPolicy();
    return NextResponse.json(
      serializePolicyResponse({ centralAdmin, policy, provider })
    );
  } catch (error) {
    if (error instanceof DataCreditoStorageConfigurationError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error:
            "DataCredito requiere el preflight de base de datos. Ejecuta npm run db:setup-datacredito antes de usar esta configuracion.",
        },
        { status: 503 }
      );
    }

    console.error(
      "ERROR GET POLITICA DATACREDITO:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json(
      { ok: false, error: "No se pudo cargar la politica de evaluacion" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    if (!isCentralAdmin(user)) {
      return NextResponse.json(
        { ok: false, error: "Solo el administrador central de FINSER PAY puede modificar esta politica" },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json(
        { ok: false, error: "El cuerpo de la solicitud no es valido" },
        { status: 400 }
      );
    }

    const expectedVersionValue = body.expectedVersion;
    const expectedVersion =
      expectedVersionValue === undefined || expectedVersionValue === null
        ? null
        : Number(expectedVersionValue);
    if (
      expectedVersion !== null &&
      (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    ) {
      return NextResponse.json(
        { ok: false, error: "expectedVersion debe ser una version valida" },
        { status: 400 }
      );
    }

    const bands = parseDataCreditoPolicyBands(body.bands);
    const policy = await createDataCreditoPolicyVersion({
      bands,
      createdByUserId: user.id,
      expectedVersion,
    });

    return NextResponse.json(
      serializePolicyResponse({
        centralAdmin: true,
        policy,
        provider: getDataCreditoPublicConfig(),
      })
    );
  } catch (error) {
    if (error instanceof DataCreditoPolicyValidationError) {
      return NextResponse.json(
        { ok: false, error: error.message, issues: error.issues },
        { status: 400 }
      );
    }
    if (error instanceof DataCreditoPolicyConflictError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          code: "POLICY_VERSION_CONFLICT",
          currentVersion: error.currentVersion,
        },
        { status: 409 }
      );
    }
    if (error instanceof DataCreditoStorageConfigurationError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error:
            "DataCredito requiere el preflight de base de datos. Ejecuta npm run db:setup-datacredito antes de guardar la politica.",
        },
        { status: 503 }
      );
    }

    console.error(
      "ERROR PATCH POLITICA DATACREDITO:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json(
      { ok: false, error: "No se pudo guardar la politica de evaluacion" },
      { status: 500 }
    );
  }
}
