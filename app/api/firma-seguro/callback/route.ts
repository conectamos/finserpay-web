import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  extractFirmaSeguroStatus,
  extractFirmaSeguroUuid,
  getFirmaSeguroConfig,
} from "@/lib/firmaseguro";
import {
  getFirmaSeguroProcessForCallback,
  refreshFirmaSeguroProcess,
  serializeFirmaSeguroProcess,
} from "@/lib/firmaseguro-credit";
import { updateFirmaSeguroProcess } from "@/lib/firmaseguro-storage";
import { recordVerifiedDraftCorrectionReissues } from "@/lib/firmaseguro-draft-correction-complete";
import {
  finalizeDraftDispatch,
  getDraftDispatchReceiptByProcessUuid,
  getDraftDispatch,
} from "@/lib/firmaseguro-draft-dispatch-ledger";
import { authorizeFirmaSeguroCallback, readFirmaSeguroCallbackProcessUuid } from "@/lib/firmaseguro-draft-callback-correlation";
import { enqueueDraftSignatureRecovery } from "@/lib/firmaseguro-draft-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CALLBACK_BYTES = 16 * 1024 * 1024;
const privateHeaders = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: privateHeaders });

async function readCallbackBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CALLBACK_BYTES) throw new Error("CALLBACK_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_CALLBACK_BYTES) {
        await reader.cancel();
        throw new Error("CALLBACK_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const auth = authorizeFirmaSeguroCallback(url, request.headers, getFirmaSeguroConfig().callbackSecret);
    if (!auth.authenticated) return response({ ok: false, error: "No autorizado" }, 401);

    const bytes = await readCallbackBody(request);
    let body: unknown = null;
    try { body = JSON.parse(bytes.toString("utf8")); } catch { /* Legacy callbacks may carry the UUID in the URL. */ }
    const processUuid = readFirmaSeguroCallbackProcessUuid(extractFirmaSeguroUuid(body) || url.searchParams.get("uuid"));
    if (!processUuid) return response({ ok: false, error: "UUID de proceso no válido" }, 400);

    let current = await getFirmaSeguroProcessForCallback(processUuid);
    const receipt = !current || auth.dispatchId ? await getDraftDispatchReceiptByProcessUuid(processUuid) : null;
    const scopedDispatch = auth.dispatchId && receipt?.dispatchId !== auth.dispatchId
      ? await getDraftDispatch(auth.dispatchId) : null;
    const scopedProcessUuid = readFirmaSeguroCallbackProcessUuid(scopedDispatch?.processUuid);
    const scopedProcessMatches = !auth.dispatchId || (receipt
      ? receipt.dispatchId === auth.dispatchId
      : scopedProcessUuid?.toLowerCase() === processUuid.toLowerCase());
    if (!current && receipt && scopedProcessMatches) {
      await finalizeDraftDispatch(receipt.dispatchId);
      current = await getFirmaSeguroProcessForCallback(processUuid);
    }
    if (!current || !scopedProcessMatches) {
      // An authenticated callback is only a durable locator candidate. The worker
      // must read FirmaSeguro and verify the frozen dispatch before attaching it.
      await enqueueDraftSignatureRecovery({ processUuid, dispatchId: auth.dispatchId,
        payloadSha256: createHash("sha256").update(bytes).digest("hex") });
      return response({ ok: true, accepted: true }, 202);
    }

    const reportedStatus = extractFirmaSeguroStatus(body) || url.searchParams.get("status") || "CALLBACK";
    const status = reportedStatus.length <= 200 ? reportedStatus : "CALLBACK";
    const updated = await updateFirmaSeguroProcess(processUuid, {
      status,
      statusPayload: body,
      lastError: null,
    });
    const refreshed = updated
      ? await refreshFirmaSeguroProcess(updated)
      : await refreshFirmaSeguroProcess(current);
    await recordVerifiedDraftCorrectionReissues(refreshed);

    return response({ ok: true, process: serializeFirmaSeguroProcess(refreshed) });
  } catch (error) {
    if (error instanceof Error && error.message === "CALLBACK_TOO_LARGE") {
      return response({ ok: false, error: "Callback demasiado grande" }, 413);
    }
    return response({ ok: false, error: "No se pudo procesar callback" }, 500);
  }
}
