import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import { CreditDeviceReplacementError } from "@/lib/credit-device-replacement-storage";
import {
  confirmMassImeiCorrections,
  MassImeiCorrectionError,
  parseMassImeiCorrectionRows,
  previewMassImeiCorrections,
} from "@/lib/credit-mass-imei-correction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Vary: "Cookie",
    },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof MassImeiCorrectionError) {
    return json({ ok: false, code: error.code, error: error.message }, error.status);
  }
  if (error instanceof CreditDeviceReplacementError) {
    return json({ ok: false, code: error.code, error: error.message }, error.status);
  }
  const databaseError = error as { code?: string; meta?: { code?: string } };
  if (
    databaseError?.code === "23505" ||
    databaseError?.code === "P2002" ||
    databaseError?.meta?.code === "23505"
  ) {
    return json({
      ok: false,
      code: "IMEI_CONFLICT",
      error: "El IMEI ya está asignado. Vuelve a previsualizar el lote.",
    }, 409);
  }
  if (databaseError?.code === "42P01") {
    return json({
      ok: false,
      code: "SCHEMA_NOT_READY",
      error: "La corrección aún no está disponible. Intenta nuevamente cuando termine la actualización.",
    }, 503);
  }
  console.error("POST /api/creditos/masivos/correcciones-imei", error);
  return json({ ok: false, error: "No se pudo corregir el lote de IMEI." }, 500);
}

export async function POST(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return json({ ok: false, error: "No autenticado." }, 401);
    if (!isAdminRole(user.rolNombre) || !isFinserPayCentralAlly(user.aliadoAccesoCodigo)) {
      return json({
        ok: false,
        error: "Solo el administrador central de FINSER PAY puede corregir IMEI masivos.",
      }, 403);
    }

    const payload: unknown = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ ok: false, error: "Solicitud JSON inválida." }, 400);
    }
    const body = payload as Record<string, unknown>;
    if (typeof body.commit !== "boolean") {
      return json({ ok: false, error: "Indica si la operación es previsualización o confirmación." }, 400);
    }
    const allowed = body.commit
      ? ["commit", "confirmed", "requestId", "rows"]
      : ["commit", "rows"];
    if (Object.keys(body).sort().join(",") !== allowed.sort().join(",")) {
      return json({ ok: false, error: "La solicitud contiene campos no permitidos o incompletos." }, 400);
    }
    const rows = parseMassImeiCorrectionRows(body.rows);
    if (!body.commit) {
      return json(await previewMassImeiCorrections(rows));
    }
    if (body.confirmed !== true || typeof body.requestId !== "string") {
      return json({
        ok: false,
        error: "Confirma que cada IMEI nuevo corresponde al equipo original y genera un identificador de operación.",
      }, 400);
    }
    return json(await confirmMassImeiCorrections({
      rows,
      requestId: body.requestId,
      actor: { id: user.id, nombre: user.nombre },
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
