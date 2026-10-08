import { NextResponse } from "next/server";
import { analystCenterErrorResponse, analystCenterPrivateHeaders, analystCenterQuery, requireAnalystCenterActor } from "@/lib/analyst-center-http";
import { searchAnalystCenterCases } from "@/lib/analyst-center-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAnalystCenterActor();
    const params = analystCenterQuery(request, ["q"]);
    const items = await searchAnalystCenterCases(params.get("q"));
    return NextResponse.json({ ok: true, items }, { headers: analystCenterPrivateHeaders });
  } catch (error) {
    return analystCenterErrorResponse(error);
  }
}
