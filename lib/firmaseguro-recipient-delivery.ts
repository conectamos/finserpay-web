import "server-only";

import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import { firmaSeguroRecipientDeliverySchemaStatements } from "@/scripts/firmaseguro-recipient-delivery-schema.mjs";
import { FirmaSeguroApiError, firmaSeguroEditSignature, firmaSeguroResendSignature, firmaSeguroSignIn,
  isFirmaSeguroCompletedStatus } from "@/lib/firmaseguro";
import { isVerifiedPendingSignatureStatus } from "@/lib/approval-operations-core";
import { inspectPendingFirmaSeguroRecipient, FirmaSeguroRecipientProviderError } from "@/lib/firmaseguro-recipient-provider";
import { tryAcquireSolicitudOperationLock, type FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";
import { getUnresolvedDraftDispatch } from "@/lib/firmaseguro-draft-dispatch-ledger";

export type FirmaSeguroRecipientDeliveryStatus = "PREPARING" | "EDITING" | "RECIPIENT_UPDATED" | "RESENDING"
  | "RESENT" | "EDIT_UNCERTAIN" | "RESEND_FAILED" | "RESEND_UNCERTAIN" | "FAILED_SAFE";
type Contact = { phone: string; email: string | null };
export type FirmaSeguroRecipientDeliveryRow = {
  id: string; draftId: number; processUuid: string; signatureId: number;
  actorUserId: number; actorName: string; reason: string; intentSha256: string;
  beforeContact: Contact; afterContact: Contact; status: FirmaSeguroRecipientDeliveryStatus;
  lastError: string | null; createdAt: Date; updatedAt: Date; editedAt: Date | null; resentAt: Date | null;
};
export class FirmaSeguroRecipientDeliveryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = "FirmaSeguroRecipientDeliveryError";
  }
}
let setup: Promise<void> | null = null;
export function ensureFirmaSeguroRecipientDeliverySchema() {
  if (!setup) setup = prisma.$transaction(async db => {
    for (const sql of firmaSeguroRecipientDeliverySchemaStatements()) await db.$executeRawUnsafe(sql);
  }).catch(error => { setup = null; throw error; });
  return setup;
}
export async function getFirmaSeguroRecipientDelivery(id: string) {
  const rows = await prisma.$queryRawUnsafe<FirmaSeguroRecipientDeliveryRow[]>(
    `SELECT * FROM "FirmaSeguroRecipientDelivery" WHERE "id"=$1::uuid`, id);
  return rows[0] || null;
}
type Input = {
  id: string; draftId: number; processUuid: string; actor: { id: number; nombre: string }; reason: string;
  phone: string | null; email: string | null; hasPhone: boolean; hasEmail: boolean;
};
function intentHash(input: Input) {
  return createHash("sha256").update(JSON.stringify({ version: 2, draftId: input.draftId,
    processUuid: input.processUuid, actorId: input.actor.id, reason: input.reason,
    phone: { present: input.hasPhone, value: input.phone }, email: { present: input.hasEmail, value: input.email } })).digest("hex");
}
function assertReplay(row: FirmaSeguroRecipientDeliveryRow, input: Input) {
  if (row.actorUserId !== input.actor.id)
    throw new FirmaSeguroRecipientDeliveryError("IDEMPOTENCY_CONFLICT",
      `Esta operación fue registrada por ${row.actorName}. Debe retomarla el mismo usuario responsable.`);
  if (row.draftId !== input.draftId || row.processUuid !== input.processUuid
    || row.reason !== input.reason || row.intentSha256 !== intentHash(input))
    throw new FirmaSeguroRecipientDeliveryError("IDEMPOTENCY_CONFLICT", "Esta confirmación pertenece a otro reenvío de firma.");
}
export function publicFirmaSeguroRecipientDelivery(row: FirmaSeguroRecipientDeliveryRow) {
  const message = row.status === "RESENT" ? "El mismo documento fue reenviado al contacto actualizado. No se generó una nueva firma."
    : row.status === "RESEND_FAILED" ? "El contacto quedó actualizado en FirmaSeguro. El reenvío fue rechazado; puedes reintentar este mismo documento."
    : row.status === "RESEND_UNCERTAIN" || row.status === "RESENDING"
      ? "El contacto está actualizado, pero FirmaSeguro no confirmó el reenvío. Consulta su estado antes de repetirlo."
    : row.status === "EDIT_UNCERTAIN" || row.status === "EDITING"
      ? "FirmaSeguro no confirmó el cambio de contacto. Reintenta esta misma operación para verificarlo."
    : row.status === "FAILED_SAFE" ? "FirmaSeguro rechazó el cambio de contacto. El documento original se conservó."
    : "El contacto está preparado para reenviar el mismo documento.";
  return { id: row.id, status: row.status, message, processUuid: row.processUuid,
    sentPhone: row.editedAt ? row.afterContact.phone : undefined, sentEmail: row.editedAt ? row.afterContact.email : undefined,
    retryable: ["PREPARING", "RECIPIENT_UPDATED", "RESEND_FAILED", "EDIT_UNCERTAIN", "EDITING"].includes(row.status) };
}
function definitiveRejection(error: unknown) {
  return error instanceof FirmaSeguroApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
}
function failureSummary(error: unknown) {
  return error instanceof FirmaSeguroApiError ? `FirmaSeguro HTTP ${error.status}` : "FirmaSeguro sin confirmación de respuesta";
}
async function transition(id: string, from: FirmaSeguroRecipientDeliveryStatus[], status: FirmaSeguroRecipientDeliveryStatus,
  options: { edited?: boolean; resent?: boolean; error?: string | null } = {}) {
  const rows = await prisma.$queryRawUnsafe<FirmaSeguroRecipientDeliveryRow[]>(
    `UPDATE "FirmaSeguroRecipientDelivery" SET "status"=$2,"updatedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
      "editedAt"=CASE WHEN $3 THEN COALESCE("editedAt",CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ELSE "editedAt" END,
      "resentAt"=CASE WHEN $4 THEN COALESCE("resentAt",CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ELSE "resentAt" END,
      "lastError"=$5 WHERE "id"=$1::uuid AND "status"=ANY($6::text[]) RETURNING *`,
    id, status, options.edited === true, options.resent === true, options.error ?? null, from);
  return rows[0] || await getFirmaSeguroRecipientDelivery(id);
}
async function currentPendingProcess(draftId: number, processUuid: string) {
  const drafts = await prisma.$queryRawUnsafe<Array<{ id: number; estado: string; creditoId: number | null;
    currentStep: number; expiresAt: Date | null; createdAt: Date; platform: string }>>(
    `SELECT "id","estado","creditoId","currentStep","expiresAt","createdAt",
      COALESCE(NULLIF("plataforma",''),"payload"->>'plataformaDispositivo','') AS "platform"
      FROM "CreditoBorrador" WHERE "id"=$1`, draftId);
  const draft = drafts[0];
  if (!draft || draft.estado !== "ABIERTO" || draft.creditoId !== null || draft.currentStep < 3 || draft.currentStep > 4
    || (draft.expiresAt || new Date(new Date(draft.createdAt).getTime() + 15 * 86400000)) <= new Date())
    throw new FirmaSeguroRecipientDeliveryError("DRAFT_NOT_AVAILABLE", "La solicitud ya no está abierta para reenviar su firma.");
  if (draft.platform.toUpperCase() !== "IPHONE")
    throw new FirmaSeguroRecipientDeliveryError("IPHONE_REQUIRED", "Esta operación está disponible por ahora únicamente para iPhone.");
  if (await getUnresolvedDraftDispatch(draftId))
    throw new FirmaSeguroRecipientDeliveryError("SIGNATURE_PENDING", "Hay un envío de firma en curso o pendiente de conciliación.");
  const rows = await prisma.$queryRawUnsafe<Array<FirmaSeguroProcessRow & { activeCount: number }>>(
    `SELECT *,COUNT(*) OVER()::integer AS "activeCount" FROM "FirmaSeguroProcess"
      WHERE "draftId"=$1 AND "supersededAt" IS NULL ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, draftId);
  const process = rows[0];
  if (!process || process.activeCount !== 1 || process.processUuid !== processUuid || process.creditoId !== null)
    throw new FirmaSeguroRecipientDeliveryError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza el expediente.");
  if (process.completedAt || process.signedDocumentBase64 || isFirmaSeguroCompletedStatus(process.status))
    throw new FirmaSeguroRecipientDeliveryError("SIGNATURE_ALREADY_COMPLETED", "El cliente ya firmó. No se reenviará una firma completada.");
  if (!isVerifiedPendingSignatureStatus(process.status) || process.lastError)
    throw new FirmaSeguroRecipientDeliveryError("SIGNATURE_NOT_PENDING", "La firma ya no está pendiente. Actualiza su estado.");
  return process;
}

/** A delivery correction changes provider contact only; all contractual snapshots remain immutable. */
export async function deliverExistingFirmaSeguroSignature(input: Input) {
  await ensureFirmaSeguroRecipientDeliverySchema();
  let row = await getFirmaSeguroRecipientDelivery(input.id);
  if (row) {
    assertReplay(row, input);
    if (["RESENT", "FAILED_SAFE", "RESENDING", "RESEND_UNCERTAIN"].includes(row.status)) return publicFirmaSeguroRecipientDelivery(row);
  }
  const lock = await tryAcquireSolicitudOperationLock(input.draftId);
  if (!lock) throw new FirmaSeguroRecipientDeliveryError("SIGNATURE_BUSY", "Hay una gestión de esta solicitud en curso. Intenta de nuevo en unos momentos.");
  try {
    // Re-read after the exclusive session lock. No transaction reacquires this lock.
    row = await getFirmaSeguroRecipientDelivery(input.id);
    if (row) {
      assertReplay(row, input);
      if (["RESENT", "FAILED_SAFE", "RESENDING", "RESEND_UNCERTAIN"].includes(row.status)) return publicFirmaSeguroRecipientDelivery(row);
    }
    const process = await currentPendingProcess(input.draftId, input.processUuid);
    const { token } = await firmaSeguroSignIn();
    let recipient = await inspectPendingFirmaSeguroRecipient(token, process);
    if (row && recipient.signatureId !== row.signatureId)
      throw new FirmaSeguroRecipientDeliveryError("SIGNATURE_RECIPIENT_CHANGED", "El destinatario de FirmaSeguro cambió. Requiere revisión técnica.");
    if (!row) {
      const beforeContact: Contact = { phone: recipient.phone, email: recipient.email };
      const afterContact: Contact = { phone: input.hasPhone ? input.phone! : recipient.phone,
        email: input.hasEmail ? input.email : recipient.email };
      row = await prisma.$transaction(async db => {
        const previous = await db.$queryRawUnsafe<FirmaSeguroRecipientDeliveryRow[]>(
          `SELECT * FROM "FirmaSeguroRecipientDelivery" WHERE "id"=$1::uuid`, input.id);
        if (previous[0]) { assertReplay(previous[0], input); return previous[0]; }
        const active = await db.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "FirmaSeguroRecipientDelivery" WHERE "draftId"=$1 AND "processUuid"=$2
            AND "status" NOT IN ('RESENT','FAILED_SAFE') LIMIT 1`, input.draftId, input.processUuid);
        if (active.length) throw new FirmaSeguroRecipientDeliveryError("SIGNATURE_PENDING", "Hay un cambio de contacto pendiente. Retoma esa misma operación antes de iniciar otra.");
        const inserted = await db.$queryRawUnsafe<FirmaSeguroRecipientDeliveryRow[]>(
          `INSERT INTO "FirmaSeguroRecipientDelivery" ("id","draftId","processUuid","signatureId","actorUserId","actorName",
            "reason","intentSha256","beforeContact","afterContact","status")
            VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,'PREPARING') RETURNING *`,
          input.id, input.draftId, input.processUuid, recipient.signatureId, input.actor.id, input.actor.nombre,
          input.reason, intentHash(input), JSON.stringify(beforeContact), JSON.stringify(afterContact));
        return inserted[0];
      });
    }
    if (row.status === "EDITING" || row.status === "EDIT_UNCERTAIN") {
      // A lost PUT response is reconciled by reading the same provider signer.
      if (recipient.phone === row.afterContact.phone && (recipient.email || null) === row.afterContact.email)
        row = (await transition(row.id, ["EDITING", "EDIT_UNCERTAIN"], "RECIPIENT_UPDATED", { edited: true }))!;
      else if (recipient.phone === row.beforeContact.phone && (recipient.email || null) === row.beforeContact.email)
        row = (await transition(row.id, ["EDITING", "EDIT_UNCERTAIN"], "PREPARING"))!;
      else throw new FirmaSeguroRecipientDeliveryError("SIGNATURE_RECIPIENT_CHANGED", "El contacto en FirmaSeguro cambió durante la operación. Requiere revisión técnica.");
    }
    if (row.status === "PREPARING") {
      if (recipient.phone === row.afterContact.phone && (recipient.email || null) === row.afterContact.email) {
        row = (await transition(row.id, ["PREPARING"], "RECIPIENT_UPDATED", { edited: true }))!;
      } else {
        row = (await transition(row.id, ["PREPARING"], "EDITING"))!;
        try {
          await firmaSeguroEditSignature(token, { ...recipient.editPayload, contact_information: {
            ...recipient.editPayload.contact_information, mobile_number: row.afterContact.phone,
            email: row.afterContact.email || recipient.editPayload.contact_information.email,
          } });
        } catch (error) {
          row = (await transition(row.id, ["EDITING"], definitiveRejection(error) ? "FAILED_SAFE" : "EDIT_UNCERTAIN",
            { error: failureSummary(error) }))!;
          return publicFirmaSeguroRecipientDelivery(row);
        }
        row = (await transition(row.id, ["EDITING"], "RECIPIENT_UPDATED", { edited: true }))!;
      }
    }
    if (row.status === "RECIPIENT_UPDATED" || row.status === "RESEND_FAILED") {
      // Never resend to an unverified contact or a signer who completed meanwhile.
      recipient = await inspectPendingFirmaSeguroRecipient(token, await currentPendingProcess(input.draftId, input.processUuid));
      if (recipient.signatureId !== row.signatureId || recipient.phone !== row.afterContact.phone
        || (recipient.email || null) !== row.afterContact.email)
        throw new FirmaSeguroRecipientDeliveryError("SIGNATURE_RECIPIENT_CHANGED", "FirmaSeguro no confirmó el nuevo contacto. Revisa el expediente antes de reenviar.");
      row = (await transition(row.id, ["RECIPIENT_UPDATED", "RESEND_FAILED"], "RESENDING"))!;
      try {
        await firmaSeguroResendSignature(token, row.signatureId);
      } catch (error) {
        row = (await transition(row.id, ["RESENDING"], definitiveRejection(error) ? "RESEND_FAILED" : "RESEND_UNCERTAIN",
          { error: failureSummary(error) }))!;
        return publicFirmaSeguroRecipientDelivery(row);
      }
      row = (await transition(row.id, ["RESENDING"], "RESENT", { resent: true }))!;
    }
    return publicFirmaSeguroRecipientDelivery(row);
  } catch (error) {
    if (error instanceof FirmaSeguroRecipientProviderError)
      throw new FirmaSeguroRecipientDeliveryError(error.code, error.message, error.status);
    if (error instanceof FirmaSeguroApiError)
      throw new FirmaSeguroRecipientDeliveryError("SIGNATURE_REFRESH_FAILED", "No se pudo verificar el destinatario vigente con FirmaSeguro. Intenta actualizar el expediente.", 502);
    throw error;
  } finally { await lock.release(); }
}
