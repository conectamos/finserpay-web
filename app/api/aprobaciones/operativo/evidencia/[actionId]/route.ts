import { NextResponse } from "next/server";
import { operationalErrorResponse, operationalPrivateHeaders, requireOperationalActor } from "@/lib/approval-operations-http";
import { getOperationalEvidence } from "@/lib/approval-operations-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ actionId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    await requireOperationalActor();
    const { actionId } = await context.params;
    const evidence = await getOperationalEvidence(actionId);
    const fileName = evidence.name.replace(/[\r\n"\\/]/g, "_");
    return new NextResponse(new Uint8Array(evidence.data), {
      headers: {
        ...operationalPrivateHeaders,
        "Content-Type": evidence.mime,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Content-Security-Policy": "sandbox",
      },
    });
  } catch (error) {
    return operationalErrorResponse(error);
  }
}
