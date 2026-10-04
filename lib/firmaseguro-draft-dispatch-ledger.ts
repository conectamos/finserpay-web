import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { prepareFirmaSeguroReissue } from "@/lib/firmaseguro-credit";
import { isFirmaSeguroCompletedStatus } from "@/lib/firmaseguro";
import { isFirmaSeguroFailedStatus } from "@/lib/firmaseguro-status";
import { ensureFirmaSeguroSchema, lockSolicitudOperationMutation,
  markFirmaSeguroDraftProcessesSuperseded, type FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { isVeriffRequired } from "@/lib/veriff";
import { ensureVeriffSchema, isVeriffApproved, type VeriffValidationRow } from "@/lib/veriff-storage";
import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { resolveActivationFirstPaymentDate } from "@/lib/credit-factory";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type DispatchStatus = "PREPARING" | "DISPATCHING" | "AWAITING_SIGNATURE" | "FAILED_SAFE" | "UNCERTAIN";
export type DraftDispatchRow = {
  id: string; draftId: number; actorUserId: number; actorName: string; reason: string;
  expectedProcessUuid: string | null; processUuid: string | null; status: DispatchStatus;
  draftFolio: string; sourcePayload: unknown; updatedPayload: unknown; draftPayload: unknown;
  frozenCredit: CreditForFirmaSeguroPdf; documentBase64: string; documentHash: string;
  requestPayload: unknown; lastError: string | null;
};

export class DraftDispatchError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "DraftDispatchError";
  }
}

function hash(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown) { return JSON.stringify(value); }

