import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { getCreditApprovalDetail, CreditApprovalError } from "@/lib/credit-approval";
import { readFinancingTermsSeal, type FinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { frozenReissueCredit } from "@/lib/credit-approval-reissue-source";
import { operationalFrozenCredit } from "@/lib/approval-operations-core";
import { isVerifiedTerminalSignatureFailure } from "@/lib/approval-operations-core";
import { ensureApprovalOperationalSchema } from "@/lib/approval-operations-schema";
import { ensureApprovalInitialSignatureSchema } from "@/lib/approval-initial-signature-schema";
import { ensureFirmaSeguroSchema } from "@/lib/firmaseguro-storage";
import { buildFirmaSeguroCreditPdf } from "@/lib/firmaseguro-folio-pdf";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";

type Db = Prisma.TransactionClient | typeof prisma;
type Actor = { id: number; nombre: string };
type Credit = Record<string, unknown> & {
  id: number; folio: string; createdAt: Date; fechaCredito: Date | null;
  clienteTelefono: string | null; clienteCorreo: string | null;
  imei: string | null; deviceUid: string | null; contratoSnapshot: unknown;
  usuarioNombre: string | null; sedeNombre: string | null;
};
type Operation = {
  id: string; creditoId: number; sourceRevision: number; sourceReviewHash: string;
  reservedRevision: number; termsHash: string; frozenCredit: CreditForFirmaSeguroPdf;
  sourceSeal: FinancingTermsSeal; reason: string; actorUserId: number;
  status: "PREPARING" | "DISPATCHING" | "AWAITING_SIGNATURE" | "COMPLETED" | "FAILED_SAFE" | "UNCERTAIN" | "TECHNICAL_ERROR";
  processUuid: string | null;
};
type Input = {
  idempotencyKey: unknown; expectedProcessUuid: unknown; expectedRevision: unknown;
  expectedReviewHash: unknown; reason: unknown;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const pendingStatuses = "('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN')";
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const invalid = (code: string, message: string, status = 409) => new CreditApprovalError(code, message, status);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  return value;
}

function parsedInput(input: Input) {
  const id = typeof input.idempotencyKey === "string" ? input.idempotencyKey.toLowerCase() : "";
  const reason = typeof input.reason === "string" ? input.reason.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
  if (!uuid.test(id) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1
    || typeof input.expectedReviewHash !== "string" || !hash.test(input.expectedReviewHash)
    || reason.length < 5 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)
    || ![null, undefined, ""].includes(input.expectedProcessUuid as null | undefined | string)) {
    throw invalid("INVALID_INITIAL_SIGNATURE", "Actualiza el expediente y confirma el primer envío de firma.", 400);
  }
  return { id, reason, revision: Number(input.expectedRevision), reviewHash: input.expectedReviewHash };
}

