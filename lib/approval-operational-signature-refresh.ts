import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { assertMoraActor } from "@/lib/analyst-mora-access";
import { ensureApprovalOperationalSchema } from "@/lib/approval-operations-schema";
import { getOperationalCase, operationalCaseIdentity } from "@/lib/approval-operations-read";
import { ApprovalOperationalError, type OperationalActor } from "@/lib/approval-operations-write";
import type { OperationalCaseKind } from "@/lib/approval-operations-types";
import { refreshFirmaSeguroProcess } from "@/lib/firmaseguro-credit";
import { isFirmaSeguroSuccessfulStatus } from "@/lib/firmaseguro-status";
import { ensureFirmaSeguroSchema, tryAcquireSolicitudOperationLock,
  type FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";

type Database = Prisma.TransactionClient;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reason = "Consulta técnica del estado del mismo documento en FirmaSeguro.";

async function currentProcess(db: Database, kind: OperationalCaseKind, id: number, expectedProcessUuid: string) {
  if (kind === "DRAFT") {
    const drafts = await db.$queryRawUnsafe<Array<{ currentStep: number }>>(
      `SELECT "currentStep" FROM "CreditoBorrador" WHERE "id"=$1 AND "estado"='ABIERTO'
        AND "creditoId" IS NULL AND "currentStep" IN (3,4,5)
        AND COALESCE("expiresAt","createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP`, id);
    if (!drafts[0]) throw new ApprovalOperationalError("DRAFT_NOT_AVAILABLE",
      "La solicitud ya no está abierta para consultar su firma.");
  } else {
    const credits = await db.$queryRawUnsafe<Array<{ id: number }>>(
      `SELECT "id" FROM "Credito" WHERE "id"=$1
        AND UPPER(BTRIM("estado")) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA') FOR SHARE`, id);
    if (!credits[0]) throw new ApprovalOperationalError("CREDIT_NOT_AVAILABLE",
      "El crédito no está disponible para consultar su firma.");
  }
  const column = kind === "DRAFT" ? "draftId" : "creditoId";
  const processes = await db.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `SELECT * FROM "FirmaSeguroProcess" WHERE "${column}"=$1 AND "supersededAt" IS NULL
      ORDER BY "createdAt" DESC,"id" DESC LIMIT 2`, id);
  const process = processes[0];
  if (processes.length !== 1 || processes[0].processUuid !== expectedProcessUuid ||
      process.supersededAt || (kind === "DRAFT" && (process.draftId !== id || process.creditoId !== null)) ||
      (kind === "CREDIT" && process.creditoId !== id))
    throw new ApprovalOperationalError("PROCESS_CHANGED",
      "La firma vigente cambió o requiere revisión. Actualiza la solicitud antes de consultar.");
  const lockDraftId = kind === "DRAFT" ? id : process.draftId;
  if (!Number.isSafeInteger(lockDraftId) || !lockDraftId || lockDraftId < 1 || lockDraftId > 2_147_483_647)
    throw new ApprovalOperationalError("SIGNATURE_ORIGIN_UNAVAILABLE",
      "No se pudo verificar la solicitud de origen de esta firma. Requiere revisión técnica.");
  if (kind === "CREDIT") {
    const origins = await db.$queryRawUnsafe<Array<{ id: number }>>(
      `SELECT "id" FROM "CreditoBorrador" WHERE "id"=$1 AND "creditoId"=$2 FOR SHARE`, lockDraftId, id);
    if (!origins[0]) throw new ApprovalOperationalError("SIGNATURE_ORIGIN_UNAVAILABLE",
      "No se pudo verificar la solicitud de origen de esta firma. Requiere revisión técnica.");
  }
  return { process, lockDraftId };
}

async function audit(db: Database, kind: OperationalCaseKind, id: number, actor: OperationalActor, status: string) {
  // The operational ledger is immutable. No contractual, contact or provider
  // payload is copied into an event that only records a status consultation.
  await db.$executeRawUnsafe(`INSERT INTO "ApprovalOperationalAction"
    ("id","targetKind","targetId","creditId","eventType","actorUserId","actorName","reason","status")
    VALUES ($1::uuid,$2,$3,$4,'SIGNATURE_STATUS_CHECKED',$5,$6,$7,$8)`,
    randomUUID(), kind, id, kind === "CREDIT" ? id : null, actor.id, actor.nombre, reason, status);
}

