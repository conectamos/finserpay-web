import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import {
  assignDataCreditoPolicyToAlly,
  createDataCreditoPolicyProfile,
  DataCreditoPolicyAssignmentConflictError,
  DataCreditoPolicyProfileNameConflictError,
  DataCreditoPolicyProfileNotFoundError,
  listDataCreditoPolicyCatalog,
} from "@/lib/datacredito/admin-storage";
import {
  DataCreditoPolicyValidationError,
  parseDataCreditoPolicyBands,
  parseDataCreditoPolicyFinancialSettings,
  parseDataCreditoPolicyProfileDescription,
  parseDataCreditoPolicyProfileName,
} from "@/lib/datacredito/policy";
import {
  createDataCreditoPolicyRevision,
  DataCreditoPolicyConflictError,
  DataCreditoPolicyNotFoundError,
  DataCreditoStorageConfigurationError,
  isDataCreditoAuditConfigured,
} from "@/lib/datacredito/storage";
import {
  DataCreditoPolicyDeleteAssignedError,
  DataCreditoPolicyDeleteDefaultError,
  DataCreditoPolicyDeleteNotFoundError,
  DataCreditoPolicyDeleteVersionConflictError,
  retireDataCreditoPolicyProfile,
} from "@/lib/datacredito/policy-deletion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function accessError(status: 401 | 403) {
  return NextResponse.json(
    {
      ok: false,
      error:
        status === 401
          ? "No autenticado"
          : "Solo el administrador central de FINSER PAY puede administrar estas politicas",
    },
    { status, headers: NO_STORE_HEADERS }
  );
}

async function catalogPayload(extra: Record<string, unknown> = {}) {
  const [catalog, provider] = await Promise.all([
    listDataCreditoPolicyCatalog(),
    Promise.resolve(getDataCreditoPublicConfig()),
  ]);
  return {
    ok: true,
    ...catalog,
    provider: {
      enabled: provider.enabled,
      configured: provider.configured && isDataCreditoAuditConfigured(),
      environment: provider.environment,
      productionReady: provider.productionReady,
    },
    ...extra,
  };
}

