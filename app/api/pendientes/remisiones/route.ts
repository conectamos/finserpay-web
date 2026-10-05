import { NextResponse } from "next/server";
import { getPendingAllyActor } from "@/lib/credit-approval-novelty-http";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import {
  listAllyReplacementRemissions, ReplacementRemissionError, uploadReplacementRemission,
} from "@/lib/credit-device-replacement-remission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(error: unknown) {
  if (error instanceof ReplacementRemissionError) return NextResponse.json(
    { ok: false, code: error.code, error: error.message },
    { status: error.status, headers: approvalPrivateHeaders });
  return approvalErrorResponse(error);
}

export async function GET() {
  try {
    const actor = await getPendingAllyActor();
    const items = await listAllyReplacementRemissions(actor);
    return NextResponse.json({ ok: true, items }, { headers: approvalPrivateHeaders });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await getPendingAllyActor();
    const body = await readApprovalRequest(request, { maxBytes: 2_700_000 });
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "imageDataUrl,replacementId") {
      throw new ReplacementRemissionError("INVALID_REQUEST", "Envía la foto de la remisión solicitada.", 400);
    }
    const input = body as { replacementId: unknown; imageDataUrl: unknown };
    if (typeof input.replacementId !== "string" || !UUID.test(input.replacementId))
      throw new ReplacementRemissionError("INVALID_REQUEST", "Solicitud de remisión no válida.", 400);
    const remission = await uploadReplacementRemission(input.replacementId, actor, input);
    return NextResponse.json({ ok: true, remission }, { headers: approvalPrivateHeaders });
  } catch (error) { return failure(error); }
}
