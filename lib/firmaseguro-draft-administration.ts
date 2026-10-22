import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import schema from "@/lib/firmaseguro-draft-administration-schema.json";
import { DraftDispatchError, ensureDraftDispatchSchema, type DraftDispatchRow } from "@/lib/firmaseguro-draft-dispatch-ledger";
import { lockSolicitudOperationMutation } from "@/lib/firmaseguro-storage";
import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { resolveActivationFirstPaymentDate } from "@/lib/credit-factory";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { isVeriffRequired } from "@/lib/veriff";
import { ensureVeriffSchema, isVeriffApproved, type VeriffValidationRow } from "@/lib/veriff-storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMERCIAL_REASON = "Envío del contrato de la solicitud a FirmaSeguro";
let setup: Promise<void> | null = null;
export function ensureDraftAdministrativeRecoverySchema() {
  if (!setup) setup = (async () => {
    await ensureDraftDispatchSchema();
    await prisma.$transaction(async db => {
      await db.$queryRawUnsafe('SELECT 1::integer AS locked FROM pg_advisory_xact_lock(5843,20261022)');
      for (const statement of schema) await db.$executeRawUnsafe(statement);
    }, { timeout: 30000 });
  })().catch(error => { setup = null; throw error; });
  return setup;
}
function fail(code: string, message: string): never {
  throw new DraftDispatchError("DRAFT_ADMINISTRATIVE_" + code, message);
}

/** The route resolves and authorizes the real Central administrator.
 * This operation never contacts the provider and never sends a contract.
 * A portal review is an administrative decision, not proof of remote absence.
 */
