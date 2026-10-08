import { NextResponse } from "next/server";
import { analystCenterErrorResponse, analystCenterPrivateHeaders, analystCenterQuery, requireAnalystCenterActor } from "@/lib/analyst-center-http";
import { getAnalystCenterManagements } from "@/lib/analyst-center-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireAnalystCenterActor();
    const params = analystCenterQuery(request, ["page", "pageSize"]);
    const result = await getAnalystCenterManagements(actor.id, {
      page: params.get("page"), pageSize: params.get("pageSize"),
    });
    return NextResponse.json(result, { headers: analystCenterPrivateHeaders });
  } catch (error) {
    return analystCenterErrorResponse(error);
  }
}