/** Refreshes a known provider process; never creates, edits or resends a document. */
export async function refreshOperationalSignature(kindValue: unknown, idValue: unknown,
  input: { expectedProcessUuid: unknown }, actor: OperationalActor) {
  const { kind, id } = operationalCaseIdentity(kindValue, idValue);
  if (!Number.isSafeInteger(actor.id) || actor.id < 1 || typeof actor.nombre !== "string" || !actor.nombre.trim())
    throw new ApprovalOperationalError("UNAUTHORIZED", "Inicia sesión con tu cuenta de Aprobaciones.", 401);
  if (id > 2_147_483_647 || typeof input.expectedProcessUuid !== "string" || !uuid.test(input.expectedProcessUuid))
    throw new ApprovalOperationalError("INVALID_PROCESS", "Actualiza la solicitud antes de consultar su firma.", 400);
  const expectedProcessUuid = input.expectedProcessUuid;
  await ensureFirmaSeguroSchema();
  await ensureApprovalOperationalSchema();
  // Determine the origin on the server. Credit row locks are held only in these
  // short transactions: the provider updater acquires its own credit row lock.
  const origin = await prisma.$transaction(async db => {
    await assertMoraActor(db, { ...actor, centralAdmin: false });
    await getOperationalCase(kind, id, db);
    return currentProcess(db, kind, id, expectedProcessUuid);
  }, { timeout: 20_000 });
  const lock = await tryAcquireSolicitudOperationLock(origin.lockDraftId);
  if (!lock) throw new ApprovalOperationalError("SIGNATURE_BUSY",
    "Hay una gestión de esta solicitud en curso. Intenta nuevamente en unos momentos.");
  try {
    const prepared = await prisma.$transaction(async db => {
      const verifiedActor = await assertMoraActor(db, { ...actor, centralAdmin: false });
      const item = await getOperationalCase(kind, id, db);
      if (item.signature.processUuid !== expectedProcessUuid)
        throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza la solicitud.");
      const current = await currentProcess(db, kind, id, expectedProcessUuid);
      if (current.lockDraftId !== origin.lockDraftId)
        throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza la solicitud.");
      await audit(db, kind, id, verifiedActor, "SIGNATURE_REFRESH_REQUESTED");
      return current;
    }, { timeout: 20_000 });
    try {
      await refreshFirmaSeguroProcess(prepared.process, { synchronizeContractState: false, providerTimeoutMs: 20_000 });
    } catch {
      await prisma.$transaction(async db => {
        const verifiedActor = await assertMoraActor(db, { ...actor, centralAdmin: false });
        await audit(db, kind, id, verifiedActor, "SIGNATURE_REFRESH_UNAVAILABLE");
      }, { timeout: 20_000 });
      throw new ApprovalOperationalError("SIGNATURE_PROVIDER_UNAVAILABLE",
        "No fue posible confirmar el estado con FirmaSeguro. No se creó ni se reenvió un documento. Intenta nuevamente en unos momentos.", 502);
    }
    return await prisma.$transaction(async db => {
      const verifiedActor = await assertMoraActor(db, { ...actor, centralAdmin: false });
      const current = await currentProcess(db, kind, id, expectedProcessUuid);
      if (current.lockDraftId !== origin.lockDraftId)
        throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza la solicitud.");
      const item = await getOperationalCase(kind, id, db);
      if (item.signature.processUuid !== expectedProcessUuid)
        throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza la solicitud.");
      await audit(db, kind, id, verifiedActor, `SIGNATURE_REFRESH_${item.signature.status}`);
      const message = item.signature.status === "SIGNED"
        ? "Firma verificada. El documento firmado ya está disponible."
        : item.signature.status === "PENDING"
          ? "FirmaSeguro confirmó que el mismo documento sigue pendiente de firma."
          : current.process.completedAt || isFirmaSeguroSuccessfulStatus(current.process.status)
            ? "FirmaSeguro reporta la firma completada, pero todavía no está disponible su PDF firmado. No se creó ni reenvió otra firma."
          : "Se consultó FirmaSeguro. El documento todavía requiere revisión técnica; no se creó ni reenvió otra firma.";
      return { item, message };
    }, { timeout: 20_000 });
  } finally {
    await lock.release();
  }
}
