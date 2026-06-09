import { NextResponse } from "next/server";
import {
  extractFirmaSeguroStatus,
  extractFirmaSeguroUuid,
  getFirmaSeguroConfig,
} from "@/lib/firmaseguro";
import {
  getFirmaSeguroProcessForCallback,
  markCreditoFirmaSeguroCompleted,
  refreshFirmaSeguroProcess,
  serializeFirmaSeguroProcess,
} from "@/lib/firmaseguro-credit";
import { updateFirmaSeguroProcess } from "@/lib/firmaseguro-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorizedCallback(request: Request) {
  const config = getFirmaSeguroConfig();
  if (!config.callbackSecret) {
    return true;
  }

  const url = new URL(request.url);
  const headerToken =
    request.headers.get("x-firmaseguro-token") ||
    request.headers.get("x-webhook-token") ||
    request.headers.get("x-callback-token") ||
    "";

  return (
    url.searchParams.get("token") === config.callbackSecret ||
    headerToken === config.callbackSecret
  );
}

export async function POST(request: Request) {
  try {
    if (!isAuthorizedCallback(request)) {
      return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const url = new URL(request.url);
    const processUuid =
      extractFirmaSeguroUuid(body) || url.searchParams.get("uuid") || "";
    const status =
      extractFirmaSeguroStatus(body) ||
      url.searchParams.get("status") ||
      "CALLBACK";

    if (!processUuid) {
      return NextResponse.json(
        { ok: false, error: "Callback sin UUID de proceso" },
        { status: 400 }
      );
    }

    const current = await getFirmaSeguroProcessForCallback(processUuid);
    if (!current) {
      return NextResponse.json(
        { ok: false, error: "Proceso FirmaSeguro no encontrado" },
        { status: 404 }
      );
    }

    const updated = await updateFirmaSeguroProcess(processUuid, {
      status,
      statusPayload: body,
      lastError: null,
    });
    const refreshed = updated
      ? await refreshFirmaSeguroProcess(updated)
      : await refreshFirmaSeguroProcess(current);

    if (refreshed?.completedAt) {
      await markCreditoFirmaSeguroCompleted(refreshed.creditoId, {
        processUuid: refreshed.processUuid,
        status: refreshed.status,
        signedDocumentFileName: refreshed.signedDocumentFileName,
        completedAt: refreshed.completedAt,
      });
    }

    return NextResponse.json({
      ok: true,
      process: serializeFirmaSeguroProcess(refreshed),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "No se pudo procesar callback";

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
