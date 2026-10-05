import { NextResponse } from "next/server";
import {
  operationalErrorResponse, operationalPrivateHeaders,
  operationalTarget, requireOperationalActor,
} from "@/lib/approval-operations-http";
import {
  getReplacementRemissionPhoto, ReplacementRemissionError,
} from "@/lib/credit-device-replacement-remission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ kind: string; id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: Context) {
  try {
    await requireOperationalActor();
    const { kind, id } = await context.params;
    const target = operationalTarget(kind, id);
    const replacementId = new URL(request.url).searchParams.get("replacementId");
    if (target.kind !== "CREDIT" || !replacementId || !UUID.test(replacementId))
      throw new ReplacementRemissionError("INVALID_REQUEST", "Remisión no válida.", 400);
    const photo = await getReplacementRemissionPhoto(target.id, replacementId);
    return new Response(new Uint8Array(photo.data), { headers: {
      ...operationalPrivateHeaders, "Content-Type": photo.mime,
      "Content-Disposition": 'inline; filename="remision-firmada"',
    } });
  } catch (error) {
    if (error instanceof ReplacementRemissionError)
      return NextResponse.json({ ok: false, code: error.code, error: error.message },
        { status: error.status, headers: operationalPrivateHeaders });
    return operationalErrorResponse(error);
  }
}
