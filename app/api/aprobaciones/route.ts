import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { approvalDocumentNumber, listCreditApprovals, CreditApprovalError } from "@/lib/credit-approval";
import { listCreditApprovalQueue, listApprovedCreditQueue, approvalQueueLimit, approvalQueueSearch, countCreditApprovalQueues } from "@/lib/credit-approval-queue";
import { assertApprovalActorActive } from "@/lib/credit-approval-actor";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = await getApprovalActor();
    const params = new URL(request.url).searchParams;
    const view = params.get("view");
    if (view !== null && view !== "pending" && view !== "approved") throw new CreditApprovalError("INVALID_VIEW", "Selecciona Pendientes por aprobar o Aprobadas.");
    const document = params.get("documento");
    const documento = document ? approvalDocumentNumber(document) : null;
    const q = approvalQueueSearch(params.get("q"));
    const withCounts = params.get("counts") === "1";
    if (documento && view === null && actor.kind !== "SHARED_LINK" && !q && !withCounts) {
      const items = await listCreditApprovals(prisma, documento);
      return NextResponse.json({ ok: true, items }, { headers: approvalPrivateHeaders });
    }
    const input = { documento, cursor: params.get("cursor"), limit: approvalQueueLimit(params.get("limit")), ...(q ? { q } : {}) };
    const list = view === "approved" ? listApprovedCreditQueue : listCreditApprovalQueue;
    const page = withCounts ? await prisma.$transaction(async db => {
      await assertApprovalActorActive(db, actor);
      const result = await list(db, input);
      const counts = await countCreditApprovalQueues(db, { documento, q });
      return { ...result, counts };
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 }) : await list(prisma, input);
    return NextResponse.json({ ok: true, ...page }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
