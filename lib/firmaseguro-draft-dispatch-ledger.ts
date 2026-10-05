import "server-only";

import { createHash } from "node:crypto";
import { isVerifiedPendingSignatureStatus, isVerifiedTerminalSignatureFailure } from "@/lib/approval-operations-core";
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
import { ensureApprovalOperationalSchema } from "@/lib/approval-operations-schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type DispatchStatus = "PREPARING" | "DISPATCHING" | "AWAITING_SIGNATURE" | "FAILED_SAFE" | "UNCERTAIN";
export type DraftDispatchRow = {
  id: string; draftId: number; actorUserId: number; actorName: string; reason: string;
  expectedProcessUuid: string | null; processUuid: string | null; status: DispatchStatus;
  draftFolio: string; sourcePayload: unknown; updatedPayload: unknown; draftPayload: unknown;
  frozenCredit: CreditForFirmaSeguroPdf; documentBase64: string; documentHash: string;
  requestPayload: unknown; lastError: string | null;
};

export type DraftDispatchReceipt = {
  dispatchId: string; processUuid: string; providerStatus: string; createPayload: unknown;
  source: "send_response" | "provider_reconciliation";
  actorUserId: number | null; actorName: string | null; evidence: unknown; createdAt: Date;
};

export type DraftDispatchReconciliation = {
  id: bigint; dispatchId: string; processUuid: string; providerStatus: string;
  providerPayload: unknown; actorUserId: number; actorName: string;
  evidence: unknown; createdAt: Date;
};

type ProviderAcknowledgement = {
  processUuid: string; status: string; createPayload: unknown;
};

export class DraftDispatchError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "DraftDispatchError";
  }
}

