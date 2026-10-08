import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ensureApprovalOperationalSchema } from "@/lib/approval-operations-schema";
import { ensureFirmaSeguroSchema, lockSolicitudOperationMutation } from "@/lib/firmaseguro-storage";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
import { ensureVeriffSchema, lockVeriffDraftAttempts } from "@/lib/veriff-storage";
import {
  applyRequestDataCorrection, correctionRecord, requestDataEligibility, requestDataRevision,
  requestDataValues, RequestDataCorrectionError, type RequestDataCorrectionInput,
} from "@/lib/approval-request-correction-core";

type Database = Prisma.TransactionClient;
type Actor = { id: number; nombre: string };
type Draft = {
  id: number; estado: string; creditoId: number | null; expired: boolean;
  clienteNombre: string | null; clienteTelefono: string | null; clienteDocumento: string | null; payload: unknown;
};

export function parseCorrectionDraftId(value: string) {
  const match = /^D-([1-9]\d*)$/.exec(value);
  const id = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new RequestDataCorrectionError("REQUEST_NOT_FOUND", "Solicitud no disponible.", 404);
  return id;
}

async function readDraft(db: Database, id: number, lock = false) {
  const rows = await db.$queryRawUnsafe<Draft[]>(`SELECT "id", "estado", "creditoId",
    "clienteNombre", "clienteTelefono", "clienteDocumento", "payload",
    COALESCE("expiresAt", "createdAt" + INTERVAL '15 days') <= CURRENT_TIMESTAMP AS "expired"
    FROM "CreditoBorrador" WHERE "id"=$1 LIMIT 1${lock ? " FOR UPDATE" : ""}`, id);
  if (!rows[0]) throw new RequestDataCorrectionError("REQUEST_NOT_FOUND", "Solicitud no disponible.", 404);
  const row = rows[0];
  const payload = { ...correctionRecord(row.payload),
    clienteDocumento: row.clienteDocumento ?? correctionRecord(row.payload).clienteDocumento,
    clienteTelefono: row.clienteTelefono ?? correctionRecord(row.payload).clienteTelefono,
    clienteNombre: row.clienteNombre ?? correctionRecord(row.payload).clienteNombre };
  return { row, payload };
}

async function readEligibility(db: Database, id: number, row: Draft, payload: Record<string, unknown>) {
  const rows = await db.$queryRawUnsafe<Array<{
    signatureStarted: boolean; identityStarted: boolean; dispatchTablePresent: boolean; expectedProcessUuid: string | null;
  }>>(`SELECT EXISTS(SELECT 1 FROM "FirmaSeguroProcess" WHERE "draftId"=$1) AS "signatureStarted",
    EXISTS(SELECT 1 FROM "VeriffIdentityValidation" WHERE "draftId"=$1) AS "identityStarted",
    to_regclass('public."FirmaSeguroDraftDispatch"') IS NOT NULL AS "dispatchTablePresent",
    (SELECT "processUuid" FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "creditoId" IS NULL
      AND "supersededAt" IS NULL ORDER BY "createdAt" DESC,"id" DESC LIMIT 1) AS "expectedProcessUuid"`, id);
  const state = rows[0];
  const signatureStarted = state?.signatureStarted === true;
  let dispatchPending = false;
  if (state?.dispatchTablePresent) {
    const dispatches = await db.$queryRawUnsafe<Array<{ started: boolean }>>(`SELECT EXISTS(
      SELECT 1 FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=$1
        AND "status" IN ('PREPARING','DISPATCHING','UNCERTAIN')) AS "started"`, id);
    dispatchPending = dispatches[0]?.started === true;
  }
  const eligibility = requestDataEligibility({ open: row.estado === "ABIERTO" && row.creditoId === null,
    expired: row.expired, signatureStarted, dispatchPending, identityStarted: state?.identityStarted === true,
    correctionPending: payload.firmaSeguroCorrectionPending === true ||
      payload.firmaSeguroIdentityCorrectionPending === true || payload.firmaSeguroFinancialCorrectionPending === true ||
      payload.firmaSeguroContactCorrectionPending === true });
  if (!eligibility.reason && signatureStarted && !state?.expectedProcessUuid)
    return { ...eligibility, editableFields: [], requiresNewSignature: false,
      reason: "No hay una firma vigente verificable. Revisa la corrección desde Gestionar firma.", expectedProcessUuid: null };
  return { ...eligibility, expectedProcessUuid: state?.expectedProcessUuid || null };
}

async function ensureReadSchemas() {
  await Promise.all([ensureSolicitudSchema(), ensureFirmaSeguroSchema(), ensureVeriffSchema()]);
}

export async function getAnalystRequestCorrection(id: number) {
  await ensureReadSchemas();
  return prisma.$transaction(async (db) => {
    const { row, payload } = await readDraft(db, id);
    const eligibility = await readEligibility(db, id, row, payload);
    return { values: requestDataValues(payload), revision: requestDataRevision(payload), ...eligibility };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}

/** Same operation lock used by advisor autosaves and FirmaSeguro dispatch reservations. */
export async function correctAnalystRequestData(id: number, input: RequestDataCorrectionInput, actor: Actor) {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !actor.nombre.trim())
    throw new RequestDataCorrectionError("UNAUTHORIZED", "Inicia sesión con tu cuenta de analista.", 401);
  await ensureReadSchemas();
  await ensureApprovalOperationalSchema();
  if (input.idempotencyKey || (await getAnalystRequestCorrection(id)).requiresNewSignature) {
    const { correctAndReissueAnalystRequestData } = await import("@/lib/approval-request-client-signature-correction");
    return correctAndReissueAnalystRequestData(id, input, actor);
  }
  return prisma.$transaction(async (db) => {
    await lockSolicitudOperationMutation(db, id);
    await lockVeriffDraftAttempts(db, id);
    const { row, payload } = await readDraft(db, id, true);
    const eligibility = await readEligibility(db, id, row, payload);
    if (!eligibility.editableFields.length)
      throw new RequestDataCorrectionError("REQUEST_LOCKED", eligibility.reason || "La solicitud no permite esta corrección.");
    if (eligibility.requiresNewSignature)
      throw new RequestDataCorrectionError("REQUEST_CHANGED", "Se inició una firma. Actualiza los datos para confirmar su nueva versión.");
    const correction = applyRequestDataCorrection(payload, input, eligibility.editableFields, actor.nombre,
      new Date(), { preserveIdentityEvidence: true });
    await db.$executeRawUnsafe(`UPDATE "CreditoBorrador" SET "payload"=$2::jsonb,
      "clienteNombre"=$3, "clienteTelefono"=$4, "updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL`, id,
      JSON.stringify(correction.payload), String(correction.payload.clienteNombre || "") || null,
      String(correction.payload.clienteTelefono || "") || null);
    await db.$executeRawUnsafe(`INSERT INTO "ApprovalOperationalAction"
      ("id","targetKind","targetId","eventType","actorUserId","actorName","reason","beforeContact","afterContact","status")
      VALUES ($1::uuid,'DRAFT',$2,'CONTACT_UPDATED',$3,$4,$5,$6::jsonb,$7::jsonb,'DATA_CORRECTED')`,
      randomUUID(), id, actor.id, actor.nombre, input.reason,
      JSON.stringify({ ...correction.before, analystDataRevision: requestDataRevision(payload) }),
      JSON.stringify({ ...correction.after, analystDataRevision: correction.revision }));
    return { values: requestDataValues(correction.payload), revision: correction.revision, ...eligibility,
      correction: correction.payload.analystDataCorrection };
  }, { isolationLevel: "ReadCommitted", timeout: 20_000 });
}
