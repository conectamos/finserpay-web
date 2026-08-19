import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  buildDataCreditoAdminRiskSummary,
  sanitizeDataCreditoProviderPayload,
} from "@/lib/datacredito/admin-report";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import { getDataCreditoAssessmentDossierForAdmin } from "@/lib/datacredito/admin-storage";
import { hashDataCreditoRequestMetadata } from "@/lib/datacredito/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function requestMetadata(request: Request, actorUserId: number) {
  const forwardedFor = request.headers.get("x-forwarded-for") || "";
  const ip =
    forwardedFor.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "";
  const userAgent = request.headers.get("user-agent") || "";
  return {
    actorUserId,
    ipHash: hashDataCreditoRequestMetadata("ip", ip),
    userAgentHash: hashDataCreditoRequestMetadata("user-agent", userAgent),
    requestCorrelationId: randomUUID(),
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          access.status === 401
            ? "No autenticado"
            : "Solo el administrador central de FINSER PAY puede abrir este expediente",
      },
      { status: access.status, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const { id } = await context.params;
    const dossier = await getDataCreditoAssessmentDossierForAdmin(
      id,
      requestMetadata(request, access.user.id)
    );
    if (!dossier) {
      return NextResponse.json(
        { ok: false, error: "La consulta no existe o venció su retención" },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }
    const providerPayload = dossier.secureRecord?.providerPayload ?? null;
    return NextResponse.json(
      {
        ok: true,
        assessment: dossier.assessment,
        identity: dossier.secureRecord
          ? {
              documentNumber: dossier.secureRecord.documentNumber,
              firstSurname: dossier.secureRecord.firstSurname,
            }
          : null,
        summary: providerPayload
          ? buildDataCreditoAdminRiskSummary(providerPayload)
          : null,
        providerData: providerPayload
          ? sanitizeDataCreditoProviderPayload(providerPayload)
          : null,
        historicWithoutDossier: !dossier.secureRecord,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "No se pudo abrir el expediente de DataCrédito" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
