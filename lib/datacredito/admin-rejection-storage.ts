import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { lockSolicitudOperationMutation } from "@/lib/firmaseguro-storage";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
import { buildDataCreditoIdentityHashes, ensureDataCreditoSchema, type DataCreditoAssessmentRow } from "./storage";
import { decryptDataCreditoSecureRecord, type DecryptDataCreditoSecureRecordInput } from "./secure-record";

const ACTION = "ADMIN_REJECT_NO_EVALUABLE";
const OUTCOME = "REJECTED_BY_FINSER";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Database = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export type DataCreditoAdministrativeRejection = {
  id: string; assessmentId: string; solicitudId: number; actorUserId: number;
  reason: string; rejectedAt: string; expiresAt: string;
  source: "FINSER_ADMIN"; status: "RECHAZADA";
};
type AuditRow = { id: string; assessmentId: string; actorUserId: number; createdAt: Date;
  metadata: Record<string, unknown>; action: string; outcome: string };
type DraftRow = { id: number; estado: string; closedReason: string | null; closedAt: Date | null; currentStep: number; creditoId: number | null;
  usuarioId: number; vendedorId: number | null; sedeId: number; aliadoId: number | null;
  clienteDocumento: string; plataforma: string; imei: string | null; dataCreditoAssessmentId: string | null;
  creditRiskExceptionId: string | null; payload: Record<string, unknown>; effectiveExpiresAt: Date };

export class DataCreditoAdministrativeRejectionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = "DataCreditoAdministrativeRejectionError";
  }
}
function fail(code: string, message: string, status = 409): never {
  throw new DataCreditoAdministrativeRejectionError(code, message, status);
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function iso(value: unknown) {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = new Date(value as string | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function parseAudit(row: AuditRow | undefined): DataCreditoAdministrativeRejection | null {
  if (!row || row.action !== ACTION || row.outcome !== OUTCOME || row.metadata?.version !== 1) return null;
  const m = row.metadata, rejectedAt = iso(row.createdAt), expiresAt = iso(m.expiresAt);
  if (!UUID.test(row.id) || !UUID.test(row.assessmentId) || !rejectedAt || !expiresAt ||
      !Number.isSafeInteger(m.solicitudId) || Number(m.solicitudId) < 1 || !Number.isSafeInteger(row.actorUserId) ||
      typeof m.reason !== "string" || m.reason.length < 10 || m.reason.length > 500 ||
      m.reviewed !== true || m.confirmed !== true || typeof m.requestHash !== "string") return null;
  return { id: row.id, assessmentId: row.assessmentId, solicitudId: Number(m.solicitudId), actorUserId: row.actorUserId,
    reason: m.reason, rejectedAt, expiresAt, source: "FINSER_ADMIN", status: "RECHAZADA" };
}

/** An internal decision never changes the original provider result or score. */
export async function getDataCreditoAdministrativeRejection(
  input: { assessmentId: string; solicitudId?: number }, db: Database = prisma
) {
  if (!UUID.test(input.assessmentId)) return null;
  if (db === prisma) await ensureDataCreditoSchema();
  const rows = await db.$queryRawUnsafe<AuditRow[]>(`
    SELECT audit.* FROM "DataCreditoAdminAccessAudit" audit
    JOIN "DataCreditoAssessment" a ON a."id"=audit."assessmentId"
    WHERE audit."assessmentId"=$1::uuid AND audit."action"=$2 AND audit."outcome"=$3
      AND audit."retainedUntil">clock_timestamp() AND a."retainedUntil">clock_timestamp()
    ORDER BY audit."createdAt" DESC LIMIT 1`, input.assessmentId, ACTION, OUTCOME);
  const decision = parseAudit(rows[0]);
  return decision && (!input.solicitudId || decision.solicitudId === input.solicitudId) ? decision : null;
}

export async function findRecentDataCreditoAdministrativeRejection(
  input: { documentHash: string; providerEnvironment: string }, db: Database = prisma
) {
  if (db === prisma) await ensureDataCreditoSchema();
  const rows = await db.$queryRawUnsafe<AuditRow[]>(`
    SELECT audit.* FROM "DataCreditoAdminAccessAudit" audit
    JOIN "DataCreditoAssessment" a ON a."id"=audit."assessmentId"
    WHERE a."documentHash"=$1 AND a."providerEnvironment"=$2
      AND audit."action"=$3 AND audit."outcome"=$4
      AND audit."metadata"->>'documentHash'=a."documentHash"
      AND audit."metadata"->>'providerEnvironment'=a."providerEnvironment"
      AND a."status"='NO_EVALUADO' AND a."errorCode"='NO_EVALUABLE_INFORMATION'
      AND a."expiresAt">clock_timestamp() AND audit."retainedUntil">clock_timestamp()
    ORDER BY audit."createdAt" DESC LIMIT 25`, input.documentHash, input.providerEnvironment, ACTION, OUTCOME);
  for (const row of rows) {
    const decision = parseAudit(row);
    if (decision && new Date(decision.expiresAt).getTime() > Date.now()) return decision;
  }
  return null;
}

function sourceCode(payload: Record<string, unknown>, key: string) {
  const content = record(payload.content), transaction = record(content?.infoTransaccion);
  const codes = transaction?.codigosRespuesta;
  if (!Array.isArray(codes)) return null;
  const matches = codes.map(record).filter(item => item?.clave === key);
  return matches.length === 1 && typeof matches[0]?.valor === "string" ? matches[0].valor : null;
}
async function sourceIsNotEvaluable(db: Database, assessment: DataCreditoAssessmentRow, documentNumber: string) {
  const rows = await db.$queryRawUnsafe<DecryptDataCreditoSecureRecordInput[]>(`
    SELECT secure.*, a."id" AS "assessmentId",a."correlationId"
    FROM "DataCreditoAssessmentSecurePayload" secure JOIN "DataCreditoAssessment" a ON a."id"=secure."assessmentId"
    WHERE a."id"=$1::uuid AND a."retainedUntil">clock_timestamp()`, assessment.id);
  if (!rows[0]) return false;
  const source = decryptDataCreditoSecureRecord(rows[0]);
  const hashes = buildDataCreditoIdentityHashes({ documentNumber: source.documentNumber, firstSurname: source.firstSurname });
  const payload = record(source.providerPayload), response = record(record(payload?.content)?.respuesta);
  return source.documentNumber === documentNumber && hashes.documentHash === assessment.documentHash &&
    hashes.surnameHash === assessment.surnameHash && payload?.status === "ACCEPTED" &&
    sourceCode(payload, "TX") === "07" && sourceCode(payload, "HC") === "09" &&
    (!response || !Object.prototype.hasOwnProperty.call(response, "informacionRiesgo") || response.informacionRiesgo === null);
}
function assessmentEligible(a: DataCreditoAssessmentRow) {
  const now = Date.now();
  return a.status === "NO_EVALUADO" && a.errorCode === "NO_EVALUABLE_INFORMATION" &&
    a.providerStatus === "ACCEPTED" && a.transactionCode === "07" && a.score === null &&
    a.decision === null && a.offer === null && !a.reusedFromAssessmentId && !a.consumedAt && !a.creditId &&
    !a.claimTokenHash && !a.claimExpiresAt && a.durationMs !== null &&
    new Date(a.expiresAt).getTime() > now && new Date(a.retainedUntil).getTime() > now;
}
async function loadAssessment(db: Database, id: string, lock = false) {
  return (await db.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `SELECT * FROM "DataCreditoAssessment" WHERE "id"=$1::uuid ${lock ? "FOR UPDATE" : ""}`, id))[0];
}
async function loadDraft(db: Database, assessmentId: string, solicitudId?: number, lock = false) {
  const rows = await db.$queryRawUnsafe<DraftRow[]>(`
    SELECT d.*,s."aliadoId",COALESCE(d."expiresAt",d."createdAt"+INTERVAL '15 days') AS "effectiveExpiresAt"
    FROM "CreditoBorrador" d JOIN "Sede" s ON s."id"=d."sedeId"
    WHERE d."dataCreditoAssessmentId"=$1::uuid AND ($2::integer IS NULL OR d."id"=$2)
    ORDER BY d."id" DESC LIMIT 2 ${lock ? "FOR UPDATE OF d" : ""}`, assessmentId, solicitudId ?? null);
  return rows.length === 1 ? rows[0] : null;
}
function draftEligible(d: DraftRow, a: DataCreditoAssessmentRow, document: string) {
  const reviewableState = d.estado === "ABIERTO" || (d.estado === "CERRADO" && ["DESISTIDA", "DESISTIDO"].includes(d.closedReason || ""));
  return reviewableState && Number(d.currentStep) === 1 && !d.creditoId && !d.creditRiskExceptionId &&
    !String(d.imei || "").trim() && !String(d.payload?.imei || "").trim() && !String(d.payload?.deviceUid || "").trim() &&
    d.clienteDocumento === document && d.usuarioId === a.userId && d.vendedorId === a.sellerId &&
    d.sedeId === a.sedeId && d.aliadoId === a.aliadoId && d.dataCreditoAssessmentId === a.id &&
    (!d.payload?.dataCreditoAssessmentId || d.payload.dataCreditoAssessmentId === a.id) &&
    String(d.plataforma || d.payload?.plataformaDispositivo || "").toUpperCase() === a.platform &&
    new Date(d.effectiveExpiresAt).getTime() > Date.now();
}
async function hasCompetingOperation(db: Database, a: DataCreditoAssessmentRow, draftId: number) {
  const rows = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(`SELECT (
    EXISTS(SELECT 1 FROM "DataCreditoAdminAccessAudit" x WHERE x."assessmentId"=$1::uuid AND
      x."action" IN ('OPS_TX06_RETRY_AUTHORIZED','OPS_NO_EVALUABLE_RETRY_AUTH','OPS_RETRY_AUTHORIZED'))
    OR EXISTS(SELECT 1 FROM "CreditRiskException" x WHERE x."assessmentId"=$1::uuid OR x."solicitudId"=$2)
    OR EXISTS(SELECT 1 FROM "FirmaSeguroProcess" f WHERE f."draftId"=$2)
    OR EXISTS(SELECT 1 FROM "VeriffIdentityValidation" v WHERE v."draftId"=$2)
    OR EXISTS(SELECT 1 FROM "DataCreditoAssessment" x WHERE x."documentHash"=$3 AND x."providerEnvironment"=$4 AND x."id"<>$1::uuid
      AND (x."creditId" IS NOT NULL OR x."consumedAt" IS NOT NULL OR x."claimTokenHash" IS NOT NULL OR
        (x."expiresAt">clock_timestamp() AND x."status" IN ('PENDING','APROBADO','RECHAZADO'))))
    ) AS blocked`, a.id, draftId, a.documentHash, a.providerEnvironment);
  return rows[0]?.blocked !== false;
}

export async function getDataCreditoAdministrativeRejectionCandidate(input: {
  assessmentId: string; documentNumber: string; providerEnvironment: string; solicitudId?: number;
}) {
  const unavailable = { eligible: false, eligibilityMessage: "La consulta no cumple las condiciones para rechazo administrativo.", decision: null as DataCreditoAdministrativeRejection | null, solicitudId: input.solicitudId ?? null };
  if (!UUID.test(input.assessmentId) || !/^\d{3,13}$/.test(input.documentNumber)) return unavailable;
  await Promise.all([ensureDataCreditoSchema(), ensureSolicitudSchema()]);
  const a = await loadAssessment(prisma, input.assessmentId);
  if (!a || a.providerEnvironment !== input.providerEnvironment) return unavailable;
  const decision = await getDataCreditoAdministrativeRejection({ assessmentId: a.id });
  const d = await loadDraft(prisma, a.id, input.solicitudId);
  if (!d || d.clienteDocumento !== input.documentNumber) return unavailable;
  if (decision) return { eligible: false, eligibilityMessage: "Solicitud rechazada por revisión administrativa de FINSER PAY.", decision, solicitudId: decision.solicitudId };
  if (!assessmentEligible(a) || !draftEligible(d, a, input.documentNumber) ||
      await hasCompetingOperation(prisma, a, d.id) || !await sourceIsNotEvaluable(prisma, a, input.documentNumber)) return { ...unavailable, solicitudId: d.id };
  return { eligible: true, eligibilityMessage: "Sin puntaje ni información de riesgo evaluable. El administrador central puede rechazar la solicitud después de revisar el expediente.", decision: null, solicitudId: d.id };
}

export async function rejectDataCreditoAdministratively(input: {
  assessmentId: unknown; solicitudId: unknown; documentNumber: unknown; providerEnvironment: string;
  actorUserId: number; reason: unknown; reviewed: unknown; confirmed: unknown; mutationId: unknown;
  ipHash?: string | null; userAgentHash?: string | null;
}) {
  const assessmentId = String(input.assessmentId || "").toLowerCase(), mutationId = String(input.mutationId || "").toLowerCase();
  const document = typeof input.documentNumber === "string" ? input.documentNumber : "";
  const reason = typeof input.reason === "string" ? input.reason.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!UUID.test(assessmentId) || !UUID.test(mutationId) || !Number.isSafeInteger(input.solicitudId) || Number(input.solicitudId) < 1 ||
      !/^\d{3,13}$/.test(document) || input.reviewed !== true || input.confirmed !== true || reason.length < 10 || reason.length > 500) {
    fail("INVALID_ADMINISTRATIVE_REJECTION", "Revisa la cédula y la solicitud, confirma la revisión y escribe un motivo de 10 a 500 caracteres.", 400);
  }
  const solicitudId = Number(input.solicitudId);
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId < 1) {
    fail("CENTRAL_ADMIN_REQUIRED", "No fue posible identificar al administrador central.", 403);
  }
  await Promise.all([ensureDataCreditoSchema(), ensureSolicitudSchema()]);
  const preliminary = await loadAssessment(prisma, assessmentId);
  if (!preliminary || preliminary.providerEnvironment !== input.providerEnvironment) fail("ASSESSMENT_NOT_FOUND", "Consulta no encontrada.", 404);
  const requestHash = createHash("sha256").update(JSON.stringify([assessmentId, solicitudId, document, input.providerEnvironment, input.actorUserId, reason, true, true])).digest("hex");
  return prisma.$transaction(async db => {
    // Same order as evaluation, signature dispatch and TX06 release.
    await lockSolicitudOperationMutation(db, solicitudId);
    await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0::bigint))", `datacredito-document:${input.providerEnvironment}:${preliminary.documentHash}`);
    const actors = await db.$queryRawUnsafe<Array<{ id: number }>>(`SELECT u."id" FROM "Usuario" u JOIN "Rol" r ON r."id"=u."rolId"
      JOIN "Sede" s ON s."id"=u."sedeId" JOIN "Aliado" a ON a."id"=s."aliadoId"
      WHERE u."id"=$1 AND u."activo"=TRUE AND s."activa"=TRUE AND a."activo"=TRUE
      AND UPPER(r."nombre")='ADMIN' AND UPPER(a."codigo")='FINSERPAY' FOR SHARE OF u,s,a`, input.actorUserId);
    if (!actors[0]) fail("CENTRAL_ADMIN_REQUIRED", "Solo el administrador central puede registrar este rechazo.", 403);
    const replay = (await db.$queryRawUnsafe<AuditRow[]>(`SELECT * FROM "DataCreditoAdminAccessAudit" WHERE "id"=$1::uuid FOR UPDATE`, mutationId))[0];
    if (replay) {
      const rejection = parseAudit(replay);
      if (!rejection || replay.metadata.requestHash !== requestHash) fail("ADMINISTRATIVE_REJECTION_CONFLICT", "Este intento corresponde a otra operación.");
      return { rejection, idempotent: true };
    }
    const a = await loadAssessment(db, assessmentId, true);
    const existing = (await db.$queryRawUnsafe<AuditRow[]>(`SELECT * FROM "DataCreditoAdminAccessAudit" WHERE "assessmentId"=$1::uuid AND "action"=$2 AND "outcome"=$3 ORDER BY "createdAt" DESC LIMIT 1`, assessmentId, ACTION, OUTCOME))[0];
    if (existing) {
      const rejection = parseAudit(existing);
      if (!rejection || existing.metadata.requestHash !== requestHash) fail("ADMINISTRATIVE_REJECTION_CONFLICT", "La consulta ya tiene una decisión administrativa. Vuelve a consultarla.");
      return { rejection, idempotent: true };
    }
    const d = await loadDraft(db, assessmentId, solicitudId, true);
    if (!a || a.documentHash !== preliminary.documentHash || a.providerEnvironment !== input.providerEnvironment || !assessmentEligible(a) ||
      !d || !draftEligible(d, a, document) || await hasCompetingOperation(db, a, solicitudId) || !await sourceIsNotEvaluable(db, a, document)) {
      fail("ADMINISTRATIVE_REJECTION_NOT_ELIGIBLE", "La consulta o la solicitud cambió. Revisa el expediente antes de decidir.");
    }
    const now = (await db.$queryRawUnsafe<Array<{ now: Date }>>('SELECT clock_timestamp() AS now'))[0].now;
    const metadata = { version: 1, requestHash, solicitudId, documentHash: a.documentHash, providerEnvironment: a.providerEnvironment,
      reason, reviewed: true, confirmed: true, expiresAt: new Date(a.expiresAt).toISOString(), source: "FINSER_ADMIN",
      previousDraft: { estado: d.estado, closedReason: d.closedReason, closedAt: d.closedAt ? iso(d.closedAt) : null } };
    await db.$executeRawUnsafe(`INSERT INTO "DataCreditoAdminAccessAudit"
      ("id","assessmentId","actorUserId","action","outcome","requestCorrelationId","ipHash","userAgentHash","retainedUntil","createdAt","metadata")
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$1::uuid,$6,$7,$8::timestamp,$9::timestamp,$10::jsonb)`,
      mutationId, assessmentId, input.actorUserId, ACTION, OUTCOME, input.ipHash ?? null, input.userAgentHash ?? null, a.retainedUntil, now, JSON.stringify(metadata));
    const closed = await db.$queryRawUnsafe<Array<{ id: number }>>(`UPDATE "CreditoBorrador" SET "estado"='CERRADO',"closedReason"='RECHAZADA',
      "closedAt"=$3::timestamp,"updatedAt"=$3::timestamp,"payload"=COALESCE("payload",'{}'::jsonb)||jsonb_build_object(
        'administrativeRejectionId',$4::text,'administrativeRejectionSource','FINSER_ADMIN','administrativeRejectionReason',$5::text)
      WHERE "id"=$1 AND "dataCreditoAssessmentId"=$2::uuid
        AND ("estado"='ABIERTO' OR ("estado"='CERRADO' AND "closedReason" IN ('DESISTIDA','DESISTIDO')))
        AND "currentStep"=1 AND "creditoId" IS NULL RETURNING "id"`,
      solicitudId, assessmentId, now, mutationId, reason);
    if (closed.length !== 1) fail("ADMINISTRATIVE_REJECTION_STATE_CHANGED", "La solicitud cambió y no fue rechazada. Vuelve a consultarla.");
    const rejection = parseAudit({ id: mutationId, assessmentId, actorUserId: input.actorUserId, action: ACTION, outcome: OUTCOME, createdAt: now, metadata });
    if (!rejection) throw new Error("ADMINISTRATIVE_REJECTION_AUDIT_INVALID");
    return { rejection, idempotent: false };
  }, { maxWait: 5_000, timeout: 30_000 });
}
