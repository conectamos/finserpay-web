import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { approvalActorAudit, assertApprovalActorCreditReadAccess, type ApprovalActor } from "@/lib/credit-approval-actor";
import { assertMoraActor } from "@/lib/analyst-mora-access";
import { CreditApprovalError, getCreditApprovalDetail } from "@/lib/credit-approval";
import { ApprovalOperationalError } from "@/lib/approval-operations-write";
import { refreshSignatureWithAccess } from "@/lib/approval-operational-signature-refresh";
import { ensureCreditApprovalDocumentRefreshSchema } from "@/lib/credit-approval-document-refresh-schema";

async function currentActor(db: Prisma.TransactionClient, id: number, actor: ApprovalActor): Promise<ApprovalActor> {
  await assertApprovalActorCreditReadAccess(db, id, actor);
  if (actor.kind === "SHARED_LINK") return actor;
  return assertMoraActor(db, { ...actor, centralAdmin: false });
}

/** Same-credit provider GETs use the existing read scope, including shared
 * grants. The audit retains the actual grant/session instead of inventing a user. */
export async function refreshCreditApprovalDocument(id: number, input: { expectedProcessUuid: unknown }, actor: ApprovalActor) {
  await prisma.$transaction(async db => {
    await currentActor(db, id, actor);
  }, { timeout: 20_000 });
  await ensureCreditApprovalDocumentRefreshSchema();
  let refreshed: Awaited<ReturnType<typeof refreshSignatureWithAccess>>;
  try {
    refreshed = await refreshSignatureWithAccess("CREDIT", id, input, {
      assert: db => currentActor(db, id, actor),
      audit: async (db, _kind, creditId, verifiedActor, status) => {
        const identity = approvalActorAudit(verifiedActor);
        let result = status === "SIGNATURE_REFRESH_REQUESTED" ? "REQUESTED"
          : status === "SIGNATURE_REFRESH_SIGNED" ? "RECOVERED" : "UNAVAILABLE";
        if (result === "RECOVERED") {
          const document = (await getCreditApprovalDetail(db, creditId, verifiedActor)).document;
          if (!document.available || document.processUuid !== input.expectedProcessUuid) result = "UNAVAILABLE";
        }
        await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalDocumentRefreshEvent"
          ("id","creditoId","processUuid","actorKind","actorUserId","actorName","actorGrantId","actorSessionId","status")
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9)`,
          randomUUID(), creditId, input.expectedProcessUuid, identity.actorKind, identity.actorUserId,
          identity.actorName, identity.actorGrantId, identity.actorSessionId, result);
      },
    });
  } catch (error) {
    if (error instanceof ApprovalOperationalError)
      throw new CreditApprovalError(error.code, error.message, error.status);
    throw error;
  }
  return prisma.$transaction(async db => {
    await currentActor(db, id, actor);
    const item = await getCreditApprovalDetail(db, id, actor);
    // The refresh releases its origin lock before this approval projection. A
    // concurrent revision must not make the previous process look recovered.
    if (item.document.processUuid !== input.expectedProcessUuid)
      throw new CreditApprovalError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza el expediente antes de continuar.", 409);
    const message = !item.document.available && refreshed.item.signature.status === "SIGNED"
      ? "Se consultó FirmaSeguro, pero el PDF firmado todavía no está disponible para este expediente."
      : refreshed.message;
    return { item, message };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}