export async function recoverUncertainDraftDispatch(input: {
  draftId: number; dispatchId: string; actor: { id: number; nombre: string };
  reason: string; providerReviewConfirmed: boolean; remoteOutcomeUnknownAccepted: boolean;
}) {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!Number.isSafeInteger(input.draftId) || input.draftId < 1 || !UUID.test(input.dispatchId)
    || !Number.isSafeInteger(input.actor?.id) || input.actor.id < 1 || !input.actor.nombre?.trim()
    || reason.length < 20 || reason.length > 500
    || input.providerReviewConfirmed !== true || input.remoteOutcomeUnknownAccepted !== true) {
    throw new DraftDispatchError("DRAFT_ADMINISTRATIVE_INVALID",
      "Confirma la revisión en FirmaSeguro, el resultado incierto y un motivo de 20 a 500 caracteres.", 400);
  }
  await ensureDraftAdministrativeRecoverySchema();
  const veriffRequired = getDataCreditoPublicConfig().enabled || isVeriffRequired();
  if (veriffRequired) await ensureVeriffSchema();
  return prisma.$transaction(async db => {
    await lockSolicitudOperationMutation(db, input.draftId);
    const previous = await db.$queryRawUnsafe<Array<{ replacementDispatchId: string; actorUserId: number; reason: string; status: string }>>(
      `SELECT permission."replacementDispatchId"::text,permission."actorUserId",permission."reason",dispatch."status"
       FROM "FirmaSeguroDraftAdministrativeRecovery" permission
       JOIN "FirmaSeguroDraftDispatch" dispatch ON dispatch."id"=permission."replacementDispatchId"
       WHERE permission."originalDispatchId"=$1::uuid AND permission."draftId"=$2`, input.dispatchId, input.draftId);
    if (previous[0]) {
      if (previous[0].actorUserId !== input.actor.id || previous[0].reason !== reason)
        fail("REPLAY_CONFLICT", "Esta recuperación ya fue autorizada por otra confirmación. Actualiza la solicitud.");
      return { replacementDispatchId: previous[0].replacementDispatchId, status: previous[0].status, idempotent: true };
    }
    const rows = await db.$queryRawUnsafe<Array<DraftDispatchRow & { fingerprint: string }>>(
      `SELECT d.*,md5((to_jsonb(d)-'status'-'updatedAt')::text) AS fingerprint
       FROM "FirmaSeguroDraftDispatch" d WHERE d."id"=$1::uuid AND d."draftId"=$2 FOR UPDATE`,
      input.dispatchId, input.draftId);
    const original = rows[0];
    if (!original) throw new DraftDispatchError("DRAFT_ADMINISTRATIVE_NOT_FOUND", "El envío no pertenece a esta solicitud.", 404);
    if (original.status !== "UNCERTAIN" || original.processUuid || original.expectedProcessUuid)
      fail("STATE", "Este envío no admite un reintento administrativo. Consulta o concilia el proceso existente.");
    const conflicts = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
      `SELECT EXISTS(SELECT 1 FROM "FirmaSeguroDraftDispatchReceipt" WHERE "dispatchId"=$1::uuid)
       OR EXISTS(SELECT 1 FROM "FirmaSeguroProcess" WHERE "draftId"=$2)
       OR EXISTS(SELECT 1 FROM "FirmaSeguroDraftAdministrativeRecovery" WHERE "draftId"=$2)
       OR EXISTS(SELECT 1 FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=$2 AND "id"<>$1::uuid
         AND "status" IN('PREPARING','DISPATCHING','UNCERTAIN','ABANDONED')) AS blocked`, input.dispatchId, input.draftId);
    if (conflicts[0]?.blocked !== false)
      fail("EVIDENCE_CHANGED", "El expediente ya tiene un proceso, comprobante u otra recuperación. Actualiza y revisa el caso.");
    const drafts = await db.$queryRawUnsafe<Array<{ payload: Record<string, unknown> }>>(
      `SELECT "payload" FROM "CreditoBorrador" WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
       AND "currentStep" IN(3,4) AND "payload"=$2::jsonb
       AND COALESCE("expiresAt","createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP FOR UPDATE`,
      input.draftId, JSON.stringify(original.updatedPayload));
    if (!drafts[0]) fail("DRAFT_CHANGED", "La solicitud venció o cambió. Revisa el contrato antes de recuperar el envío.");
    const payload = original.draftPayload && typeof original.draftPayload === "object"
      ? original.draftPayload as Record<string, unknown> : {};
    const seal = readFinancingTermsSeal(payload.financialTermsSeal);
    const document = Buffer.from(original.documentBase64, "base64");
    if (!seal || seal.snapshot.folio !== original.draftFolio
      || document.subarray(0,5).toString() !== "%PDF-"
      || createHash("sha256").update(document).digest("hex") !== original.documentHash
      || resolveActivationFirstPaymentDate({ frequency: seal.snapshot.frecuenciaPago, activatedAt: new Date() }).dateKey !== seal.snapshot.fechaPrimerPago)
      fail("CONTRACT_INVALID", "La integridad o la fecha del contrato reservado requiere revisión. No se cambió el contrato.");
    if (veriffRequired) {
      const validationId = Number(drafts[0].payload.veriffValidationId || 0);
      const validations = await db.$queryRawUnsafe<VeriffValidationRow[]>(
        `SELECT * FROM "VeriffIdentityValidation" WHERE "draftId"=$1 AND "creditoId" IS NULL ORDER BY "id" DESC LIMIT 1 FOR SHARE`, input.draftId);
      const validation = validations[0];
      const documentNumber = String(drafts[0].payload.clienteDocumento || "").replace(/\D/g,"");
      if (!validation || !Number.isSafeInteger(validationId) || validation.id !== validationId || !isVeriffApproved(validation)
        || !documentNumber || String(validation.clienteDocumento || "").replace(/\D/g,"") !== documentNumber)
        fail("IDENTITY_CHANGED", "La validación de identidad cambió. Revisa el expediente antes de recuperar el envío.");
    }
    const replacementDispatchId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "FirmaSeguroDraftAdministrativeRecovery"
       ("originalDispatchId","replacementDispatchId","draftId","actorUserId","actorName","reason",
        "providerReviewConfirmed","remoteOutcomeUnknownAccepted","originalFingerprint","documentHash","sealChecksum")
       VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,true,true,$7,$8,$9)`,
      original.id, replacementDispatchId, input.draftId, input.actor.id, input.actor.nombre.trim(),
      reason, original.fingerprint, original.documentHash, seal.checksum);
    await db.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch" SET "status"='ABANDONED',"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1::uuid AND "status"='UNCERTAIN'`, original.id);
    // Copy the frozen PDF and every contractual value verbatim. No autosave,
    // repricing, new folio, rebuilt PDF or create-full occurs in this transaction.
    await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroDraftDispatch"
     ("id","draftId","actorUserId","actorName","reason","expectedProcessUuid","status","draftFolio",
      "sourcePayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash")
     SELECT $2::uuid,"draftId",$3,$4,$5,NULL,'PREPARING',"draftFolio",
      "updatedPayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash"
     FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1::uuid`,
      original.id, replacementDispatchId, input.actor.id, input.actor.nombre.trim(), COMMERCIAL_REASON);
    return { replacementDispatchId, status: "PREPARING", idempotent: false };
  }, { timeout: 15000 });
}
