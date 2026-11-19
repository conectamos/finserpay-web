import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDataCreditoAllyBranchQuotaAdmin } from "@/lib/datacredito/ally-branch-quota-access";
import { getDataCreditoAllyBranchQuota } from "@/lib/datacredito/ally-branch-quota-storage";
import {
  DataCreditoBranchDailyQuotaConflictError,
  DataCreditoBranchDailyQuotaValidationError,
  parseDataCreditoBranchDailyQuotas,
  parseDataCreditoDailyQueryLimit,
  DataCreditoDailyQueryLimitValidationError,
  setDataCreditoBranchDailyQuotas,
} from "@/lib/datacredito/admin-storage";
import { DataCreditoStorageConfigurationError } from "@/lib/datacredito/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };
const ALLOWED_FIELDS = new Set(["expectedDailyQueryLimit", "branches", "reason"]);
const ALLOWED_BRANCH_FIELDS = new Set(["branchId", "dailyLimit", "expectedDailyLimit"]);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function denied(status: 401 | 403) {
  return json({ ok: false, error: status === 401 ? "No autenticado" : "Solo el administrador del aliado puede distribuir sus cupos de consultas." }, status);
}

function validOrigin(request: Request) {
  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin || !/^https?:\/\/[^/?#\s\\]+$/i.test(origin)) return false;
  try {
    const source = new URL(origin);
    if (source.username || source.password) return false;
    const requested = new URL(request.url);
    if (source.origin === requested.origin) return true;
    // A reverse proxy can reconstruct request.url with the internal HTTP host.
    // Only the actual Host authority is accepted, never X-Forwarded-Host.
    const host = request.headers.get("host");
    return Boolean(host && !/[\s,\/\\?#@%]/.test(host) && source.origin === `https://${host}`);
  } catch { return false; }
}

function failure(error: unknown, correlationId: string) {
  if (error instanceof DataCreditoBranchDailyQuotaConflictError) {
    return json({ ok: false, code: "BRANCH_DAILY_QUOTA_CONFLICT", error: error.message, correlationId }, 409);
  }
  if (error instanceof DataCreditoBranchDailyQuotaValidationError || error instanceof DataCreditoDailyQueryLimitValidationError) {
    return json({ ok: false, code: "BRANCH_DAILY_QUOTA_INVALID", error: error.message, correlationId }, 400);
  }
  if (error instanceof DataCreditoStorageConfigurationError) {
    return json({ ok: false, code: error.code, error: "La configuración de consultas no está disponible. Contacta al administrador central.", correlationId }, 503);
  }
  if (error instanceof Error && error.message === "DATACREDITO_ALLY_NOT_FOUND") {
    return json({ ok: false, code: "ALLY_NOT_FOUND", error: "El aliado no está disponible.", correlationId }, 404);
  }
  console.error("ERROR CUPOS SEDES ALIADO", { correlationId, errorType: error instanceof Error ? error.name : "UnknownError" });
  return json({ ok: false, code: "ALLY_BRANCH_QUOTA_ERROR", error: "No se pudo completar la operación de cupos por sede.", correlationId }, 500);
}

export async function GET() {
  const access = await getDataCreditoAllyBranchQuotaAdmin();
  if (!access.ok) return denied(access.status);
  const correlationId = randomUUID();
  try {
    const ally = await getDataCreditoAllyBranchQuota(access.allyId);
    if (!ally) throw new Error("DATACREDITO_ALLY_NOT_FOUND");
    return json({ ok: true, ally });
  } catch (error) { return failure(error, correlationId); }
}

export async function POST(request: Request) {
  const access = await getDataCreditoAllyBranchQuotaAdmin();
  if (!access.ok) return denied(access.status);
  const correlationId = randomUUID();
  if (!validOrigin(request)) return json({ ok: false, code: "INVALID_ORIGIN", error: "Distribuye los cupos desde FINSER PAY." }, 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "INVALID_REQUEST", error: "La solicitud debe usar JSON." }, 400);
  }
  try {
    const raw = await request.text();
    if (raw.length > 1_000_000) throw new DataCreditoBranchDailyQuotaValidationError("La distribución enviada es demasiado grande.");
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); }
    catch { throw new DataCreditoBranchDailyQuotaValidationError("La solicitud no contiene JSON válido."); }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !ALLOWED_FIELDS.has(key)) ||
      !("expectedDailyQueryLimit" in body) ||
      (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string")) {
      throw new DataCreditoBranchDailyQuotaValidationError("Solo puedes redistribuir los cupos de las sedes de tu aliado.");
    }
    if (Array.isArray(body.branches) && body.branches.some(branch => !branch || typeof branch !== "object" || Array.isArray(branch) ||
      Object.keys(branch).some(key => !ALLOWED_BRANCH_FIELDS.has(key)))) {
      throw new DataCreditoBranchDailyQuotaValidationError("La distribución de sedes contiene campos no permitidos.");
    }
    const expectedDailyQueryLimit = parseDataCreditoDailyQueryLimit(body.expectedDailyQueryLimit);
    const branches = parseDataCreditoBranchDailyQuotas(body.branches);
    await setDataCreditoBranchDailyQuotas({
      allyId: access.allyId,
      enabled: true,
      expectedEnabled: true,
      expectedDailyQueryLimit,
      branches,
      actorUserId: access.user.id,
      requestCorrelationId: correlationId,
      reason: typeof body.reason === "string" ? body.reason : null,
      allyRedistributionOnly: true,
    });
  } catch (error) { return failure(error, correlationId); }

  // The write has committed. A refresh failure must never encourage a retry.
  try {
    const ally = await getDataCreditoAllyBranchQuota(access.allyId);
    if (!ally) throw new Error("DATACREDITO_ALLY_NOT_FOUND");
    return json({ ok: true, ally });
  } catch (error) {
    console.error("ERROR RECARGANDO CUPOS SEDES DESPUES DE GUARDAR", { correlationId, errorType: error instanceof Error ? error.name : "UnknownError" });
    return json({
      ok: true,
      operationCommitted: true,
      quotaReloadRequired: true,
      code: "BRANCH_QUOTA_REFRESH_FAILED",
      message: "La distribución quedó guardada. No se pudo actualizar el listado; consúltalo de nuevo antes de realizar otro cambio.",
      correlationId,
    });
  }
}
