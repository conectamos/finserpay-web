import { NextResponse } from "next/server";
import { operationalErrorResponse, operationalJson, operationalPrivateHeaders,
  operationalTarget, rejectUnexpectedJsonFields, requireOperationalActor } from "@/lib/approval-operations-http";
import { refreshOperationalSignature } from "@/lib/approval-operational-signature-refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ kind: string; id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireOperationalActor();
    const { kind, id } = await context.params;
    const target = operationalTarget(kind, id);
    const body = await operationalJson(request);
    rejectUnexpectedJsonFields(body, ["expectedProcessUuid"]);
    const result = await refreshOperationalSignature(target.kind, target.id,
      { expectedProcessUuid: body.expectedProcessUuid }, actor);
    return NextResponse.json({ ok: true, ...result }, { headers: operationalPrivateHeaders });
  } catch (error) {
    return operationalErrorResponse(error);
  }
}