let setup: Promise<void> | null = null;
export function ensureDraftDispatchSchema() {
  if (!setup) setup = (async () => {
    await ensureFirmaSeguroSchema();
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "FirmaSeguroDraftDispatch" (
      "id" UUID PRIMARY KEY,
      "draftId" INTEGER NOT NULL REFERENCES "CreditoBorrador"("id") ON DELETE RESTRICT,
      "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" TEXT NOT NULL,
      "reason" TEXT NOT NULL CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500),
      "expectedProcessUuid" TEXT,
      "processUuid" TEXT UNIQUE,
      "status" TEXT NOT NULL CHECK ("status" IN
        ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','FAILED_SAFE','UNCERTAIN')),
      "draftFolio" TEXT NOT NULL,
      "sourcePayload" JSONB NOT NULL,
      "updatedPayload" JSONB NOT NULL,
      "draftPayload" JSONB NOT NULL,
      "frozenCredit" JSONB NOT NULL,
      "documentBase64" TEXT NOT NULL,
      "documentHash" CHAR(64) NOT NULL CHECK ("documentHash" ~ '^[a-f0-9]{64}$'),
      "requestPayload" JSONB,
      "lastError" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "dispatchedAt" TIMESTAMP(3),
      "acknowledgedAt" TIMESTAMP(3),
      CONSTRAINT "FirmaSeguroDraftDispatch_process_check" CHECK
        ("status" <> 'AWAITING_SIGNATURE' OR "processUuid" IS NOT NULL)
    )`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "FirmaSeguroDraftDispatch_one_unresolved"
      ON "FirmaSeguroDraftDispatch"("draftId")
      WHERE "status" IN ('PREPARING','DISPATCHING','UNCERTAIN')`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "FirmaSeguroDraftDispatch_draft_created"
      ON "FirmaSeguroDraftDispatch"("draftId","createdAt" DESC,"id" DESC)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "FirmaSeguroDraftDispatchEvent" (
      "id" BIGSERIAL PRIMARY KEY,
      "dispatchId" UUID NOT NULL REFERENCES "FirmaSeguroDraftDispatch"("id") ON DELETE RESTRICT,
      "previousStatus" TEXT,
      "status" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP='INSERT' THEN
          INSERT INTO "FirmaSeguroDraftDispatchEvent"("dispatchId","status") VALUES (NEW."id",NEW."status");
        ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
          INSERT INTO "FirmaSeguroDraftDispatchEvent"("dispatchId","previousStatus","status")
          VALUES (NEW."id",OLD."status",NEW."status");
        END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatch_audit"
      AFTER INSERT OR UPDATE ON "FirmaSeguroDraftDispatch"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_audit()`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_preserve()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'DRAFT_DISPATCH_IMMUTABLE' USING ERRCODE='23514';
        END IF;
        IF ROW(NEW."draftId",NEW."actorUserId",NEW."actorName",NEW."reason",
          NEW."expectedProcessUuid",NEW."draftFolio",NEW."sourcePayload",NEW."updatedPayload",
          NEW."draftPayload",NEW."frozenCredit",NEW."documentBase64",NEW."documentHash")
          IS DISTINCT FROM ROW(OLD."draftId",OLD."actorUserId",OLD."actorName",OLD."reason",
          OLD."expectedProcessUuid",OLD."draftFolio",OLD."sourcePayload",OLD."updatedPayload",
          OLD."draftPayload",OLD."frozenCredit",OLD."documentBase64",OLD."documentHash")
          OR (OLD."processUuid" IS NOT NULL AND NEW."processUuid" IS DISTINCT FROM OLD."processUuid")
          OR (OLD."requestPayload" IS NOT NULL AND NEW."requestPayload" IS DISTINCT FROM OLD."requestPayload")
          OR (OLD."dispatchedAt" IS NOT NULL AND NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt")
          OR (OLD."acknowledgedAt" IS NOT NULL AND NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt")
        THEN RAISE EXCEPTION 'DRAFT_DISPATCH_IMMUTABLE' USING ERRCODE='23514'; END IF;
        IF (OLD."status"='PREPARING' AND NEW."status" NOT IN ('PREPARING','DISPATCHING','FAILED_SAFE'))
          OR (OLD."status"='DISPATCHING' AND NEW."status" NOT IN ('DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN'))
          OR (OLD."status" IN ('AWAITING_SIGNATURE','FAILED_SAFE','UNCERTAIN')
            AND NEW."status" IS DISTINCT FROM OLD."status")
        THEN RAISE EXCEPTION 'DRAFT_DISPATCH_STATUS_INVALID' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatch_preserve"
      BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatch"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_preserve()`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_event_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'DRAFT_DISPATCH_AUDIT_IMMUTABLE' USING ERRCODE='23514';
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatchEvent_immutable"
      BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatchEvent"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_event_immutable()`);
  })().catch((error) => { setup = null; throw error; });
  return setup;
}

export async function getDraftDispatch(id: string) {
  if (!UUID.test(id)) return null;
  const exists = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('public."FirmaSeguroDraftDispatch"') IS NOT NULL AS "present"`);
  if (!exists[0]?.present) return null;
  const rows = await prisma.$queryRawUnsafe<DraftDispatchRow[]>(
    `SELECT * FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1::uuid`, id);
  return rows[0] || null;
}

export async function getUnresolvedDraftDispatch(
  draftId: number,
  database: typeof prisma | Prisma.TransactionClient = prisma
) {
  const exists = await database.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('public."FirmaSeguroDraftDispatch"') IS NOT NULL AS "present"`);
  if (!exists[0]?.present) return null;
  const rows = await database.$queryRawUnsafe<DraftDispatchRow[]>(
    `SELECT * FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=$1
      AND "status" IN ('PREPARING','DISPATCHING','UNCERTAIN')
      ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, draftId);
  return rows[0] || null;
}

export async function reserveDraftDispatch(input: {
  id: string; draftId: number; actor: { id: number; nombre: string }; reason: string;
  expectedProcessUuid: string | null; sourcePayload: unknown; updatedPayload: unknown;
  draftPayload: unknown; draftFolio: string; frozenCredit: CreditForFirmaSeguroPdf;
  document: Buffer; supersedeActive: boolean;
}) {
  if (!UUID.test(input.id) || !Number.isSafeInteger(input.draftId) || input.draftId < 1
    || !Number.isSafeInteger(input.actor.id) || input.actor.id < 1
    || input.reason.trim().length < 5 || input.reason.length > 500
    || input.document.subarray(0, 5).toString() !== "%PDF-") {
    throw new DraftDispatchError("DRAFT_DISPATCH_INVALID", "No se pudo preparar el envío de firma.", 400);
  }
  await ensureDraftDispatchSchema();
  return prisma.$transaction(async (db) => {
    await lockSolicitudOperationMutation(db, input.draftId);
    const replay = await db.$queryRawUnsafe<DraftDispatchRow[]>(
      `SELECT * FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1::uuid FOR UPDATE`, input.id);
    if (replay[0]) {
      const row = replay[0];
      if (row.draftId !== input.draftId || row.actorUserId !== input.actor.id
        || row.reason !== input.reason || row.expectedProcessUuid !== input.expectedProcessUuid) {
        throw new DraftDispatchError("DRAFT_DISPATCH_IDEMPOTENCY_CONFLICT",
          "Esta confirmación corresponde a otra solicitud de firma.");
      }
      return row;
    }
    const unresolved = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id"::text FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=$1
        AND "status" IN ('PREPARING','DISPATCHING','UNCERTAIN') LIMIT 1`, input.draftId);
    if (unresolved.length) throw new DraftDispatchError("DRAFT_DISPATCH_UNRESOLVED",
      "Existe un envío de firma sin resultado confirmado. Revisa el estado antes de reenviar.");
    const drafts = await db.$queryRawUnsafe<Array<{ samePayload: boolean; currentStep: number }>>(
      `SELECT "payload"=$2::jsonb AS "samePayload","currentStep" FROM "CreditoBorrador" WHERE "id"=$1
        AND "estado"='ABIERTO' AND "creditoId" IS NULL
        AND COALESCE("expiresAt","createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
        FOR UPDATE`, input.draftId, json(input.sourcePayload));
    if (!drafts[0] || ![3, 4].includes(drafts[0].currentStep)
      || !drafts[0].samePayload) {
      throw new DraftDispatchError("DRAFT_DISPATCH_CHANGED",
        "La solicitud cambió antes de enviar el contrato. Actualiza el caso.");
    }
    const processes = await db.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
      `SELECT * FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "creditoId" IS NULL
        AND "supersededAt" IS NULL ORDER BY "createdAt" DESC,"id" DESC FOR UPDATE`, input.draftId);
    if (processes.length > 1 || (processes[0]?.processUuid || null) !== input.expectedProcessUuid
      || (processes.length > 0 && !input.supersedeActive)) {
      throw new DraftDispatchError("DRAFT_DISPATCH_PROCESS_CHANGED",
        "La firma vigente cambió antes del envío. Actualiza el caso.");
    }
    if (input.supersedeActive) {
      const archived = await markFirmaSeguroDraftProcessesSuperseded(db, {
        draftId: input.draftId, actorUserId: input.actor.id, reason: input.reason,
      });
      if (archived.length !== 1) throw new DraftDispatchError("DRAFT_DISPATCH_PROCESS_CHANGED",
        "La firma vigente cambió antes del envío. Actualiza el caso.");
    }
    const changed = await db.$queryRawUnsafe<Array<{ id: number }>>(
      `UPDATE "CreditoBorrador" SET "payload"=$2::jsonb,"updatedAt"=CURRENT_TIMESTAMP
        WHERE "id"=$1 AND "payload"=$3::jsonb RETURNING "id"`,
      input.draftId, json(input.updatedPayload), json(input.sourcePayload));
    if (changed.length !== 1) throw new DraftDispatchError("DRAFT_DISPATCH_CHANGED",
      "La solicitud cambió antes del envío. Actualiza el caso.");
    const rows = await db.$queryRawUnsafe<DraftDispatchRow[]>(
      `INSERT INTO "FirmaSeguroDraftDispatch"
        ("id","draftId","actorUserId","actorName","reason","expectedProcessUuid","status",
         "draftFolio","sourcePayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash")
       VALUES ($1::uuid,$2,$3,$4,$5,$6,'PREPARING',$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)
       RETURNING *`,
      input.id, input.draftId, input.actor.id, input.actor.nombre, input.reason,
      input.expectedProcessUuid, input.draftFolio, json(input.sourcePayload),
      json(input.updatedPayload), json(input.draftPayload), json(input.frozenCredit),
      input.document.toString("base64"), hash(input.document));
    return rows[0];
  }, { timeout: 15000 });
}

