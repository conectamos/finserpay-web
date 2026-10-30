import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import { DataCreditoAdministrativeRejectionError, rejectDataCreditoAdministratively } from "@/lib/datacredito/admin-rejection-storage";
import { hashDataCreditoRequestMetadata } from "@/lib/datacredito/storage";
import { readApprovalRequest } from "@/lib/credit-approval-http";
import { CreditApprovalError } from "@/lib/credit-approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await getDataCreditoCentralAdmin();
  if (!access.ok) return json({ ok: false, code: access.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
    error: "Solo el administrador central puede registrar rechazos administrativos." }, access.status);
  const correlationId = randomUUID();
  try {
    const rawBody = await readApprovalRequest(request, { maxBytes: 4096 });
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody) || Object.keys(rawBody).some(key =>
      !["documentNumber", "solicitudId", "reason", "reviewed", "confirmed", "mutationId"].includes(key))) {
      return json({ ok: false, code: "INVALID_REQUEST", error: "Solicitud de rechazo no válida.", correlationId }, 400);
    }
    const body = rawBody as Record<string, unknown>;
    const { id } = await context.params;
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "";
    const result = await rejectDataCreditoAdministratively({
      assessmentId: id, solicitudId: body.solicitudId, documentNumber: body.documentNumber,
      reason: body.reason, reviewed: body.reviewed, confirmed: body.confirmed, mutationId: body.mutationId,
      providerEnvironment: getDataCreditoPublicConfig().environment, actorUserId: access.user.id,
      ipHash: hashDataCreditoRequestMetadata("ip", ip),
      userAgentHash: hashDataCreditoRequestMetadata("user-agent", request.headers.get("user-agent") || ""),
    });
    return json({ ok: true, result, correlationId });
  } catch (error) {
    if (error instanceof DataCreditoAdministrativeRejectionError || error instanceof CreditApprovalError) {
      return json({ ok: false, code: error.code, error: error.message, correlationId }, error.status);
    }
    console.error("[datacredito-administrative-rejection]", { correlationId, errorType: error instanceof Error ? error.name : "UnknownError" });
    return json({ ok: false, code: "ADMINISTRATIVE_REJECTION_UNAVAILABLE", error: "No se pudo registrar el rechazo. Los datos se conservan; vuelve a intentarlo.", correlationId }, 500);
  }
}
