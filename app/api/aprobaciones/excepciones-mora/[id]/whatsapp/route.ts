import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import { retryMoraExtensionWhatsApp } from "@/lib/mora-extension-whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getMoraActor();
    const { id } = await context.params;
    const body = await readApprovalRequest(request, { maxBytes: 100 });
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      throw new CreditApprovalError("INVALID_REQUEST", "El reintento utiliza los datos guardados de la prórroga.");
    }
    const whatsApp = await retryMoraExtensionWhatsApp(id, actor);
    return NextResponse.json({ ok: true, whatsApp }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