function policyErrorResponse(error: unknown, correlationId: string) {
  if (error instanceof DataCreditoPolicyValidationError) {
    return NextResponse.json(
      {
        ok: false,
        code: "POLICY_VALIDATION_ERROR",
        error: error.message,
        issues: error.issues,
        correlationId,
      },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
  if (error instanceof DataCreditoPolicyConflictError) {
    return NextResponse.json(
      {
        ok: false,
        code: "POLICY_VERSION_CONFLICT",
        error: error.message,
        currentVersion: error.currentVersion,
        correlationId,
      },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }
  if (error instanceof DataCreditoPolicyAssignmentConflictError) {
    return NextResponse.json(
      {
        ok: false,
        code: "POLICY_ASSIGNMENT_CONFLICT",
        error: error.message,
        currentPolicyId: error.currentPolicyId,
        correlationId,
      },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }
  if (error instanceof DataCreditoPolicyDeleteDefaultError) {
    return NextResponse.json(
      {
        ok: false,
        code: "POLICY_DELETE_DEFAULT_FORBIDDEN",
        error: error.message,
        correlationId,
      },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }
  if (error instanceof DataCreditoPolicyDeleteAssignedError) {
    return NextResponse.json(
      {
        ok: false,
        code: "POLICY_DELETE_ASSIGNED",
        error: error.message,
        assignedAlliesCount: error.assignedAlliesCount,
        correlationId,
      },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }
  if (error instanceof DataCreditoPolicyDeleteVersionConflictError) {
    return NextResponse.json(
      {
        ok: false,
        code: "POLICY_DELETE_VERSION_CONFLICT",
        error: error.message,
        currentVersion: error.currentVersion,
        correlationId,
      },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }
  if (error instanceof DataCreditoPolicyProfileNameConflictError) {
    return NextResponse.json(
      {
        ok: false,
        code: "POLICY_NAME_CONFLICT",
        error: error.message,
        correlationId,
      },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }
  if (
    error instanceof DataCreditoPolicyProfileNotFoundError ||
    error instanceof DataCreditoPolicyDeleteNotFoundError ||
    error instanceof DataCreditoPolicyNotFoundError ||
    (error instanceof Error && error.message === "DATACREDITO_ALLY_NOT_FOUND")
  ) {
    return NextResponse.json(
      {
        ok: false,
        code:
          error instanceof Error && error.message === "DATACREDITO_ALLY_NOT_FOUND"
            ? "ALLY_NOT_FOUND"
            : "POLICY_NOT_FOUND",
        error:
          error instanceof Error && error.message === "DATACREDITO_ALLY_NOT_FOUND"
            ? "El aliado seleccionado no existe"
            : "La politica seleccionada no existe",
        correlationId,
      },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }
  if (
    error instanceof Error &&
    error.message === "DATACREDITO_POLICY_NOT_ASSIGNABLE"
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "POLICY_NOT_ASSIGNABLE",
        error: "La politica seleccionada no esta activa o no tiene revisiones",
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
        error:
          "DataCredito requiere el preflight de base de datos antes de administrar politicas",
        correlationId,
      },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  console.error("ERROR CATALOGO POLITICAS DATACREDITO:", {
    correlationId,
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json(
    {
      ok: false,
      code: "POLICY_CATALOG_ERROR",
      error: "No se pudo completar la operacion de politicas",
      correlationId,
    },
    { status: 500, headers: NO_STORE_HEADERS }
  );
}

export async function GET() {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) return accessError(access.status);

  const correlationId = randomUUID();
  try {
    return NextResponse.json(await catalogPayload(), {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    return policyErrorResponse(error, correlationId);
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
        { ok: false, code: "INVALID_REQUEST", error: "Solicitud invalida" },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    const createdPolicyId = await createDataCreditoPolicyProfile({
      name: parseDataCreditoPolicyProfileName(body.name),
      description: parseDataCreditoPolicyProfileDescription(body.description),
      bands: parseDataCreditoPolicyBands(body.bands, {
        requireFinancingTerms: true,
      }),
      financialSettings: parseDataCreditoPolicyFinancialSettings(
        body.financialSettings
      )!,
      actorUserId: access.user.id,
    });
    return NextResponse.json(await catalogPayload({ createdPolicyId }), {
      status: 201,
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    return policyErrorResponse(error, correlationId);
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
        { ok: false, code: "INVALID_REQUEST", error: "Solicitud invalida" },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    const action = String(body.action || "").trim().toUpperCase();
    if (action === "SAVE_REVISION") {
      if (!isUuid(body.policyId)) {
        return NextResponse.json(
          {
            ok: false,
            code: "INVALID_POLICY_ID",
            error: "La politica seleccionada no es valida",
          },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }
      const expectedVersion = Number(body.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return NextResponse.json(
          {
            ok: false,
            code: "INVALID_POLICY_VERSION",
            error: "La version esperada no es valida",
          },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }
      const updatedPolicyId = String(body.policyId);
      await createDataCreditoPolicyRevision({
        profileId: updatedPolicyId,
        bands: parseDataCreditoPolicyBands(body.bands, {
          requireFinancingTerms: true,
        }),
        financialSettings: parseDataCreditoPolicyFinancialSettings(
          body.financialSettings
        )!,
        createdByUserId: access.user.id,
        expectedVersion,
      });
      return NextResponse.json(await catalogPayload({ updatedPolicyId }), {
        headers: NO_STORE_HEADERS,
      });
    }

    if (action === "ASSIGN_ALLY") {
      const allyId = Number(body.allyId);
      if (
        !Number.isInteger(allyId) ||
        allyId <= 0 ||
        !isUuid(body.policyId) ||
        !isUuid(body.expectedPolicyId)
      ) {
        return NextResponse.json(
          {
            ok: false,
            code: "INVALID_ASSIGNMENT",
            error: "La asignacion solicitada no es valida",
          },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }
      await assignDataCreditoPolicyToAlly({
        allyId,
        policyId: String(body.policyId),
        expectedPolicyId: String(body.expectedPolicyId),
        actorUserId: access.user.id,
      });
      return NextResponse.json(await catalogPayload({ assignedAllyId: allyId }), {
        headers: NO_STORE_HEADERS,
      });
    }

    return NextResponse.json(
      {
        ok: false,
        code: "INVALID_ACTION",
        error: "La accion solicitada no esta habilitada",
      },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return policyErrorResponse(error, correlationId);
  }
}

export async function DELETE(request: Request) {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) return accessError(access.status);

  const correlationId = randomUUID();
  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || !isUuid(body.policyId)) {
      return NextResponse.json(
        {
          ok: false,
          code: "INVALID_POLICY_ID",
          error: "La politica seleccionada no es valida",
          correlationId,
        },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    const expectedVersion = Number(body.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return NextResponse.json(
        {
          ok: false,
          code: "INVALID_POLICY_VERSION",
          error: "La version esperada no es valida",
          correlationId,
        },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    const policy = await retireDataCreditoPolicyProfile({
      policyId: String(body.policyId),
      expectedVersion,
    });
    return NextResponse.json(
      {
        ...(await catalogPayload()),
        deletionMode: "RETIRED",
        policy,
        correlationId,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return policyErrorResponse(error, correlationId);
  }
}
