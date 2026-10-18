import { getMoraActor } from "@/lib/analyst-mora-access";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import { dispatchCreditCommunication, getCreditCommunicationState, parseCreditCommunication } from "@/lib/credit-collection-communications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    await getMoraActor();
    const { id } = await context.params;
    return Response.json({ ok: true, ...await getCreditCommunicationState(Number(id)) }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const actor = await getMoraActor();
    const input = parseCreditCommunication(await readApprovalRequest(request, { maxBytes: 1500 }));
    const { id } = await context.params;
    const result = await dispatchCreditCommunication(Number(id), input, actor);
    return Response.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
