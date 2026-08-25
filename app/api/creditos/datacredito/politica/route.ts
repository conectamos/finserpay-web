import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import {
  DATA_CREDITO_INCLUDE_DISABLED_POLICY_PARAM,
  shouldLoadDataCreditoPolicy,
} from "@/lib/datacredito/policy-access";
import {
  DATACREDITO_NO_INFORMATION_SCORE,
  DataCreditoPolicyValidationError,
  normalizeDataCreditoPlatform,
  parseDataCreditoPolicyBands,
  parseDataCreditoPolicyFinancialSettings,
  parseDataCreditoPolicyPriorityRules,
  resolveDataCreditoDecision,
  type DataCreditoDecision,
  type DataCreditoOffer,
  type DataCreditoPlatform,
} from "@/lib/datacredito/policy";
import { getCreditSettings } from "@/lib/credit-settings";
import {
  createDataCreditoPolicyVersion,
  DATACREDITO_CONSENT_HASH,
  DATACREDITO_CONSENT_TEXT,
  DATACREDITO_CONSENT_VERSION,
  DataCreditoPolicyConflictError,
  DataCreditoStorageConfigurationError,
  getAssignedDataCreditoPolicy,
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
  policy: Awaited<ReturnType<typeof createDataCreditoPolicyVersion>>;
  provider: ReturnType<typeof getDataCreditoPublicConfig>;
  simulationRequested?: boolean;
  simulation?: {
    kind: "POLICY_NO_INFORMATION";
    simulationOnly: true;
    platform: DataCreditoPlatform;
    decision: DataCreditoDecision;
    offer: DataCreditoOffer | null;
    policyVersion: number;
    policyRevisionId: string;
  } | null;
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
    ...(input.simulationRequested
      ? { simulation: input.simulation || null }
      : {}),
    consent: {
      version: DATACREDITO_CONSENT_VERSION,
      text: DATACREDITO_CONSENT_TEXT,
      hash: DATACREDITO_CONSENT_HASH,
    },
  };
}

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const requestUrl = new URL(request.url);
    const provider = getDataCreditoPublicConfig();
    const centralAdmin = isCentralAdmin(user);
    const includeDisabledPolicy =
      requestUrl.searchParams.get(
        DATA_CREDITO_INCLUDE_DISABLED_POLICY_PARAM
      ) === "true";
    const purpose = requestUrl.searchParams.get("purpose");
    const simulationRequested = purpose === "simulation";
    const simulationPlatform = simulationRequested
      ? normalizeDataCreditoPlatform(requestUrl.searchParams.get("platform"))
      : null;

    if (purpose && !simulationRequested) {
      return NextResponse.json(
        { ok: false, error: "El proposito solicitado no es valido" },
        { status: 400 }
      );
    }
    if (simulationRequested && !simulationPlatform) {
      return NextResponse.json(
        { ok: false, error: "La simulacion requiere plataforma ANDROID o IPHONE" },
        { status: 400 }
      );
    }

    if (
      !shouldLoadDataCreditoPolicy({
        enabled: provider.enabled,
        centralAdmin,
        includeDisabledPolicy,
      })
    ) {
      return NextResponse.json(
        serializePolicyResponse({
          centralAdmin: false,
          policy: null,
          provider,
          simulationRequested,
          simulation: null,
        })
      );
    }

    const assigned = await getAssignedDataCreditoPolicy(user.aliadoId || null);
    const policy = assigned.kind === "READY" ? assigned.policy : null;
    const simulationResolution =
      simulationRequested && simulationPlatform && policy
        ? resolveDataCreditoDecision(
            { ...policy, priorityRules: null },
            simulationPlatform,
            DATACREDITO_NO_INFORMATION_SCORE
          )
        : null;
    const simulation =
      simulationRequested && simulationPlatform && policy && simulationResolution
        ? {
            kind: "POLICY_NO_INFORMATION" as const,
            simulationOnly: true as const,
            platform: simulationPlatform,
            decision: simulationResolution.decision,
            offer:
              simulationResolution.decision === "APROBADO"
                ? simulationResolution.offer
                : null,
            policyVersion: policy.version,
            policyRevisionId: policy.revisionId,
          }
        : null;
    return NextResponse.json(
      serializePolicyResponse({
        centralAdmin,
        policy,
        provider,
        simulationRequested,
        simulation,
      })
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

    const assigned = await getAssignedDataCreditoPolicy(user.aliadoId || null);
    if (assigned.kind !== "READY") {
      return NextResponse.json(
        {
          ok: false,
          code: "POLICY_NOT_ASSIGNED",
          error: "El aliado central no tiene una politica activa asignada",
        },
        { status: 503 }
      );
    }

    const bands = parseDataCreditoPolicyBands(body.bands, {
      requireFinancingTerms: true,
    });
    const creditDefaults = await getCreditSettings();
    const financialSettings = parseDataCreditoPolicyFinancialSettings(
      body.financialSettings ??
        assigned.policy.financialSettings ?? {
          calculoVersion: "ARES_FRANCES_V1",
          tasaInteresEa: creditDefaults.tasaInteresEa,
          fianzaTotalPorcentaje: creditDefaults.fianzaTotalPorcentaje,
          seguroCuotaPorcentaje: creditDefaults.seguroCuotaPorcentaje,
          frecuenciaPago: creditDefaults.frecuenciaPago,
          tasaPeriodoDecimales: 6,
          redondeoComercial: {
            modo: "PISO",
            multiplo: 50,
          },
        }
    )!;
    const priorityRulesInput =
      body.priorityRules ?? assigned.policy.priorityRules;
    if (priorityRulesInput === null || priorityRulesInput === undefined) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "La revision historica no incluye una regla prioritaria. Envia priorityRules explicitamente antes de publicar.",
        },
        { status: 400 }
      );
    }
    const priorityRules =
      parseDataCreditoPolicyPriorityRules(priorityRulesInput)!;
    const policy = await createDataCreditoPolicyVersion({
      profileId: assigned.policy.profileId,
      bands,
      financialSettings,
      priorityRules,
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