async function creditForSignature(db: Db, id: number) {
  const rows = await db.$queryRawUnsafe<Credit[]>(`SELECT credit.*,
    owner."nombre" AS "usuarioNombre", site."nombre" AS "sedeNombre"
    FROM "Credito" credit LEFT JOIN "Usuario" owner ON owner."id"=credit."usuarioId"
    JOIN "Sede" site ON site."id"=credit."sedeId"
    WHERE credit."id"=$1 FOR UPDATE OF credit`, id);
  if (!rows[0]) throw invalid("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
  return rows[0];
}

async function operationById(db: Db, id: string) {
  const rows = await db.$queryRawUnsafe<Operation[]>(
    `SELECT * FROM "CreditApprovalInitialSignature" WHERE "id"=$1::uuid`, id);
  return rows[0] || null;
}

async function assertNoOtherSignature(db: Db, creditId: number) {
  const active = await db.$queryRawUnsafe<Array<{ processUuid: string }>>(
    `SELECT "processUuid" FROM "FirmaSeguroProcess" WHERE "creditoId"=$1
      AND "supersededAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`, creditId);
  if (active.length) throw invalid("SIGNATURE_ALREADY_EXISTS",
    "Este crédito ya tiene una solicitud de firma. Actualiza el expediente antes de enviar otra.");
  const historical = await db.$queryRawUnsafe<Array<{ found: boolean }>>(
    `SELECT EXISTS (SELECT 1 FROM "FirmaSeguroProcess" process
      WHERE (process."creditoId"=$1 OR process."draftId" IN
        (SELECT draft."id" FROM "CreditoBorrador" draft WHERE draft."creditoId"=$1))
        AND LEFT(COALESCE(process."signedDocumentBase64",''),7)='JVBERi0') AS found`, creditId);
  if (historical[0]?.found) throw invalid("SIGNED_SOURCE_REVIEW_REQUIRED",
    "Existe una firma histórica. Revisa su vínculo con el crédito antes de solicitar otra.");
  const pending = await db.$queryRawUnsafe<Array<{ found: boolean }>>(
    `SELECT
      EXISTS (SELECT 1 FROM "CreditApprovalInitialSignature" WHERE "creditoId"=$1
        AND "status" IN ${pendingStatuses})
      OR EXISTS (SELECT 1 FROM "CreditApprovalReissue" WHERE "creditoId"=$1
        AND "status" IN ${pendingStatuses})
      OR EXISTS (SELECT 1 FROM "ApprovalOperationalContractVersion" WHERE "creditoId"=$1
        AND "status" IN ${pendingStatuses})
      OR EXISTS (SELECT 1 FROM "CreditDeviceReplacement" WHERE "creditId"=$1
        AND "status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED')) AS found`, creditId);
  if (pending[0]?.found) throw invalid("SIGNATURE_PENDING",
    "Hay una firma o un cambio de equipo en curso. Espera el resultado antes de enviar otra.");
}

async function frozenSource(db: Db, credit: Credit) {
  const financial = record(record(credit.contratoSnapshot).financiero);
  const seal = readFinancingTermsSeal(financial.selloFinanciero);
  if (!seal) throw invalid("CONTRACT_SOURCE_UNVERIFIED",
    "No se pudo verificar el origen contractual de este crédito. Requiere revisión técnica.");
  const corrections = await db.$queryRawUnsafe<Array<{ before: unknown; after: unknown;
    requestedRevision: number; resultingRevision: number }>>(
    `SELECT "before","after","requestedRevision","resultingRevision"
      FROM "CreditApprovalDataCorrection" WHERE "creditoId"=$1
      ORDER BY "resultingRevision","createdAt","id"`, credit.id);
  let frozen: ReturnType<typeof frozenReissueCredit>;
  try {
    frozen = frozenReissueCredit(credit, {
      draftPayload: { financialTermsSeal: seal }, draftFolio: credit.folio,
      createdAt: credit.fechaCredito || credit.createdAt,
    }, corrections);
  } catch {
    throw invalid("CONTRACT_SOURCE_UNVERIFIED",
      "Los datos del crédito no coinciden con su origen contractual. Requiere revisión técnica.");
  }
  const imei = String(credit.imei || credit.deviceUid || "").replace(/\D/g, "");
  const contract = operationalFrozenCredit(frozen.credit, imei,
    credit.clienteTelefono, credit.clienteCorreo);
  return {
    seal, termsHash: frozen.termsHash,
    contract: {
      ...contract,
      usuario: { nombre: credit.usuarioNombre || "FINSER PAY" },
      sede: { nombre: credit.sedeNombre || "FINSER PAY" },
    } satisfies CreditForFirmaSeguroPdf,
  };
}

function publicOperation(operation: Operation) {
  const message = operation.status === "AWAITING_SIGNATURE"
    ? "Firma enviada. Esperando la respuesta del cliente y la confirmación de FirmaSeguro."
    : operation.status === "COMPLETED" ? "Firma confirmada por FirmaSeguro. Revisa el contrato y el estado de aprobación."
    : operation.status === "FAILED_SAFE" ? "Error técnico: requiere revisión. No se envió la firma."
    : operation.status === "TECHNICAL_ERROR" ? "Error técnico: requiere revisión. La firma no se completó."
    : operation.status === "UNCERTAIN" ? "Error técnico: requiere revisión. El envío no pudo verificarse; no lo repitas."
    : "Preparando el primer envío de firma.";
  return { id: operation.id, status: operation.status, message, processUuid: operation.processUuid };
}

/** First delivery only. Reissues always use the signed-source approval workflow. */
export async function requestInitialApprovalSignature(creditId: number, raw: Input, actor: Actor) {
  if (!Number.isSafeInteger(creditId) || creditId < 1 || !Number.isSafeInteger(actor.id) || actor.id < 1)
    throw invalid("INVALID_CASE", "Selecciona un crédito válido.", 400);
  const input = parsedInput(raw);
  await ensureFirmaSeguroSchema();
  await ensureApprovalOperationalSchema();
  await ensureApprovalInitialSignatureSchema();
  const reserved = await prisma.$transaction(async (db) => {
    const credit = await creditForSignature(db, creditId);
    const previous = await operationById(db, input.id);
    if (previous) {
      if (previous.creditoId !== creditId || previous.actorUserId !== actor.id
        || previous.sourceRevision !== input.revision || previous.sourceReviewHash !== input.reviewHash
        || previous.reason !== input.reason) throw invalid("IDEMPOTENCY_CONFLICT",
          "Esta confirmación pertenece a otra solicitud de firma.");
      return { operation: previous, dispatch: false };
    }
    const detail = await getCreditApprovalDetail(db, creditId, actor);
    if (!detail.review.required || detail.review.revision !== input.revision
      || detail.review.reviewHash !== input.reviewHash
      || detail.capabilities.correctionBlockedReason) throw invalid("REVIEW_CHANGED",
        "La revisión cambió o no admite una firma inicial. Actualiza el expediente.");
    await assertNoOtherSignature(db, creditId);
    const source = await frozenSource(db, credit);
    await db.$queryRawUnsafe(`SELECT public.credit_approval_invalidate($1, 'INITIAL_SIGNATURE_REQUESTED')`, creditId);
    const review = await db.$queryRawUnsafe<Array<{ revision: number; status: string }>>(
      `SELECT "revision","status" FROM "CreditApprovalReview" WHERE "creditoId"=$1 FOR UPDATE`, creditId);
    if (review[0]?.status !== "PENDING" || review[0].revision !== input.revision + 1)
      throw invalid("APPROVAL_INVALIDATION_FAILED", "No se pudo reabrir la revisión. No se envió la firma.", 503);
    await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalInitialSignature"
      ("id","creditoId","sourceRevision","sourceReviewHash","reservedRevision","termsHash",
       "frozenCredit","sourceSeal","reason","actorUserId","actorName","status")
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,'PREPARING')`,
      input.id, creditId, input.revision, input.reviewHash, review[0].revision, source.termsHash,
      JSON.stringify(source.contract), JSON.stringify(source.seal), input.reason, actor.id, actor.nombre);
    return { operation: (await operationById(db, input.id))!, dispatch: true };
  }, { timeout: 20000 });
  if (!reserved.dispatch) return publicOperation(reserved.operation);

  let claimed = false;
  try {
    const document = await buildFirmaSeguroCreditPdf(reserved.operation.frozenCredit);
    if (document.length > 32 * 1024 * 1024 || document.subarray(0, 5).toString() !== "%PDF-")
      throw new Error("INVALID_INITIAL_PDF");
    const { prepareFirmaSeguroReissue } = await import("@/lib/firmaseguro-credit");
    const prepared = await prepareFirmaSeguroReissue(reserved.operation.frozenCredit, document, input.id);
    const ready = await prisma.$transaction(async (db) => {
      const credit = await creditForSignature(db, creditId);
      const review = await db.$queryRawUnsafe<Array<{ revision: number; status: string }>>(
        `SELECT "revision","status" FROM "CreditApprovalReview" WHERE "creditoId"=$1 FOR UPDATE`, creditId);
      const operation = await operationById(db, input.id);
      if (!operation || operation.status !== "PREPARING" || review[0]?.status !== "PENDING"
        || review[0].revision !== operation.reservedRevision) return false;
      const source = await frozenSource(db, credit);
      if (source.termsHash !== operation.termsHash
        || JSON.stringify(canonical(source.contract)) !== JSON.stringify(canonical(operation.frozenCredit))) return false;
      const active = await db.$queryRawUnsafe<Array<{ id: number }>>(
        `SELECT "id" FROM "FirmaSeguroProcess" WHERE "creditoId"=$1 AND "supersededAt" IS NULL LIMIT 1`, creditId);
      if (active.length) return false;
      const changed = await db.$executeRawUnsafe(`UPDATE "CreditApprovalInitialSignature"
        SET "status"='DISPATCHING',"documentBase64"=$2,"documentHash"=$3,
          "requestPayload"=$4::jsonb,"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE "id"=$1::uuid AND "status"='PREPARING'`,
        input.id, document.toString("base64"), digest(document), JSON.stringify(prepared.requestPayload));
      return changed === 1;
    }, { timeout: 20000 });
    if (!ready) throw new Error("INITIAL_SOURCE_CHANGED");
    claimed = true;
    const sent = await prepared.sendOnce();
    await prisma.$transaction(async (db) => {
      await creditForSignature(db, creditId);
      const operation = await operationById(db, input.id);
      if (!operation || !["DISPATCHING", "UNCERTAIN"].includes(operation.status))
        throw new Error("INITIAL_BINDING_CHANGED");
      const active = await db.$queryRawUnsafe<Array<{ id: number }>>(
        `SELECT "id" FROM "FirmaSeguroProcess" WHERE "creditoId"=$1 AND "supersededAt" IS NULL LIMIT 1`, creditId);
      if (active.length) throw new Error("INITIAL_ACTIVE_PROCESS_CHANGED");
      await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroProcess"
        ("creditoId","draftFolio","draftPayload","processUuid","status","requestPayload","createPayload",
         "createdAt","updatedAt")
        VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7::jsonb,
          CURRENT_TIMESTAMP AT TIME ZONE 'UTC',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
        creditId, operation.frozenCredit.folio,
        JSON.stringify({ financialTermsSeal: operation.sourceSeal, initialApprovalSignatureId: input.id }),
        sent.processUuid, sent.status, JSON.stringify(prepared.requestPayload), JSON.stringify(sent.createPayload));
      await db.$executeRawUnsafe(`UPDATE "CreditApprovalInitialSignature"
        SET "status"='AWAITING_SIGNATURE',"processUuid"=$2,
          "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE "id"=$1::uuid AND "status" IN ('DISPATCHING','UNCERTAIN')`, input.id, sent.processUuid);
    }, { timeout: 20000 });
  } catch {
    await prisma.$transaction(async (db) => {
      await creditForSignature(db, creditId);
      await db.$executeRawUnsafe(`UPDATE "CreditApprovalInitialSignature"
        SET "status"=$2,"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE "id"=$1::uuid AND "status"=$3`,
        input.id, claimed ? "UNCERTAIN" : "FAILED_SAFE", claimed ? "DISPATCHING" : "PREPARING");
    });
  }
  return publicOperation((await operationById(prisma, input.id))!);
}

