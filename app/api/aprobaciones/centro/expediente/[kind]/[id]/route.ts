import { NextResponse } from "next/server";
import { analystCenterErrorResponse, analystCenterPrivateHeaders, analystCenterQuery, requireAnalystCenterActor } from "@/lib/analyst-center-http";
import { getAnalystCenterCase } from "@/lib/analyst-center-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ kind: string; id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    await requireAnalystCenterActor();
    analystCenterQuery(request, []);
    const { kind, id } = await context.params;
    const detail = await getAnalystCenterCase(kind, id);
    return NextResponse.json({ ok: true, ...detail }, { headers: analystCenterPrivateHeaders });
  } catch (error) {
    return analystCenterErrorResponse(error);
  }
}