function hash(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown) { return JSON.stringify(value); }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function isDeferredContactRedirect(input: {
  id: string; expectedProcessUuid: string | null; updatedPayload: unknown;
}) {
  const payload = record(input.updatedPayload);
  return payload.firmaSeguroPendingContactRedirectId === input.id
    && payload.firmaSeguroPendingContactRedirectSourceProcessUuid === input.expectedProcessUuid
    && typeof payload.firmaSeguroPendingContactRedirectSourceChecksum === "string"
    && /^[a-f0-9]{64}$/i.test(payload.firmaSeguroPendingContactRedirectSourceChecksum)
    && typeof payload.firmaSeguroPendingContactRedirectIntentSha256 === "string"
    && /^[a-f0-9]{64}$/i.test(payload.firmaSeguroPendingContactRedirectIntentSha256);
}

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
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "FirmaSeguroDraftDispatchReceipt" (
      "dispatchId" UUID PRIMARY KEY REFERENCES "FirmaSeguroDraftDispatch"("id") ON DELETE RESTRICT,
      "processUuid" TEXT NOT NULL UNIQUE CHECK (LENGTH(BTRIM("processUuid")) BETWEEN 1 AND 200),
      "providerStatus" TEXT NOT NULL,
      "createPayload" JSONB NOT NULL,
      "source" TEXT NOT NULL CHECK ("source" IN ('send_response','provider_reconciliation')),
      "actorUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" TEXT,
      "evidence" JSONB NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "FirmaSeguroDraftDispatchReceipt_evidence_check" CHECK
        ("source" <> 'provider_reconciliation' OR
          ("actorUserId" IS NOT NULL AND "actorName" IS NOT NULL AND LENGTH(BTRIM("actorName")) > 0
            AND jsonb_typeof("evidence")='object' AND "evidence" <> '{}'::jsonb))
    )`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "FirmaSeguroDraftDispatchReconciliation" (
      "id" BIGSERIAL PRIMARY KEY,
      "dispatchId" UUID NOT NULL REFERENCES "FirmaSeguroDraftDispatch"("id") ON DELETE RESTRICT,
      "processUuid" TEXT NOT NULL CHECK (LENGTH(BTRIM("processUuid")) BETWEEN 1 AND 200),
      "providerStatus" TEXT NOT NULL,
      "providerPayload" JSONB NOT NULL,
      "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" TEXT NOT NULL CHECK (LENGTH(BTRIM("actorName")) > 0),
      "evidence" JSONB NOT NULL CHECK (jsonb_typeof("evidence")='object' AND "evidence" <> '{}'::jsonb),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "FirmaSeguroDraftDispatchReconciliation_latest"
      ON "FirmaSeguroDraftDispatchReconciliation"("dispatchId","id" DESC)`);
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
          OR (OLD."status"='DISPATCHING' AND NEW."status" NOT IN ('DISPATCHING','AWAITING_SIGNATURE','FAILED_SAFE','UNCERTAIN'))
          OR (OLD."status"='UNCERTAIN' AND NEW."status" NOT IN ('UNCERTAIN','AWAITING_SIGNATURE','FAILED_SAFE'))
          OR (OLD."status" IN ('AWAITING_SIGNATURE','FAILED_SAFE')
            AND NEW."status" IS DISTINCT FROM OLD."status")
        THEN RAISE EXCEPTION 'DRAFT_DISPATCH_STATUS_INVALID' USING ERRCODE='23514'; END IF;
        IF NEW."status"='FAILED_SAFE' AND OLD."status" IN ('DISPATCHING','UNCERTAIN')
          AND NOT EXISTS (
            SELECT 1 FROM "FirmaSeguroDraftDispatchReceipt" receipt
            LEFT JOIN LATERAL (
              SELECT reconciliation."providerStatus"
              FROM "FirmaSeguroDraftDispatchReconciliation" reconciliation
              WHERE reconciliation."dispatchId"=NEW."id"
                AND reconciliation."processUuid"=receipt."processUuid"
              ORDER BY reconciliation."id" DESC LIMIT 1
            ) latest ON TRUE
            WHERE receipt."dispatchId"=NEW."id" AND receipt."processUuid"=NEW."processUuid"
              AND upper(btrim(COALESCE(latest."providerStatus",receipt."providerStatus"))) IN
                ('ABORTADA','ABORTADO','ABORTED','ANULADA','ANULADO','CANCELADA','CANCELADO',
                 'CANCELED','CANCELLED','DECLINADA','DECLINADO','DECLINED','EXPIRED','EXPIRADA',
                 'EXPIRADO','RECHAZADA','RECHAZADO','REJECTED','REVOKED')
          ) THEN RAISE EXCEPTION 'DRAFT_DISPATCH_TERMINAL_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
        IF NEW."status"='AWAITING_SIGNATURE' AND OLD."status" IS DISTINCT FROM NEW."status"
          AND NOT EXISTS (
            SELECT 1 FROM "FirmaSeguroDraftDispatchReceipt" receipt
            LEFT JOIN LATERAL (
              SELECT reconciliation."providerStatus"
              FROM "FirmaSeguroDraftDispatchReconciliation" reconciliation
              WHERE reconciliation."dispatchId"=NEW."id"
                AND reconciliation."processUuid"=receipt."processUuid"
              ORDER BY reconciliation."id" DESC LIMIT 1
            ) latest ON TRUE
            JOIN "FirmaSeguroProcess" process ON process."processUuid"=receipt."processUuid"
            JOIN "CreditoBorrador" draft ON draft."id"=NEW."draftId"
            WHERE receipt."dispatchId"=NEW."id" AND receipt."processUuid"=NEW."processUuid"
              AND upper(COALESCE(latest."providerStatus",receipt."providerStatus")) ~
                '(^|[^A-Z0-9])(CREATED|CREADO|PENDING|WAITING|SENT|IN_PROGRESS|IN_PROCESS|INITIATED|STARTED|AWAITING_SIGNATURE|PENDING_SIGNATURE|EN_PROCESO|ENVIADO|COMPLETED|COMPLETE|COMPLETADO|FINALIZED|FINALIZADO|FINISHED|SIGNED|FIRMADO|APROBADO|APROBADA|EXITOSO|EXITOSA|SUCCESS|SUCCESSFUL)([^A-Z0-9]|$)'
              AND upper(COALESCE(latest."providerStatus",receipt."providerStatus")) !~
                '(^|[^A-Z0-9])(NOT|NO|SIN|ABORTADA|ABORTADO|ABORTED|ANULADA|ANULADO|CANCELADA|CANCELADO|CANCELED|CANCELLED|DECLINADA|DECLINADO|DECLINED|ERROR|EXPIRED|EXPIRADA|EXPIRADO|FAILED|FAILURE|RECHAZADA|RECHAZADO|REJECTED|REVOKED)([^A-Z0-9]|$)'
              AND process."draftId"=NEW."draftId" AND process."creditoId" IS NULL
              AND process."draftFolio"=NEW."draftFolio" AND process."draftPayload"=NEW."draftPayload"
              AND process."supersededAt" IS NULL AND draft."estado"='ABIERTO'
              AND draft."creditoId" IS NULL AND draft."payload"=NEW."updatedPayload"
              AND draft."currentStep" IN (3,4)
              AND COALESCE(draft."expiresAt",draft."createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP
          ) THEN RAISE EXCEPTION 'DRAFT_DISPATCH_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
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
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_receipt_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'DRAFT_DISPATCH_RECEIPT_IMMUTABLE' USING ERRCODE='23514';
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatchReceipt_immutable"
      BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatchReceipt"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_receipt_immutable()`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.firmaseguro_draft_dispatch_reconciliation_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'DRAFT_DISPATCH_RECONCILIATION_IMMUTABLE' USING ERRCODE='23514';
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "FirmaSeguroDraftDispatchReconciliation_immutable"
      BEFORE UPDATE OR DELETE ON "FirmaSeguroDraftDispatchReconciliation"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft_dispatch_reconciliation_immutable()`);
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

async function readDispatchReceipt(column: "dispatchId" | "processUuid", value: string) {
  const exists = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('public."FirmaSeguroDraftDispatchReceipt"') IS NOT NULL AS "present"`);
  if (!exists[0]?.present) return null;
  const rows = column === "dispatchId"
    ? await prisma.$queryRawUnsafe<DraftDispatchReceipt[]>(
      `SELECT * FROM "FirmaSeguroDraftDispatchReceipt" WHERE "dispatchId"=$1::uuid`, value)
    : await prisma.$queryRawUnsafe<DraftDispatchReceipt[]>(
      `SELECT * FROM "FirmaSeguroDraftDispatchReceipt" WHERE "processUuid"=$1`, value);
  return rows[0] || null;
}

