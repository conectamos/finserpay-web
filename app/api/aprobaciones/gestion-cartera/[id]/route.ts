import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import { getCreditManagement, createCreditManagement, parseCreditManagement } from "@/lib/analyst-mora-management";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import { getMoraExtensionActions } from "@/lib/mora-exception-requests";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await getMoraActor();
    const { id } = await context.params;
    const detail = await getCreditManagement(Number(id));
    const extensionActions = await getMoraExtensionActions(detail.credit.prorrogaActiva?.id || null, actor);
    return NextResponse.json({ ok: true, ...detail, extensionActions, currentResponsible: { id: actor.id, nombre: actor.nombre } }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const actor = await getMoraActor();
    const { id } = await context.params;
    const input = parseCreditManagement(await readApprovalRequest(request, { maxBytes: 10000 }));
    return NextResponse.json({ ok: true, ...await createCreditManagement(Number(id), input, actor) }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
