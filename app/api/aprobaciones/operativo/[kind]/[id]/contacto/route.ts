import { NextResponse } from "next/server";
import {
  operationalErrorResponse, operationalJson, operationalPrivateHeaders,
  operationalTarget, rejectUnexpectedJsonFields, requireOperationalActor,
} from "@/lib/approval-operations-http";
import { updateOperationalContact } from "@/lib/approval-operations-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ kind: string; id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await requireOperationalActor();
    const { kind, id } = await context.params;
    const target = operationalTarget(kind, id);
    const body = await operationalJson(request);
    rejectUnexpectedJsonFields(body, ["phone", "email", "reason", "idempotencyKey", "expectedProcessUuid"]);
    const operation = await updateOperationalContact(target.kind, target.id, body as {
      phone?: unknown; email?: unknown; reason: unknown; idempotencyKey: unknown; expectedProcessUuid: unknown;
    }, actor);
    return NextResponse.json({ ok: true, operation }, { headers: operationalPrivateHeaders });
  } catch (error) {
    return operationalErrorResponse(error);
  }
}
