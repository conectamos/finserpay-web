import { NextResponse } from "next/server";
import {
  operationalErrorResponse, operationalJson, operationalPrivateHeaders,
  operationalTarget, rejectUnexpectedJsonFields, requireOperationalActor,
} from "@/lib/approval-operations-http";
import {
  ReplacementRemissionError, reviewReplacementRemission,
} from "@/lib/credit-device-replacement-remission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ kind: string; id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireOperationalActor();
    const target = operationalTarget((await context.params).kind, (await context.params).id);
    if (target.kind !== "CREDIT") throw new ReplacementRemissionError("INVALID_CASE",
      "La nueva remisión corresponde a un crédito.", 400);
    const body = await operationalJson(request);
    rejectUnexpectedJsonFields(body, ["replacementId", "action", "note"]);
    if (typeof body.replacementId !== "string" || !UUID.test(body.replacementId) ||
      (body.action !== "VERIFY" && body.action !== "REJECT"))
      throw new ReplacementRemissionError("INVALID_REQUEST", "Actualiza el crédito y selecciona una remisión válida.", 400);
    const remission = await reviewReplacementRemission(target.id, body.replacementId, actor, body.action,
      typeof body.note === "string" ? body.note : null);
    return NextResponse.json({ ok: true, remission }, { headers: operationalPrivateHeaders });
  } catch (error) {
    if (error instanceof ReplacementRemissionError)
      return NextResponse.json({ ok: false, code: error.code, error: error.message },
        { status: error.status, headers: operationalPrivateHeaders });
    return operationalErrorResponse(error);
  }
}
