import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
import { ensureFirmaSeguroSchema, lockSolicitudOperationMutation } from "@/lib/firmaseguro-storage";
import { getUnresolvedDraftDispatch } from "@/lib/firmaseguro-draft-dispatch-ledger";
import { ensureVeriffSchema, isVeriffApproved, serializeVeriffValidation, type VeriffValidationRow } from "@/lib/veriff-storage";
import { extractVeriffIdentityData } from "@/lib/veriff";
import { isFirmaSeguroVerifiedCompletedStatus } from "@/lib/firmaseguro-status";
import { compareStrictIdentityDocuments } from "@/lib/veriff-identity";
import { getDataCreditoPublicConfig } from "@/lib/datacredito";
import { getApprovedDataCreditoAssessmentForCredit } from "./storage";
import { enforceDataCreditoCustomerIdentity } from "./customer-identity";
import { resolveReviewedFirmaSeguroFullNameIdentity } from "./firmaseguro-identity";

type Database = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type Draft = { id: number; estado: string; creditoId: number | null; usuarioId: number; vendedorId: number | null;
  sedeId: number; aliadoId: number | null; clienteDocumento: string | null; plataforma: string | null;
  dataCreditoAssessmentId: string | null; payload: unknown; currentStep: number; createdAt: Date; expiresAt: Date | null };
type Review = { id: string; draftId: number; assessmentId: string; validationId: number; documentHash: string;
  canonicalFullName: string; firstNames: string; firstSurname: string; secondSurname: string;
  actorUserId: number; actorName: string; reason: string; inputHash: string; createdAt: Date };