export async function dispatchReservedDraft(id: string) {
  const row = await getDraftDispatch(id);
  if (!row) throw new DraftDispatchError("DRAFT_DISPATCH_NOT_FOUND", "Envío de firma no encontrado.", 404);
  if (row.status !== "PREPARING") return row;
  const document = Buffer.from(row.documentBase64, "base64");
  if (document.subarray(0, 5).toString() !== "%PDF-" || hash(document) !== row.documentHash) {
    await prisma.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch"
      SET "status"='FAILED_SAFE',"lastError"='El documento reservado no supera la validación de integridad',
        "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid AND "status"='PREPARING'`, id);
    throw new DraftDispatchError("DRAFT_DISPATCH_DOCUMENT_INVALID", "El contrato reservado no supera la validación de integridad.");
  }
  const sealed = readFinancingTermsSeal((row.draftPayload as Record<string, unknown>).financialTermsSeal);
  if (!sealed || sealed.snapshot.folio !== row.draftFolio
    || resolveActivationFirstPaymentDate({ frequency: sealed.snapshot.frecuenciaPago,
      activatedAt: new Date() }).dateKey !== sealed.snapshot.fechaPrimerPago) {
    await prisma.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch"
      SET "status"='FAILED_SAFE',"lastError"='La fecha o el sello financiero cambió antes del envío',
        "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid AND "status"='PREPARING'`, id);
    throw new DraftDispatchError("DRAFT_DISPATCH_TERMS_CHANGED",
      "La fecha o el sello financiero cambió antes del envío. Revisa el contrato.");
  }
  const veriffRequired = getDataCreditoPublicConfig().enabled || isVeriffRequired();
  if (veriffRequired) await ensureVeriffSchema();
  let prepared: Awaited<ReturnType<typeof prepareFirmaSeguroReissue>>;
  try {
    prepared = await prepareFirmaSeguroReissue(row.frozenCredit, document, id);
  } catch (error) {
    await prisma.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch"
      SET "status"='FAILED_SAFE',"lastError"=$2,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1::uuid AND "status"='PREPARING'`, id,
      error instanceof Error ? error.message.slice(0, 500) : "Preparación fallida");
    throw new DraftDispatchError("DRAFT_DISPATCH_PREPARATION_FAILED",
      "No se preparó el envío de firma. Corrige el problema y vuelve a intentar.");
  }
  const claimed = await prisma.$transaction(async (db) => {
    await lockSolicitudOperationMutation(db, row.draftId);
    const drafts = await db.$queryRawUnsafe<Array<{ samePayload: boolean; currentStep: number }>>(
      `SELECT "payload"=$2::jsonb AS "samePayload","currentStep" FROM "CreditoBorrador"
        WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
        AND COALESCE("expiresAt","createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP FOR UPDATE`,
      row.draftId, json(row.updatedPayload));
    let valid = Boolean(drafts[0]?.samePayload && [3, 4].includes(drafts[0].currentStep));
    const active = await db.$queryRawUnsafe<Array<{ id: number }>>(
      `SELECT "id" FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "creditoId" IS NULL
        AND "supersededAt" IS NULL LIMIT 1`, row.draftId);
    valid = valid && active.length === 0;
    if (valid && veriffRequired) {
      const payload = row.updatedPayload as Record<string, unknown>;
      const validationId = Number(payload.veriffValidationId || 0);
      const latest = await db.$queryRawUnsafe<VeriffValidationRow[]>(
        `SELECT * FROM "VeriffIdentityValidation" WHERE "draftId"=$1 AND "creditoId" IS NULL
          ORDER BY "id" DESC LIMIT 1 FOR SHARE`, row.draftId);
      const validation = latest[0];
      const document = String(payload.clienteDocumento || "").replace(/\D/g, "");
      valid = Boolean(Number.isInteger(validationId) && validationId > 0
        && validation?.id === validationId && isVeriffApproved(validation)
        && document && String(validation.clienteDocumento || "").replace(/\D/g, "") === document);
    }
    if (!valid) {
      await db.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch"
        SET "status"='FAILED_SAFE',"lastError"='El borrador o Veriff cambió antes del envío',
          "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid AND "status"='PREPARING'`, id);
      return false;
    }
    const result = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "FirmaSeguroDraftDispatch" SET "status"='DISPATCHING',
        "requestPayload"=$2::jsonb,"dispatchedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP
        WHERE "id"=$1::uuid AND "status"='PREPARING' RETURNING "id"::text`,
      id, json(prepared.requestPayload));
    return result.length === 1;
  }, { timeout: 15000 });
  if (!claimed) {
    const current = (await getDraftDispatch(id))!;
    if (current.status === "FAILED_SAFE") throw new DraftDispatchError("DRAFT_DISPATCH_CHANGED",
      "La solicitud o Veriff cambió antes del envío. Actualiza el caso.");
    return current;
  }
  try {
    const acknowledged = await prepared.sendOnce();
    await prisma.$transaction(async (db) => {
      await lockSolicitudOperationMutation(db, row.draftId);
      const dispatch = await db.$queryRawUnsafe<DraftDispatchRow[]>(
        `SELECT * FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1::uuid FOR UPDATE`, id);
      if (dispatch[0]?.status !== "DISPATCHING") throw new Error("DRAFT_DISPATCH_STATE_CHANGED");
      const drafts = await db.$queryRawUnsafe<Array<{ samePayload: boolean }>>(
        `SELECT "payload"=$2::jsonb AS "samePayload" FROM "CreditoBorrador"
          WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL FOR UPDATE`,
        row.draftId, json(row.updatedPayload));
      const stillCurrent = Boolean(drafts[0]?.samePayload);
      const providerStatus = String(acknowledged.status || "CREATED");
      const providerFailed = isFirmaSeguroFailedStatus(providerStatus);
      const storedStatus = providerFailed ? providerStatus
        : isFirmaSeguroCompletedStatus(providerStatus) ? "CREATED" : providerStatus;
      await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroProcess"
        ("draftId","draftFolio","draftPayload","processUuid","status","requestPayload","createPayload",
         "supersededAt","supersededByUserId","supersededReason")
        VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7::jsonb,
          CASE WHEN $8::boolean THEN NULL ELSE CURRENT_TIMESTAMP END,
          CASE WHEN $8::boolean THEN NULL ELSE $9 END,
          CASE WHEN $8::boolean THEN NULL ELSE 'La solicitud cambió durante el envío' END)`,
        row.draftId, row.draftFolio, json(row.draftPayload), acknowledged.processUuid,
        storedStatus, json(prepared.requestPayload), json(acknowledged.createPayload), stillCurrent, row.actorUserId);
      await db.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch"
        SET "status"=CASE WHEN $3::boolean AND NOT $4::boolean THEN 'AWAITING_SIGNATURE' ELSE 'UNCERTAIN' END,
          "processUuid"=$2,"acknowledgedAt"=CURRENT_TIMESTAMP,
          "lastError"=CASE WHEN $4::boolean THEN 'FirmaSeguro devolvió un estado terminal de fallo'
            WHEN $3::boolean THEN NULL ELSE 'La solicitud cambió durante el envío' END,
          "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid AND "status"='DISPATCHING'`,
        id, acknowledged.processUuid, stillCurrent, providerFailed);
      if (stillCurrent && !providerFailed) {
        await db.$executeRawUnsafe(`UPDATE "CreditoBorrador"
          SET "payload"="payload"-'firmaSeguroContactCorrectionPending',
            "updatedAt"=CURRENT_TIMESTAMP
          WHERE "id"=$1 AND "payload"=$2::jsonb
            AND "payload"->>'firmaSeguroContactCorrectionPending'='true'`,
          row.draftId, json(row.updatedPayload));
      }
    }, { timeout: 15000 });
    return (await getDraftDispatch(id))!;
  } catch (error) {
    await prisma.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch"
      SET "status"='UNCERTAIN',"lastError"=$2,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1::uuid AND "status"='DISPATCHING'`, id,
      error instanceof Error ? error.message.slice(0, 500) : "Resultado del proveedor incierto").catch(() => undefined);
    throw new DraftDispatchError("DRAFT_DISPATCH_UNCERTAIN",
      "No se confirmó el resultado del envío. Requiere conciliación antes de intentar de nuevo.");
  }
}
