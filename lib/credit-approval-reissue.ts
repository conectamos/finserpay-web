import "server-only";
import { assertApprovalActorActive, approvalActorAudit } from "@/lib/credit-approval-actor";
import prisma from "@/lib/prisma";
import type { ApprovalActor } from "@/lib/credit-approval";
import { CreditApprovalError, approvalPdf } from "@/lib/credit-approval";
import { buildFirmaSeguroCreditPdf } from "@/lib/firmaseguro-folio-pdf";
import { prepareFirmaSeguroReissue, refreshFirmaSeguroProcess } from "@/lib/firmaseguro-credit";
import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";
import { frozenReissueCredit, reissueHash, reissueRecord } from "@/lib/credit-approval-reissue-source";
import { getCreditApprovalReissueState, type ReissueDatabase, type CreditApprovalReissueStatus } from "@/lib/credit-approval-reissue-state";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";
import { isFirmaSeguroCompletedStatus } from "@/lib/firmaseguro";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RequestInput = { idempotencyKey: string; expectedProcessUuid: string; expectedRevision: number; reason: string };
type Operation = {
  id: string; creditoId: number; previousProcessUuid: string; sourceRevision: number; reason: string;
  requestedByUserId: number | null; requestedByKind: "USER" | "SHARED_LINK"; requestedByGrantId: string | null; requestedBySessionId: string | null; status: CreditApprovalReissueStatus; frozenCredit: CreditForFirmaSeguroPdf;
  originalContractSnapshot: unknown; originalSignedDocumentBase64: string; originalDocumentHash: string;
  sourceTermsHash: string; documentBase64: string | null; documentHash: string | null;
  newProcessUuid: string | null; requestedAt: Date; updatedAt: Date;
};
type Credit = Record<string, unknown> & { id: number; folio: string; eligible: boolean; paid: boolean; contratoSnapshot: unknown };
function invalid() { return new CreditApprovalError("INVALID_REISSUE", "Actualiza el expediente y confirma el motivo de la nueva firma."); }
export function parseCreditApprovalReissue(value: unknown): ({ action: "REQUEST" } & RequestInput) | { action: "REFRESH"; operationId: string } {
  const body = reissueRecord(value);
  if (body.action === "REFRESH" && Object.keys(body).sort().join(",") === "action,operationId"
    && typeof body.operationId === "string" && uuidPattern.test(body.operationId)) return { action: "REFRESH", operationId: body.operationId };
  if (body.action !== "REQUEST" || Object.keys(body).sort().join(",") !== "action,expectedProcessUuid,expectedRevision,idempotencyKey,reason"
    || typeof body.idempotencyKey !== "string" || !uuidPattern.test(body.idempotencyKey)
    || typeof body.expectedProcessUuid !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(body.expectedProcessUuid)
    || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1
    || typeof body.reason !== "string") throw invalid();
  const reason = body.reason.trim().replace(/\s+/g, " ");
  if (reason.length < 5 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) throw invalid();
  return { action: "REQUEST", idempotencyKey: body.idempotencyKey,
    expectedProcessUuid: body.expectedProcessUuid, expectedRevision: Number(body.expectedRevision), reason };
}
async function readCredit(db: ReissueDatabase, id: number, lock = false) {
  const rows = await db.$queryRawUnsafe<Credit[]>(`SELECT credit."id", credit."folio",
    credit."clienteNombre", credit."clienteDocumento", credit."clienteTelefono", credit."clienteCorreo", credit."clienteDireccion",
    credit."imei", credit."equipoMarca", credit."equipoModelo", credit."valorEquipoTotal", credit."cuotaInicial",
    credit."saldoBaseFinanciado", credit."montoCredito", credit."valorCuota", credit."plazoMeses",
    credit."tasaInteresEa", credit."frecuenciaPago", credit."contratoSnapshot",
    EXISTS (SELECT 1 FROM "CreditApprovalPolicy" policy WHERE policy."id"=1 AND credit."createdAt">=policy."activatedAt"
      AND NOT (COALESCE(credit."equalityService",'')='IMPORTACION_MASIVA'
        AND COALESCE(credit."contratoSnapshot" #>> '{origen,tipo}','')='IMPORTACION_MASIVA'))
      AND UPPER(BTRIM(credit."estado")) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA') AS eligible,
    EXISTS (SELECT 1 FROM "LiquidacionAliadoCredito" WHERE "creditoId"=credit."id") AS paid
    FROM "Credito" credit JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    WHERE credit."id"=$1 AND UPPER(BTRIM(ally."codigo"))<>'FINSERPAY'${lock ? " FOR UPDATE OF credit" : ""}`, id);
  if (!rows[0]) throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
  if (!rows[0].eligible || rows[0].paid) throw new CreditApprovalError("REISSUE_NOT_ALLOWED", "Este crédito no admite una nueva solicitud de firma.", 409);
  return rows[0];
}
async function lockReview(db: ReissueDatabase, id: number) {
  const rows = await db.$queryRawUnsafe<Array<{ revision: number }>>(`SELECT "revision" FROM "CreditApprovalReview" WHERE "creditoId"=$1 FOR UPDATE`, id);
  if (!rows[0]) throw new CreditApprovalError("REVIEW_UNAVAILABLE", "El crédito no tiene una revisión activa.", 409);
  return rows[0];
}
async function readOperation(db: ReissueDatabase, operationId: string) {
  const rows = await db.$queryRawUnsafe<Operation[]>(`SELECT * FROM "CreditApprovalReissue" WHERE "id"=$1::uuid`, operationId);
  return rows[0] || null;
}
async function currentProcess(db: ReissueDatabase, id: number) {
  const rows = await db.$queryRawUnsafe<Array<FirmaSeguroProcessRow & { activeCount: number }>>(`SELECT *, COUNT(*) OVER()::integer AS "activeCount" FROM "FirmaSeguroProcess"
    WHERE "creditoId"=$1 AND "supersededAt" IS NULL ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, id);
  if (rows[0] && rows[0].activeCount !== 1) throw new CreditApprovalError("SIGNATURE_VERSION_AMBIGUOUS", "Hay varias firmas vigentes. Solicita revisión al administrador central.", 409);
  return rows[0] || null;
}
export async function requestCreditApprovalReissue(creditoId: number, input: RequestInput, actor: ApprovalActor) {
  const audit = approvalActorAudit(actor);
  const reserved = await prisma.$transaction(async (db) => {
    await assertApprovalActorActive(db, actor);
    const credit = await readCredit(db, creditoId, true);
    const review = await lockReview(db, creditoId);
    const previousRequest = await readOperation(db, input.idempotencyKey);
    if (previousRequest) {
      if (previousRequest.creditoId !== creditoId || previousRequest.previousProcessUuid !== input.expectedProcessUuid
        || previousRequest.sourceRevision !== input.expectedRevision || previousRequest.reason !== input.reason
        || previousRequest.requestedByUserId !== audit.actorUserId
        || previousRequest.requestedByKind !== audit.actorKind || previousRequest.requestedByGrantId !== audit.actorGrantId || previousRequest.requestedBySessionId !== audit.actorSessionId) throw new CreditApprovalError("REISSUE_KEY_CONFLICT", "La confirmación corresponde a otra solicitud.", 409);
      return { operation: previousRequest, dispatch: false, original: null };
    }
    if ((await getCreditApprovalReissueState(db, creditoId)).blocked) throw new CreditApprovalError("REISSUE_PENDING", "Ya existe una solicitud de firma pendiente.", 409);
    const current = await currentProcess(db, creditoId);
    if (review.revision !== input.expectedRevision || !current || current.processUuid !== input.expectedProcessUuid) {
      throw new CreditApprovalError("REVIEW_CHANGED", "La firma o la revisión cambió. Actualiza el expediente.", 409);
    }
    const originalPdf = approvalPdf(current.signedDocumentBase64);
    if (!originalPdf || originalPdf.length > 32 * 1024 * 1024 || !(current.completedAt || isFirmaSeguroCompletedStatus(current.status))) {
      throw new CreditApprovalError("SIGNED_DOCUMENT_REQUIRED", "Se necesita el documento firmado vigente antes de solicitar otra firma.", 409);
    }
    let source: ReturnType<typeof frozenReissueCredit>;
    try { source = frozenReissueCredit(credit, current); }
    catch { throw new CreditApprovalError("FROZEN_TERMS_UNAVAILABLE", "No se pudo comprobar el contrato original y sus términos. Solicita revisión al administrador central.", 409); }
    const prior = await db.$queryRawUnsafe<Operation[]>(`SELECT * FROM "CreditApprovalReissue"
      WHERE "creditoId"=$1 AND "newProcessUuid"=$2 AND "status"='COMPLETED' LIMIT 1`, creditoId, current.processUuid);
    let cachedPdf: string | null = null;
    if (prior[0]) {
      if (prior[0].sourceTermsHash !== source.termsHash || !prior[0].documentBase64
        || reissueHash(Buffer.from(prior[0].documentBase64, "base64")) !== prior[0].documentHash) throw new CreditApprovalError("SOURCE_CHANGED", "La versión documental no pudo verificarse.", 409);
      source = { credit: prior[0].frozenCredit, termsHash: prior[0].sourceTermsHash };
      cachedPdf = prior[0].documentBase64;
    }
    await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalReissue"
      ("id","creditoId","previousProcessUuid","sourceRevision","reason","requestedByUserId","requestedByName",
       "frozenCredit","originalContractSnapshot","originalSignedDocumentBase64","originalDocumentHash","sourceTermsHash","requestedByKind","requestedByGrantId","requestedBySessionId","status")
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14::uuid,$15::uuid,'PREPARING')`,
      input.idempotencyKey, creditoId, current.processUuid, review.revision, input.reason, audit.actorUserId, audit.actorName,
      JSON.stringify(source.credit), JSON.stringify(credit.contratoSnapshot), current.signedDocumentBase64, reissueHash(originalPdf), source.termsHash, audit.actorKind, audit.actorGrantId, audit.actorSessionId);
    return { operation: (await readOperation(db, input.idempotencyKey))!, dispatch: true, original: { process: current, cachedPdf } };
  }, { timeout: 15000 });
  if (!reserved.dispatch || !reserved.original) return getCreditApprovalReissueState(prisma, creditoId);

  let dispatched = false;
  try {
    const document = reserved.original.cachedPdf ? Buffer.from(reserved.original.cachedPdf, "base64")
      : await buildFirmaSeguroCreditPdf(reserved.operation.frozenCredit);
    if (document.length > 32 * 1024 * 1024 || document.subarray(0,5).toString() !== "%PDF-") throw new Error("INVALID_SOURCE_PDF");
    const prepared = await prepareFirmaSeguroReissue(reserved.operation.frozenCredit, document, reserved.operation.id);
    const claimed = await prisma.$transaction(async (db) => {
      await assertApprovalActorActive(db, actor);
      await readCredit(db, creditoId, true);
      await lockReview(db, creditoId);
      const current = await currentProcess(db, creditoId);
      if (current?.processUuid !== reserved.operation.previousProcessUuid) throw new Error("REISSUE_SOURCE_CHANGED");
      return db.$executeRawUnsafe(`UPDATE "CreditApprovalReissue" SET "status"='DISPATCHING',
        "documentBase64"=$2,"documentHash"=$3,"requestPayload"=$4::jsonb,
        "dispatchedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE "id"=$1::uuid AND "status"='PREPARING'`,
        reserved.operation.id, document.toString("base64"), reissueHash(document), JSON.stringify(prepared.requestPayload));
    }, { timeout: 15000 });
    if (claimed !== 1) return getCreditApprovalReissueState(prisma, creditoId);
    dispatched = true;
    const sent = await prepared.sendOnce();
    await prisma.$transaction(async (db) => {
      await readCredit(db, creditoId, true);
      await lockReview(db, creditoId);
      const operation = await readOperation(db, reserved.operation.id);
      const current = await currentProcess(db, creditoId);
      if (!operation || !["DISPATCHING","UNCERTAIN"].includes(operation.status)
        || current?.processUuid !== operation.previousProcessUuid) throw new Error("REISSUE_BINDING_CHANGED");
      await db.$executeRawUnsafe(`UPDATE "FirmaSeguroProcess" SET "supersededAt"=CURRENT_TIMESTAMP,
        "supersededByUserId"=$3,"supersededReason"=$4 WHERE "creditoId"=$1 AND "processUuid"=$2 AND "supersededAt" IS NULL`,
        creditoId, operation.previousProcessUuid, actor.id, operation.reason);
      await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroProcess"
        ("creditoId","draftId","draftFolio","draftPayload","processUuid","status","requestPayload","createPayload","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8::jsonb,CURRENT_TIMESTAMP AT TIME ZONE 'UTC',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
        creditoId, reserved.original!.process.draftId, reserved.operation.frozenCredit.folio,
        JSON.stringify(reserved.original!.process.draftPayload), sent.processUuid, sent.status,
        JSON.stringify(prepared.requestPayload), JSON.stringify(sent.createPayload));
      if ((await currentProcess(db, creditoId))?.processUuid !== sent.processUuid) throw new Error("REISSUE_ACTIVE_PROCESS_MISMATCH");
      await db.$executeRawUnsafe(`UPDATE "CreditApprovalReissue" SET "status"='AWAITING_SIGNATURE',
        "newProcessUuid"=$2,"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id"=$1::uuid`, operation.id, sent.processUuid);
    }, { timeout: 15000 });
  } catch {
    await prisma.$transaction(async (db) => {
      await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`, creditoId);
      await lockReview(db, creditoId);
      await db.$executeRawUnsafe(`UPDATE "CreditApprovalReissue" SET "status"=$2,"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE "id"=$1::uuid AND "status"=$3`, reserved.operation.id, dispatched ? "UNCERTAIN" : "FAILED_SAFE", dispatched ? "DISPATCHING" : "PREPARING");
    });
  }
  return getCreditApprovalReissueState(prisma, creditoId);
}
export async function refreshCreditApprovalReissue(creditoId: number, operationId: string) {
  const process = await prisma.$transaction(async (db) => {
    await readCredit(db, creditoId, true);
    await lockReview(db, creditoId);
    const operation = await readOperation(db, operationId);
    if (!operation || operation.creditoId !== creditoId) throw new CreditApprovalError("REISSUE_NOT_FOUND", "Solicitud de firma no encontrada.", 404);
    if (["PREPARING","DISPATCHING"].includes(operation.status) && Date.now() - new Date(operation.updatedAt).getTime() > 120000) {
      await db.$executeRawUnsafe(`UPDATE "CreditApprovalReissue" SET "status"=$2,"lastCheckedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
        "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id"=$1::uuid AND "status"=$3`,
        operation.id, operation.status === "PREPARING" ? "FAILED_SAFE" : "UNCERTAIN", operation.status);
      return null;
    }
    if (!operation.newProcessUuid || operation.status === "COMPLETED") return null;
    const current = await currentProcess(db, creditoId);
    if (!current || current.processUuid !== operation.newProcessUuid) throw new CreditApprovalError("REISSUE_CHANGED", "La firma vigente cambió. Actualiza el expediente.", 409);
    await db.$executeRawUnsafe(`UPDATE "CreditApprovalReissue" SET "lastCheckedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id"=$1::uuid`, operation.id);
    return current;
  });
  if (process) {
    try { await refreshFirmaSeguroProcess(process); }
    catch { throw new CreditApprovalError("SIGNATURE_REFRESH_UNAVAILABLE", "No se pudo consultar la nueva firma. La liquidación continúa bloqueada.", 503); }
  }
  return getCreditApprovalReissueState(prisma, creditoId);
}