export type FirmaSeguroIdentityReviewActor = { id: number; nombre: string; admin: boolean; central: boolean; aliadoId: number | null };
export class FirmaSeguroIdentityReviewError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = "FirmaSeguroIdentityReviewError"; }
}
const fail = (code: string, message: string, status = 409): never => { throw new FirmaSeguroIdentityReviewError(code, message, status); };
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === "string" ? v.normalize("NFC").replace(/\s+/g, " ").trim() : "";
const comparable = (v: unknown) => text(v).toLocaleUpperCase("es-CO");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
let schema: Promise<void> | undefined;
export function ensureFirmaSeguroIdentityReviewSchema() {
  return schema ??= (async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "FirmaSeguroIdentityReview" (
      "id" UUID PRIMARY KEY, "draftId" INTEGER NOT NULL, "assessmentId" UUID NOT NULL,
      "validationId" INTEGER NOT NULL, "documentHash" TEXT NOT NULL, "canonicalFullName" TEXT NOT NULL,
      "firstNames" TEXT NOT NULL, "firstSurname" TEXT NOT NULL, "secondSurname" TEXT NOT NULL,
      "actorUserId" INTEGER NOT NULL, "actorName" TEXT NOT NULL, "reason" TEXT NOT NULL,
      "attestation" BOOLEAN NOT NULL CHECK ("attestation" = TRUE), "inputHash" TEXT NOT NULL,
      "original" JSONB NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("draftId", "assessmentId", "validationId"),
      CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500))`);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "FinserRejectFirmaSeguroIdentityReviewMutation"()
      RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'FirmaSeguro identity reviews are immutable'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgname='FirmaSeguroIdentityReview_immutable' AND tgrelid='"FirmaSeguroIdentityReview"'::regclass AND NOT tgisinternal) THEN
      CREATE TRIGGER "FirmaSeguroIdentityReview_immutable" BEFORE UPDATE OR DELETE ON "FirmaSeguroIdentityReview"
      FOR EACH ROW EXECUTE FUNCTION "FinserRejectFirmaSeguroIdentityReviewMutation"(); END IF; END $$`);
  })().catch(error => { schema = undefined; throw error; });
}
async function readDraft(db: Database, draftId: number, lock = false) {
  const rows = await db.$queryRawUnsafe<Draft[]>(`SELECT d.*, s."aliadoId" FROM "CreditoBorrador" d
    LEFT JOIN "Sede" s ON s."id"=d."sedeId" WHERE d."id"=$1 ${lock ? 'FOR UPDATE OF d' : ''}`, draftId);
  return rows[0] || null;
}
function mayReview(actor: FirmaSeguroIdentityReviewActor, draft: Draft) {
  return actor.admin && (actor.central || (actor.aliadoId !== null && actor.aliadoId === draft.aliadoId));
}
async function context(db: Database, draft: Draft, mutation = false) {
  if (draft.estado !== "ABIERTO" || draft.creditoId ||
    new Date(draft.expiresAt || new Date(new Date(draft.createdAt).getTime() + 15 * 86400000)).getTime() <= Date.now()) {
    fail("FIRMASEGURO_REVIEW_DRAFT_CLOSED", "La solicitud ya no está abierta para esta revisión.");
  }
  if (draft.currentStep < 4) fail("FIRMASEGURO_REVIEW_STEP_NOT_READY", "Completa el cliente y el equipo antes de revisar al firmante.");
  const payload = { ...record(draft.payload) };
  const assessmentId = draft.dataCreditoAssessmentId || text(payload.dataCreditoAssessmentId);
  if (!assessmentId || text(payload.dataCreditoAssessmentId) !== assessmentId) fail("FIRMASEGURO_REVIEW_ASSESSMENT_CHANGED", "La consulta vinculada cambió; actualiza la solicitud.");
  const scope = { userId: draft.usuarioId, sellerId: draft.vendedorId, sedeId: draft.sedeId, aliadoId: draft.aliadoId };
  const identity = await enforceDataCreditoCustomerIdentity(payload, scope, false);
  if (!identity || identity.effective.nameMode !== "FULL_NAME_ONLY" || !identity.effective.fullName) {
    throw new FirmaSeguroIdentityReviewError("FIRMASEGURO_REVIEW_NOT_APPLICABLE", "Esta revisión sólo completa los componentes de un nombre completo de DataCrédito.");
  }
  const documentNumber = text(draft.clienteDocumento).replace(/\D/g, "");
  if (!compareStrictIdentityDocuments(payload.clienteDocumento, documentNumber).ok) fail("FIRMASEGURO_REVIEW_DOCUMENT_CHANGED", "La cédula de la solicitud cambió.");
  const config = getDataCreditoPublicConfig();
  const platform = text(draft.plataforma || payload.plataformaDispositivo).toUpperCase();
  if (!config.enabled || (platform !== "ANDROID" && platform !== "IPHONE") || !await getApprovedDataCreditoAssessmentForCredit({
    assessmentId, documentNumber, firstSurname: identity.querySurname, platform,
    providerEnvironment: config.environment, ...scope,
  })) fail("FIRMASEGURO_REVIEW_ASSESSMENT_INVALID", "La consulta aprobada no está vigente para esta solicitud.");
  const rows = await db.$queryRawUnsafe<VeriffValidationRow[]>(`SELECT * FROM "VeriffIdentityValidation"
    WHERE "draftId"=$1 AND "creditoId" IS NULL ORDER BY "id" DESC LIMIT 1 ${mutation ? 'FOR UPDATE' : ''}`, draft.id);
  const validation = rows[0];
  const serialized = validation ? serializeVeriffValidation(validation) : null;
  if (!validation || !isVeriffApproved(validation) || validation.draftId !== draft.id || validation.creditoId ||
    Number(payload.veriffValidationId) !== validation.id || !compareStrictIdentityDocuments(validation.clienteDocumento, documentNumber).ok ||
    serialized?.identityDocumentStatus !== "match" || !compareStrictIdentityDocuments(serialized.identityDocumentNumber, documentNumber).ok) {
    fail("FIRMASEGURO_REVIEW_VERIFF_REQUIRED", "Se requiere la última aprobación Veriff confiable para esta misma cédula y solicitud.");
  }
  for (const evidence of [extractVeriffIdentityData(validation.decisionPayload), extractVeriffIdentityData(validation.webhookPayload)]) {
    if (evidence && (text(evidence.firstName) || text(evidence.lastName) ||
      (text(evidence.fullName) && comparable(evidence.fullName) !== comparable(identity.effective.fullName)))) {
      fail("FIRMASEGURO_REVIEW_PROVIDER_COMPONENTS", "Veriff entregó componentes o identidad contradictoria. Requiere revisar esa evidencia; esta opción no la reemplaza.");
    }
  }
  return { draft, assessmentId, identity, validation, documentNumber, documentHash: hash(documentNumber), canonicalFullName: identity.effective.fullName };
}
async function latestReview(db: Database, draftId: number, assessmentId: string) {
  const rows = await db.$queryRawUnsafe<Review[]>(`SELECT * FROM "FirmaSeguroIdentityReview"
    WHERE "draftId"=$1 AND "assessmentId"=$2::uuid ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, draftId, assessmentId);
  return rows[0] || null;
}
function metadata(ctx: Awaited<ReturnType<typeof context>>, review: Review) {
  if (review.draftId !== ctx.draft.id || review.assessmentId !== ctx.assessmentId || review.validationId !== ctx.validation.id ||
      review.documentHash !== ctx.documentHash || review.canonicalFullName !== ctx.canonicalFullName) return null;
  return resolveReviewedFirmaSeguroFullNameIdentity({ fullName: ctx.canonicalFullName, documentNumber: ctx.documentNumber,
    reviewId: review.id, validationId: review.validationId, reviewedDocumentNumber: ctx.documentNumber,
    firstNames: review.firstNames, firstSurname: review.firstSurname, secondSurname: review.secondSurname });
}
async function assertUnsignedIdle(db: Database, draftId: number) {
  const processes = await db.$queryRawUnsafe<Array<{ completedAt: Date | null; signedDocumentBase64: string | null; status: string; supersededAt: Date | null }>>(`SELECT "completedAt", "signedDocumentBase64", "status", "supersededAt" FROM "FirmaSeguroProcess"
    WHERE "draftId"=$1`, draftId);
  if (processes.some(row => row.supersededAt === null || row.completedAt || row.signedDocumentBase64 || isFirmaSeguroVerifiedCompletedStatus(row.status)) || await getUnresolvedDraftDispatch(draftId, db as Prisma.TransactionClient)) {
    fail("FIRMASEGURO_REVIEW_SIGNING_ACTIVE", "Ya existe una firma o un envío pendiente. Concílialo antes de revisar los componentes.");
  }
}
function publicReview(review: Review | null) {
  return review ? { id: review.id, source: "AUTHORIZED_REVIEW" as const, firstNames: review.firstNames,
    firstSurname: review.firstSurname, secondSurname: review.secondSurname, actorName: review.actorName,
    createdAt: new Date(review.createdAt).toISOString() } : null;
}
async function prepare() { await Promise.all([ensureSolicitudSchema(), ensureVeriffSchema(), ensureFirmaSeguroSchema(), ensureFirmaSeguroIdentityReviewSchema()]); }
export async function getFirmaSeguroIdentityReviewDetail(draftId: number, actor: FirmaSeguroIdentityReviewActor) {
  await prepare();
  const draft = await readDraft(prisma, draftId);
  if (!draft) fail("FIRMASEGURO_REVIEW_NOT_FOUND", "Solicitud no encontrada.", 404);
  const canReview = mayReview(actor, draft);
  try {
    const ctx = await context(prisma, draft);
    const review = await latestReview(prisma, draftId, ctx.assessmentId);
    const current = review && metadata(ctx, review) ? review : null;
    let idle = true;let reason: string | null = null;
    try { await assertUnsignedIdle(prisma, draftId); } catch (error) { idle = false;reason = error instanceof FirmaSeguroIdentityReviewError ? error.message : "Revisa el envío vigente."; }
    return { draftId, canReview, canSave: canReview && idle && !current, eligible: true,
      canonicalFullName: ctx.canonicalFullName, documentNumber: ctx.documentNumber,
      validationId: ctx.validation.id, assessmentId: ctx.assessmentId,
      providerComponents: { names: ctx.identity.effective.names, firstSurname: ctx.identity.effective.firstSurname, secondSurname: ctx.identity.effective.secondSurname },
      lockedFirstSurname: review?.firstSurname || ctx.identity.effective.firstSurname || "", review: publicReview(current),
      reason: current ? "Los componentes ya quedaron registrados y no pueden reemplazarse." : reason };
  } catch (error) {
    if (!(error instanceof FirmaSeguroIdentityReviewError)) throw error;
    return { draftId, canReview, canSave: false, eligible: false, canonicalFullName: "", documentNumber: text(draft.clienteDocumento),
      validationId: null, assessmentId: draft.dataCreditoAssessmentId,
      providerComponents: { names: "", firstSurname: "", secondSurname: "" }, lockedFirstSurname: "", review: null, reason: error.message };
  }
}
export async function getStoredFirmaSeguroIdentityReview(input: { draftId: number; validationId: number; documentNumber: string; fullName: string }) {
  await prepare();
  const draft = await readDraft(prisma, input.draftId);
  if (!draft) return null;
  const ctx = await context(prisma, draft);
  if (input.validationId !== ctx.validation.id || input.documentNumber !== ctx.documentNumber || input.fullName !== ctx.canonicalFullName) return null;
  const review = await latestReview(prisma, input.draftId, ctx.assessmentId);
  return review ? metadata(ctx, review) : null;
}
export async function saveFirmaSeguroIdentityReview(draftId: number, input: Record<string, unknown>, actor: FirmaSeguroIdentityReviewActor) {
  if (!actor.admin) fail("FIRMASEGURO_REVIEW_FORBIDDEN", "Sólo un administrador puede completar estos componentes.", 403);
  if (Object.keys(input).sort().join(",") !== "attestation,expectedCanonicalFullName,expectedValidationId,firstNames,firstSurname,idempotencyKey,reason,secondSurname" ||
      !uuid(input.idempotencyKey) || input.attestation !== true || typeof input.secondSurname !== "string" ||
      typeof input.expectedValidationId !== "number" || !Number.isSafeInteger(input.expectedValidationId) ||
      typeof input.expectedCanonicalFullName !== "string" || text(input.reason).length < 5 || text(input.reason).length > 500 ||
      /[\u0000-\u001f\u007f]/.test(String(input.reason))) fail("FIRMASEGURO_REVIEW_INPUT_INVALID", "Completa nombres, apellidos, motivo y confirmación de revisión de la cédula.", 400);
  await prepare();
  await prisma.$transaction(async tx => {
    await lockSolicitudOperationMutation(tx, draftId);
    const draft = await readDraft(tx, draftId, true);
    if (!draft || !mayReview(actor, draft)) fail("FIRMASEGURO_REVIEW_FORBIDDEN", "Solicitud no autorizada para este administrador.", 403);
    const ctx = await context(tx, draft, true);
    if (input.expectedValidationId !== ctx.validation.id || input.expectedCanonicalFullName !== ctx.canonicalFullName) {
      fail("FIRMASEGURO_REVIEW_STALE", "La identidad cambió. Actualiza la solicitud antes de guardar.");
    }
    const values = { firstNames: text(input.firstNames), firstSurname: text(input.firstSurname), secondSurname: text(input.secondSurname), reason: text(input.reason) };
    resolveReviewedFirmaSeguroFullNameIdentity({ fullName: ctx.canonicalFullName, documentNumber: ctx.documentNumber,
      reviewId: input.idempotencyKey, validationId: ctx.validation.id, reviewedDocumentNumber: ctx.documentNumber, ...values });
    for (const [field, providerValue] of [["firstNames", ctx.identity.effective.names], ["secondSurname", ctx.identity.effective.secondSurname]] as const) {
      if (providerValue && comparable(values[field]) !== comparable(providerValue)) {
        fail("FIRMASEGURO_REVIEW_PROVIDER_FIELDS_LOCKED", "Los componentes ya entregados por el proveedor permanecen bloqueados.");
      }
    }
    const inputHash = hash(JSON.stringify({ draftId, assessmentId: ctx.assessmentId, validationId: ctx.validation.id,
      canonicalFullName: ctx.canonicalFullName, actorUserId: actor.id, ...values }));
    const duplicate = await tx.$queryRawUnsafe<Review[]>('SELECT * FROM "FirmaSeguroIdentityReview" WHERE "id"=$1::uuid', input.idempotencyKey);
    if (duplicate[0]) {
      if (duplicate[0].inputHash !== inputHash) fail("FIRMASEGURO_REVIEW_IDEMPOTENCY_CONFLICT", "La operación ya se utilizó para otros datos.");
      return;
    }
    await assertUnsignedIdle(tx, draftId);
    const previous = await latestReview(tx, draftId, ctx.assessmentId);
    const lockedSurname = previous?.firstSurname || ctx.identity.effective.firstSurname;
    if (lockedSurname && comparable(values.firstSurname) !== comparable(lockedSurname)) fail("FIRMASEGURO_REVIEW_SURNAME_LOCKED", "El primer apellido ya fue completado y permanece bloqueado.");
    if (previous?.validationId === ctx.validation.id) fail("FIRMASEGURO_REVIEW_ALREADY_COMPLETED", "Los componentes ya quedaron registrados para esta validación.");
    await tx.$executeRawUnsafe(`INSERT INTO "FirmaSeguroIdentityReview"
      ("id","draftId","assessmentId","validationId","documentHash","canonicalFullName","firstNames","firstSurname","secondSurname",
       "actorUserId","actorName","reason","attestation","inputHash","original")
      VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,$13,$14::jsonb)`,
      input.idempotencyKey, draftId, ctx.assessmentId, ctx.validation.id, ctx.documentHash, ctx.canonicalFullName,
      values.firstNames, values.firstSurname, values.secondSurname, actor.id, actor.nombre, values.reason, inputHash, JSON.stringify(ctx.identity));
  });
  return getFirmaSeguroIdentityReviewDetail(draftId, actor);
}