/** A provider callback may confirm an initial signature; dispatch alone never does. */
export async function completeInitialApprovalSignature(db: Db, creditId: number,
  processUuid: string, signedDocumentBase64: string | null) {
  const exists = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('public."CreditApprovalInitialSignature"') IS NOT NULL AS present`);
  if (!exists[0]?.present) return false;
  const signed = signedDocumentBase64
    && Buffer.from(signedDocumentBase64, "base64").subarray(0, 5).toString() === "%PDF-";
  if (!signed) return false;
  const completed = await db.$executeRawUnsafe(`UPDATE "CreditApprovalInitialSignature"
    SET "status"='COMPLETED',"completedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    WHERE "creditoId"=$1 AND "processUuid"=$2
      AND "status" IN ('AWAITING_SIGNATURE','UNCERTAIN','TECHNICAL_ERROR')`, creditId, processUuid);
  return completed === 1;
}

/** Terminal provider outcomes are displayed as technical review, never as credit rejection. */
export async function markInitialApprovalSignatureTerminalFailure(db: Db, creditId: number,
  processUuid: string, providerStatus: string | null) {
  if (!isVerifiedTerminalSignatureFailure(providerStatus)) return false;
  const exists = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('public."CreditApprovalInitialSignature"') IS NOT NULL AS present`);
  if (!exists[0]?.present) return false;
  const changed = await db.$executeRawUnsafe(`UPDATE "CreditApprovalInitialSignature" operation
    SET "status"='TECHNICAL_ERROR',"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    WHERE operation."creditoId"=$1 AND operation."processUuid"=$2
      AND operation."status"='AWAITING_SIGNATURE'
      AND EXISTS (SELECT 1 FROM "FirmaSeguroProcess" process
        WHERE process."creditoId"=$1 AND process."processUuid"=$2
          AND process."supersededAt" IS NULL AND process."signedDocumentBase64" IS NULL
          AND process."completedAt" IS NULL)`, creditId, processUuid);
  return changed === 1;
}