export async function getDraftDispatchReceipt(id: string) {
  return UUID.test(id) ? readDispatchReceipt("dispatchId", id) : null;
}

export async function getDraftDispatchReceiptByProcessUuid(processUuid: string) {
  return processUuid.trim() ? readDispatchReceipt("processUuid", processUuid.trim()) : null;
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
  options?: {
    /** A redirect may only replace a provider process that is still unsigned. */
    requireUnsignedActive?: boolean;
    /** A provider-confirmed terminal failure is a safe frozen source for retry. */
    allowTerminalFailedActive?: boolean;
  };
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
      const replayRedirect = isDeferredContactRedirect(row);
      const inputRedirect = isDeferredContactRedirect(input);
      const replayPayload = record(row.updatedPayload);
      const inputPayload = record(input.updatedPayload);
      if (row.draftId !== input.draftId || row.actorUserId !== input.actor.id
        || row.reason !== input.reason || row.expectedProcessUuid !== input.expectedProcessUuid
        || ((replayRedirect || inputRedirect) && (!replayRedirect || !inputRedirect
          || replayPayload.firmaSeguroPendingContactRedirectIntentSha256
            !== inputPayload.firmaSeguroPendingContactRedirectIntentSha256))) {
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
    if (input.options?.requireUnsignedActive) {
      const active = processes[0];
      if (!active) throw new DraftDispatchError("DRAFT_DISPATCH_PROCESS_CHANGED",
        "La firma vigente cambió antes del envío. Actualiza el caso.");
      if (active.signedDocumentBase64 || active.completedAt || isFirmaSeguroCompletedStatus(active.status)) {
        throw new DraftDispatchError("DRAFT_SIGNATURE_ALREADY_COMPLETED",
          "El cliente ya firmó. Actualiza el expediente antes de reenviar.");
      }
      const terminalFailed = isVerifiedTerminalSignatureFailure(active.status);
      const pending = isVerifiedPendingSignatureStatus(active.status);
      if ((!terminalFailed && !pending) || (active.lastError && !terminalFailed)
        || (terminalFailed && !input.options.allowTerminalFailedActive)) {
        throw new DraftDispatchError("DRAFT_SIGNATURE_NOT_PENDING",
          "La firma ya no está pendiente. Actualiza el expediente antes de reenviar.");
      }
    }
    const deferredContactRedirect = input.supersedeActive
      && input.options?.requireUnsignedActive === true
      && isDeferredContactRedirect(input);
    if (input.supersedeActive && !deferredContactRedirect) {
      const archived = await markFirmaSeguroDraftProcessesSuperseded(db, {
        draftId: input.draftId, actorUserId: input.actor.id, reason: input.reason,
      });
      if (archived.length !== 1) throw new DraftDispatchError("DRAFT_DISPATCH_PROCESS_CHANGED",
        "La firma vigente cambió antes del envío. Actualiza el caso.");
    }
    if (!deferredContactRedirect) {
      const changed = await db.$queryRawUnsafe<Array<{ id: number }>>(
        `UPDATE "CreditoBorrador" SET "payload"=$2::jsonb,"updatedAt"=CURRENT_TIMESTAMP
          WHERE "id"=$1 AND "payload"=$3::jsonb RETURNING "id"`,
        input.draftId, json(input.updatedPayload), json(input.sourcePayload));
      if (changed.length !== 1) throw new DraftDispatchError("DRAFT_DISPATCH_CHANGED",
        "La solicitud cambió antes del envío. Actualiza el caso.");
    }
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

function sanitizedReceiptJson(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null, (key, item: unknown) => {
    if (/token|password|authorization|secret/i.test(key)) return "[redacted]";
    if (typeof item === "string" && /base64|string|document/i.test(key) && item.length > 500) {
      return `[base64:${item.length}]`;
    }
    return item;
  })) as unknown;
}

function normalizedProviderStatus(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function verifiedProviderOutcome(status: unknown): "ACTIVE" | "TERMINAL_FAILURE" | "INCONCLUSIVE" {
  if (isVerifiedTerminalSignatureFailure(status)) return "TERMINAL_FAILURE";
  if (isFirmaSeguroFailedStatus(status)) return "INCONCLUSIVE";
  const normalized = normalizedProviderStatus(status);
  const pending = isVerifiedPendingSignatureStatus(normalized);
  const tokens = normalized.split("_").filter(Boolean);
  const negative = tokens.some((token) => ["NOT", "NO", "SIN", "PENDING", "WAITING", "AWAITING"].includes(token));
  const completed = !negative && isFirmaSeguroCompletedStatus(normalized);
  return pending || completed ? "ACTIVE" : "INCONCLUSIVE";
}
async function recordDispatchReceipt(input: {
  dispatchId: string; acknowledgement: ProviderAcknowledgement;
  source: DraftDispatchReceipt["source"];
  actor?: { id: number; nombre: string }; evidence: Record<string, unknown>;
}): Promise<DraftDispatchReceipt | DraftDispatchReconciliation> {
  const processUuid = input.acknowledgement.processUuid.trim();
  if (!UUID.test(input.dispatchId) || !processUuid || processUuid.length > 200
    || /[\u0000-\u001f\u007f]/.test(processUuid)) {
    throw new DraftDispatchError("DRAFT_DISPATCH_RECEIPT_INVALID", "La confirmación del proveedor no es válida.");
  }
  await ensureDraftDispatchSchema();
  return prisma.$transaction(async (db) => {
    const rows = await db.$queryRawUnsafe<DraftDispatchRow[]>(
      `SELECT * FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1::uuid FOR UPDATE`, input.dispatchId);
    const row = rows[0];
    if (!row) throw new DraftDispatchError("DRAFT_DISPATCH_NOT_FOUND", "Envío de firma no encontrado.", 404);
    if (!["DISPATCHING", "UNCERTAIN", "AWAITING_SIGNATURE"].includes(row.status)
      || (row.processUuid && row.processUuid !== processUuid)) {
      throw new DraftDispatchError("DRAFT_DISPATCH_RECEIPT_CONFLICT", "La confirmación no corresponde al envío reservado.");
    }
    const processOwners = await db.$queryRawUnsafe<Array<{ matches: boolean }>>(
      `SELECT "draftId"=$2 AND "creditoId" IS NULL AND "draftFolio"=$3
        AND "draftPayload"=$4::jsonb AS "matches"
        FROM "FirmaSeguroProcess" WHERE "processUuid"=$1`,
      processUuid, row.draftId, row.draftFolio, json(row.draftPayload));
    if (processOwners.some((process) => process.matches !== true)) {
      throw new DraftDispatchError("DRAFT_DISPATCH_RECEIPT_CONFLICT", "El proceso del proveedor pertenece a otro expediente.");
    }
    const providerStatus = String(input.acknowledgement.status || "CREATED");
    const providerPayload = sanitizedReceiptJson(input.acknowledgement.createPayload);
    const evidence = sanitizedReceiptJson(input.evidence);
    const existing = await db.$queryRawUnsafe<DraftDispatchReceipt[]>(
      `SELECT * FROM "FirmaSeguroDraftDispatchReceipt"
        WHERE "dispatchId"=$1::uuid OR "processUuid"=$2`, input.dispatchId, processUuid);
    if (existing.length) {
      if (existing.length !== 1 || existing[0].dispatchId !== row.id
        || existing[0].processUuid !== processUuid) {
        throw new DraftDispatchError("DRAFT_DISPATCH_RECEIPT_CONFLICT", "El proveedor ya está vinculado a otra confirmación.");
      }
      if (input.source === "provider_reconciliation") {
        const reconciliations = await db.$queryRawUnsafe<DraftDispatchReconciliation[]>(
          `INSERT INTO "FirmaSeguroDraftDispatchReconciliation"
            ("dispatchId","processUuid","providerStatus","providerPayload","actorUserId","actorName","evidence")
            VALUES ($1::uuid,$2,$3,$4::jsonb,$5::integer,$6,$7::jsonb) RETURNING *`,
          input.dispatchId, processUuid, providerStatus, json(providerPayload), input.actor!.id,
          input.actor!.nombre.trim(), json(evidence));
        return reconciliations[0];
      }
      return existing[0];
    }
    const receipts = await db.$queryRawUnsafe<DraftDispatchReceipt[]>(
      `INSERT INTO "FirmaSeguroDraftDispatchReceipt"
        ("dispatchId","processUuid","providerStatus","createPayload","source","actorUserId","actorName","evidence")
        VALUES ($1::uuid,$2,$3,$4::jsonb,$5,$6::integer,$7,$8::jsonb)
        ON CONFLICT DO NOTHING RETURNING *`,
      input.dispatchId, processUuid, providerStatus, json(providerPayload), input.source,
      input.actor?.id ?? null, input.actor?.nombre.trim() ?? null, json(evidence));
    if (!receipts[0]) throw new DraftDispatchError("DRAFT_DISPATCH_RECEIPT_CONFLICT",
      "El proveedor ya está vinculado a otra confirmación.");
    return receipts[0];
  }, { timeout: 15000 });
}

/** Internal server API: callers must first verify the provider's process, operation
 * tag/document and recipient against the frozen dispatch. Never expose as a raw
 * process-UUID mutation endpoint. Evidence records that completed verification. */
export async function recordVerifiedDraftDispatchReceipt(input: {
  dispatchId: string; processUuid: string; providerStatus: string; createPayload: unknown;
  actor: { id: number; nombre: string }; evidence: Record<string, unknown>;
}) {
  if (!Number.isSafeInteger(input.actor?.id) || input.actor.id < 1
    || !input.actor.nombre?.trim() || !input.evidence || typeof input.evidence !== "object"
    || Array.isArray(input.evidence) || Object.keys(input.evidence).length === 0) {
    throw new DraftDispatchError("DRAFT_DISPATCH_VERIFICATION_REQUIRED",
      "La conciliación requiere un responsable y evidencia verificada del proveedor.");
  }
  return recordDispatchReceipt({
    dispatchId: input.dispatchId, source: "provider_reconciliation", actor: input.actor,
    evidence: input.evidence, acknowledgement: {
      processUuid: input.processUuid, status: input.providerStatus, createPayload: input.createPayload,
    },
  });
}

/** Materialize a durable provider acknowledgement. This function never sends a contract. */
export async function finalizeDraftDispatch(id: string): Promise<DraftDispatchRow> {
  const initial = await getDraftDispatch(id);
  if (!initial) throw new DraftDispatchError("DRAFT_DISPATCH_NOT_FOUND", "Envío de firma no encontrado.", 404);
  if (["AWAITING_SIGNATURE", "FAILED_SAFE"].includes(initial.status)) return initial;
  if (!await getDraftDispatchReceipt(id)) throw new DraftDispatchError("DRAFT_DISPATCH_RECEIPT_REQUIRED",
    "El envío requiere evidencia del proveedor antes de conciliarse.");
  const veriffRequired = getDataCreditoPublicConfig().enabled || isVeriffRequired();
  if (veriffRequired) await ensureVeriffSchema();
  return prisma.$transaction(async (db) => {
    await lockSolicitudOperationMutation(db, initial.draftId);
    const dispatches = await db.$queryRawUnsafe<DraftDispatchRow[]>(
      `SELECT * FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1::uuid FOR UPDATE`, id);
    const row = dispatches[0];
    if (!row) throw new DraftDispatchError("DRAFT_DISPATCH_NOT_FOUND", "Envío de firma no encontrado.", 404);
    if (["AWAITING_SIGNATURE", "FAILED_SAFE"].includes(row.status)) return row;
    const receipts = await db.$queryRawUnsafe<DraftDispatchReceipt[]>(
      `SELECT * FROM "FirmaSeguroDraftDispatchReceipt" WHERE "dispatchId"=$1::uuid`, id);
    const receipt = receipts[0];
    if (!receipt || !["DISPATCHING", "UNCERTAIN"].includes(row.status)
      || (row.processUuid && row.processUuid !== receipt.processUuid)) {
      throw new DraftDispatchError("DRAFT_DISPATCH_RECEIPT_CONFLICT", "La confirmación no corresponde al envío reservado.");
    }
    const reconciliations = await db.$queryRawUnsafe<DraftDispatchReconciliation[]>(
      `SELECT * FROM "FirmaSeguroDraftDispatchReconciliation"
        WHERE "dispatchId"=$1::uuid AND "processUuid"=$2 ORDER BY "id" DESC LIMIT 1`,
      id, receipt.processUuid);
    const reconciliation = reconciliations[0] || null;
    if (row.expectedProcessUuid) {
      const sources = await db.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
        `SELECT * FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "creditoId" IS NULL
          AND "processUuid"=$2 FOR UPDATE`, row.draftId, row.expectedProcessUuid);
      if (sources[0]?.signedDocumentBase64 || sources[0]?.completedAt) {
        const conflict = await db.$queryRawUnsafe<DraftDispatchRow[]>(`UPDATE "FirmaSeguroDraftDispatch"
          SET "status"='UNCERTAIN',"processUuid"=COALESCE("processUuid",$2),
            "lastError"='La solicitud anterior fue firmada durante el reenvío; requiere conciliación manual',
            "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid
            AND "status" IN ('DISPATCHING','UNCERTAIN') RETURNING *`, id, receipt.processUuid);
        return conflict[0];
      }
    }
    const drafts = await db.$queryRawUnsafe<Array<{ samePayload: boolean }>>(
      `SELECT "payload"=$2::jsonb AS "samePayload" FROM "CreditoBorrador"
        WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
          AND "currentStep" IN (3,4)
          AND COALESCE("expiresAt","createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP FOR UPDATE`,
      row.draftId, json(row.updatedPayload));
    let stillCurrent = Boolean(drafts[0]?.samePayload);
    if (stillCurrent && veriffRequired) {
      const payload = row.updatedPayload as Record<string, unknown>;
      const validationId = Number(payload.veriffValidationId || 0);
      const latest = await db.$queryRawUnsafe<VeriffValidationRow[]>(
        `SELECT * FROM "VeriffIdentityValidation" WHERE "draftId"=$1 AND "creditoId" IS NULL
          ORDER BY "id" DESC LIMIT 1 FOR SHARE`, row.draftId);
      const validation = latest[0];
      const document = String(payload.clienteDocumento || "").replace(/\D/g, "");
      stillCurrent = Boolean(Number.isInteger(validationId) && validationId > 0
        && validation?.id === validationId && isVeriffApproved(validation)
        && document && String(validation.clienteDocumento || "").replace(/\D/g, "") === document);
    }
    const providerStatus = String(reconciliation?.providerStatus || receipt.providerStatus || "CREATED");
    const providerOutcome = verifiedProviderOutcome(providerStatus);
    const providerTerminalFailure = providerOutcome === "TERMINAL_FAILURE";
    const providerInconclusive = providerOutcome === "INCONCLUSIVE";
    const storedStatus = isFirmaSeguroCompletedStatus(providerStatus) ? "CREATED" : providerStatus;
    const statusPayload = reconciliation?.providerPayload ?? null;
    const processes = await db.$queryRawUnsafe<Array<FirmaSeguroProcessRow & { matches: boolean }>>(
      `SELECT *, "draftId"=$2 AND "creditoId" IS NULL AND "draftFolio"=$3
        AND "draftPayload"=$4::jsonb AS "matches" FROM "FirmaSeguroProcess"
        WHERE "processUuid"=$1 FOR UPDATE`, receipt.processUuid, row.draftId, row.draftFolio, json(row.draftPayload));
    const existing = processes[0];
    if (existing && (existing.matches !== true || (stillCurrent && existing.supersededAt)
      || existing.signedDocumentBase64 || existing.completedAt)) {
      throw new DraftDispatchError("DRAFT_DISPATCH_RECEIPT_CONFLICT", "El proceso confirmado pertenece a otro expediente, ya fue reemplazado o ya se firmó.");
    }
    const active = await db.$queryRawUnsafe<Array<{ processUuid: string }>>(
      `SELECT "processUuid" FROM "FirmaSeguroProcess" WHERE "draftId"=$1
        AND "creditoId" IS NULL AND "supersededAt" IS NULL AND "processUuid"<>$2`, row.draftId, receipt.processUuid);
    if (active.length) throw new DraftDispatchError("DRAFT_DISPATCH_RECEIPT_CONFLICT",
      "El expediente ya tiene otro proceso de firma vigente.");
    const processError = providerInconclusive ? "Estado de FirmaSeguro no concluyente; requiere conciliación" : null;
    if (!existing) {
      await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroProcess"
        ("draftId","draftFolio","draftPayload","processUuid","status","requestPayload","createPayload",
         "statusPayload","lastError","supersededAt","supersededByUserId","supersededReason")
        VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,
          CASE WHEN $10::boolean THEN NULL ELSE CURRENT_TIMESTAMP END,
          CASE WHEN $10::boolean THEN NULL ELSE $11::integer END,
          CASE WHEN $10::boolean THEN NULL ELSE 'La solicitud cambió durante el envío' END)`,
        row.draftId, row.draftFolio, json(row.draftPayload), receipt.processUuid,
        storedStatus, json(row.requestPayload), json(receipt.createPayload),
        statusPayload === null ? null : json(statusPayload), processError, stillCurrent, row.actorUserId);
    } else if (!stillCurrent && !existing.supersededAt) {
      await db.$executeRawUnsafe(`UPDATE "FirmaSeguroProcess" SET "supersededAt"=CURRENT_TIMESTAMP,
        "supersededByUserId"=$2::integer,"supersededReason"='La solicitud cambió durante el envío'
        WHERE "processUuid"=$1 AND "supersededAt" IS NULL`, receipt.processUuid, row.actorUserId);
    } else if (stillCurrent) {
      await db.$executeRawUnsafe(`UPDATE "FirmaSeguroProcess"
        SET "status"=$2,"statusPayload"=COALESCE($3::jsonb,"statusPayload"),"lastError"=$4,
          "updatedAt"=CURRENT_TIMESTAMP WHERE "processUuid"=$1 AND "supersededAt" IS NULL`,
        receipt.processUuid, storedStatus, statusPayload === null ? null : json(statusPayload), processError);
    }
    const result = await db.$queryRawUnsafe<DraftDispatchRow[]>(`UPDATE "FirmaSeguroDraftDispatch"
      SET "status"=CASE WHEN $4::boolean THEN 'FAILED_SAFE'
          WHEN $6::boolean THEN 'UNCERTAIN'
          WHEN $3::boolean THEN 'AWAITING_SIGNATURE' ELSE 'UNCERTAIN' END,
        "processUuid"=$2,"acknowledgedAt"=COALESCE("acknowledgedAt",$5::timestamp),
        "lastError"=CASE WHEN $4::boolean THEN 'FirmaSeguro devolvió un estado terminal de fallo'
          WHEN $6::boolean THEN 'FirmaSeguro devolvió un estado técnico no concluyente'
          WHEN $3::boolean THEN NULL ELSE 'La solicitud cambió durante el envío' END,
        "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid AND "status" IN ('DISPATCHING','UNCERTAIN') RETURNING *`,
      id, receipt.processUuid, stillCurrent, providerTerminalFailure, reconciliation?.createdAt ?? receipt.createdAt,
      providerInconclusive);
    if (stillCurrent && !providerInconclusive) {
      await db.$executeRawUnsafe(`UPDATE "CreditoBorrador"
        SET "payload"="payload"
          -'firmaSeguroContactCorrectionPending'
          -'firmaSeguroPendingContactRedirectId'
          -'firmaSeguroPendingContactRedirectSourceProcessUuid'
          -'firmaSeguroPendingContactRedirectSourceChecksum'
          -'firmaSeguroPendingContactRedirectIntentSha256',
          "updatedAt"=CURRENT_TIMESTAMP
        WHERE "id"=$1 AND "payload"=$2::jsonb AND "payload"->>'firmaSeguroContactCorrectionPending'='true'`,
        row.draftId, json(row.updatedPayload));
    }
    return result[0];
  }, { timeout: 15000 });
}

function dispatchFailureSummary(error: unknown, stage: string) {
  const detail = error instanceof Error ? error.message : "Error desconocido";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
  return `${stage} [${code}]: ${detail}`.slice(0, 500);
}

async function markDispatchUncertain(id: string, error: unknown, stage: string, acknowledgement?: ProviderAcknowledgement) {
  // An acknowledged UUID survives even if the receipt INSERT failed. It is only a
  // recovery locator: a receipt is still mandatory before materialization.
  await prisma.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch"
    SET "status"='UNCERTAIN',"lastError"=$2,
      "processUuid"=COALESCE("processUuid",$3::text),
      "acknowledgedAt"=CASE WHEN $3::text IS NULL THEN "acknowledgedAt"
        ELSE COALESCE("acknowledgedAt",CURRENT_TIMESTAMP) END,"updatedAt"=CURRENT_TIMESTAMP
    WHERE "id"=$1::uuid AND "status" IN ('DISPATCHING','UNCERTAIN')`,
    id, dispatchFailureSummary(error, stage), acknowledgement?.processUuid || null).catch(() => undefined);
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
  const updatedPayload = row.updatedPayload as Record<string, unknown>;
  const claimsFrozenContactRedirect = updatedPayload.firmaSeguroPendingContactRedirectId === row.id
    && updatedPayload.firmaSeguroPendingContactRedirectSourceProcessUuid === row.expectedProcessUuid
    && typeof updatedPayload.firmaSeguroPendingContactRedirectSourceChecksum === "string";
  let frozenContactRedirect = false;
  if (claimsFrozenContactRedirect && row.expectedProcessUuid) {
    const sources = await prisma.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
      `SELECT * FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "creditoId" IS NULL
        AND "processUuid"=$2 AND "supersededAt" IS NULL LIMIT 1`,
      row.draftId, row.expectedProcessUuid);
    const source = sources[0];
    const sourceSeal = readFinancingTermsSeal((source?.draftPayload as Record<string, unknown> | undefined)?.financialTermsSeal);
    const terminalFailedSource = Boolean(source && isVerifiedTerminalSignatureFailure(source.status));
    const pendingSource = Boolean(source && isVerifiedPendingSignatureStatus(source.status));
    frozenContactRedirect = Boolean(source && sourceSeal
      && sourceSeal.checksum === updatedPayload.firmaSeguroPendingContactRedirectSourceChecksum
      && source.draftFolio === row.draftFolio
      && !source.signedDocumentBase64 && !source.completedAt
      && (terminalFailedSource || pendingSource) && (!source.lastError || terminalFailedSource)
      && !isFirmaSeguroCompletedStatus(source.status));
  }
  if (!sealed || sealed.snapshot.folio !== row.draftFolio
    || (claimsFrozenContactRedirect && !frozenContactRedirect)
    || (!frozenContactRedirect && resolveActivationFirstPaymentDate({ frequency: sealed.snapshot.frecuenciaPago,
      activatedAt: new Date() }).dateKey !== sealed.snapshot.fechaPrimerPago)) {
    await prisma.$executeRawUnsafe(`UPDATE "FirmaSeguroDraftDispatch"
      SET "status"='FAILED_SAFE',"lastError"='La fecha o el sello financiero cambió antes del envío',
        "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid AND "status"='PREPARING'`, id);
    throw new DraftDispatchError("DRAFT_DISPATCH_TERMS_CHANGED",
      "La fecha o el sello financiero cambió antes del envío. Revisa el contrato.");
  }
  const veriffRequired = getDataCreditoPublicConfig().enabled || isVeriffRequired();
  if (veriffRequired) await ensureVeriffSchema();
  if (frozenContactRedirect) await ensureApprovalOperationalSchema();
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
    const drafts = await db.$queryRawUnsafe<Array<{
      sameSourcePayload: boolean; sameUpdatedPayload: boolean; currentStep: number;
      clienteTelefono: string | null;
    }>>(
      `SELECT "payload"=$2::jsonb AS "sameSourcePayload",
        "payload"=$3::jsonb AS "sameUpdatedPayload","currentStep","clienteTelefono"
        FROM "CreditoBorrador"
        WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL
        AND COALESCE("expiresAt","createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP FOR UPDATE`,
      row.draftId, json(row.sourcePayload), json(row.updatedPayload));
    let valid = Boolean(drafts[0] && [3, 4].includes(drafts[0].currentStep)
      && (frozenContactRedirect ? drafts[0].sameSourcePayload : drafts[0].sameUpdatedPayload));
    const active = await db.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
      `SELECT * FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "creditoId" IS NULL
        AND "supersededAt" IS NULL ORDER BY "createdAt" DESC,"id" DESC FOR UPDATE`, row.draftId);
    if (frozenContactRedirect) {
      const source = active.length === 1 ? active[0] : null;
      const sourceSeal = readFinancingTermsSeal(
        (source?.draftPayload as Record<string, unknown> | undefined)?.financialTermsSeal);
      const terminalFailedSource = Boolean(source && isVerifiedTerminalSignatureFailure(source.status));
      const pendingSource = Boolean(source && isVerifiedPendingSignatureStatus(source.status));
      valid = valid && Boolean(source && source.processUuid === row.expectedProcessUuid
        && sourceSeal?.checksum === updatedPayload.firmaSeguroPendingContactRedirectSourceChecksum
        && source.draftFolio === row.draftFolio
        && !source.signedDocumentBase64 && !source.completedAt
        && (terminalFailedSource || pendingSource) && (!source.lastError || terminalFailedSource)
        && !isFirmaSeguroCompletedStatus(source.status));
    } else {
      valid = valid && active.length === 0;
    }
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
    if (result.length !== 1) return false;
    if (frozenContactRedirect) {
      const archived = await markFirmaSeguroDraftProcessesSuperseded(db, {
        draftId: row.draftId, actorUserId: row.actorUserId, reason: row.reason,
      });
      if (archived.length !== 1 || archived[0].processUuid !== row.expectedProcessUuid) {
        throw new DraftDispatchError("DRAFT_DISPATCH_PROCESS_CHANGED",
          "La firma vigente cambió antes del envío. Actualiza el caso.");
      }
      const next = record(row.updatedPayload);
      const changed = await db.$queryRawUnsafe<Array<{ id: number }>>(
        `UPDATE "CreditoBorrador" SET "payload"=$2::jsonb,"clienteTelefono"=$3,
          "currentStep"=4,"updatedAt"=CURRENT_TIMESTAMP
          WHERE "id"=$1 AND "payload"=$4::jsonb RETURNING "id"`,
        row.draftId, json(row.updatedPayload), String(next.clienteTelefono || "") || null,
        json(row.sourcePayload));
      if (changed.length !== 1) throw new DraftDispatchError("DRAFT_DISPATCH_CHANGED",
        "La solicitud cambió antes del envío. Actualiza el caso.");
      const previous = record(row.sourcePayload);
      const sourceProcessSeal = readFinancingTermsSeal(record(archived[0].draftPayload).financialTermsSeal);
      const beforeContact = {
        clienteTelefono: String(drafts[0].clienteTelefono || previous.clienteTelefono
          || sourceProcessSeal?.snapshot.clienteTelefono || ""),
        clienteCorreo: String(previous.clienteCorreo
          || sourceProcessSeal?.snapshot.clienteCorreo || "").toLowerCase(),
      };
      const afterContact = {
        clienteTelefono: String(next.clienteTelefono || ""),
        clienteCorreo: String(next.clienteCorreo || "").toLowerCase(),
      };
      const imei = String(previous.imei || previous.deviceUid || "").replace(/\D/g, "");
      await db.$executeRawUnsafe(`INSERT INTO "ApprovalOperationalAction"
        ("id","targetKind","targetId","creditId","eventType","actorUserId","actorName",
         "previousImei","newImei","reason","beforeContact","afterContact","status")
        VALUES ($1::uuid,'DRAFT',$2,NULL,'CONTACT_UPDATED',$3,$4,$5,$5,$6,$7::jsonb,$8::jsonb,'PENDING_REISSUE')`,
        row.id, row.draftId, row.actorUserId, row.actorName, imei || null, row.reason,
        json(beforeContact), json(afterContact));
    }
    return true;
  }, { timeout: 15000 });
  if (!claimed) {
    const current = (await getDraftDispatch(id))!;
    if (current.status === "FAILED_SAFE") throw new DraftDispatchError("DRAFT_DISPATCH_CHANGED",
      "La solicitud o Veriff cambió antes del envío. Actualiza el caso.");
    return current;
  }
  try {
    const acknowledged = await prepared.sendOnce();
    try {
      // This independent commit survives any failure creating FirmaSeguroProcess.
      await recordDispatchReceipt({ dispatchId: id, acknowledgement: acknowledged,
        source: "send_response", evidence: { operationId: id } });
    } catch (error) {
      await markDispatchUncertain(id, error, "receipt_persistence", acknowledged);
      throw new DraftDispatchError("DRAFT_DISPATCH_ACK_PERSISTENCE_FAILED",
        "FirmaSeguro confirmó el envío, pero no se guardó su comprobante. Requiere conciliación; no vuelvas a enviarlo.");
    }
  } catch (error) {
    if (error instanceof DraftDispatchError && error.code === "DRAFT_DISPATCH_ACK_PERSISTENCE_FAILED") throw error;
    await markDispatchUncertain(id, error, "provider_dispatch");
    throw new DraftDispatchError("DRAFT_DISPATCH_UNCERTAIN",
      "No se confirmó el resultado del envío. Requiere conciliación antes de intentar de nuevo.");
  }
  try {
    return await finalizeDraftDispatch(id);
  } catch (error) {
    await markDispatchUncertain(id, error, "acknowledgement_materialization");
    throw new DraftDispatchError("DRAFT_DISPATCH_PERSISTENCE_FAILED",
      "FirmaSeguro confirmó el envío y su comprobante está guardado. Actualiza el estado para completar la conciliación.");
  }
}
