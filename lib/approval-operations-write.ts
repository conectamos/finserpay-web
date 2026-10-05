import "server-only";

import { createHash } from "node:crypto";
import { canDispatchReservedVersion, exactImei, hasVerifiedDraftSignature, isVerifiedTerminalOperationalRetry,
  operationalCreditEligibility, operationalImeiEligibility, operationalDraftCorrectionStatus, operationalProcessToSupersede,
  operationalSignatureLineage,
  operationalFrozenCredit, signedPdfBytes } from "@/lib/approval-operations-core";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ensureApprovalOperationalSchema } from "@/lib/approval-operations-schema";
import {
  completeCreditDeviceReplacement,
  createCreditDeviceReplacement,
  ensureCreditDeviceReplacementSchema,
} from "@/lib/credit-device-replacement-storage";
import { correctFirmaSeguroDraftImei } from "@/lib/firmaseguro-imei-correction";
import { buildFirmaSeguroCreditPdf } from "@/lib/firmaseguro-folio-pdf";
import { prepareFirmaSeguroReissue, refreshFirmaSeguroProcess } from "@/lib/firmaseguro-credit";
import { isFirmaSeguroCompletedStatus } from "@/lib/firmaseguro";
import { isFirmaSeguroFailedStatus } from "@/lib/firmaseguro-status";
import { ensureFirmaSeguroSchema, lockSolicitudOperationMutation, markFirmaSeguroDraftProcessesSuperseded, type FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";
import { frozenReissueCredit, reissueHash } from "@/lib/credit-approval-reissue-source";
import { parseApprovalDataCorrection } from "@/lib/credit-approval-data-core";
import { correctCreditApprovalData } from "@/lib/credit-approval-data";
import { CreditApprovalError, getCreditApprovalDetail } from "@/lib/credit-approval";
import { parseCreditApprovalReissue, requestCreditApprovalReissue } from "@/lib/credit-approval-reissue";
import { requestInitialApprovalSignature } from "@/lib/approval-initial-signature";
import { ensureDraftDispatchSchema, getUnresolvedDraftDispatch } from "@/lib/firmaseguro-draft-dispatch-ledger";
import { requestSafeDraftSignature } from "@/lib/firmaseguro-draft-safe-request";
import type { ApprovalDataCorrectionChainEntry } from "@/lib/credit-approval-data-core";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";

export type OperationalActor = { id: number; nombre: string };
export type OperationalKind = "CREDIT" | "DRAFT";
type Db = typeof prisma | Prisma.TransactionClient;

export class ApprovalOperationalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "ApprovalOperationalError";
  }
}

type Evidence = { name: string; mime: string; data: Buffer; hash: string } | null;
type Credit = Record<string, unknown> & {
  id: number; folio: string; imei: string | null; deviceUid: string | null;
  clienteTelefono: string | null; clienteCorreo: string | null; clienteNombre: string;
  clienteDocumento: string | null; estado: string; contratoSnapshot: unknown;
  platform: string; paidToAlly: boolean; finishedDraft: boolean; hasApprovalReview: boolean;
};
type Draft = { id: number; estado: string; creditoId: number | null; currentStep: number;
  imei: string | null; payload: unknown; expiresAt: Date | null; createdAt: Date };
type Replacement = { id: string; creditId: number; status: string; previousImei: string; newImei: string; reason: string };
type Version = { id: string; creditoId: number; previousProcessUuid: string; supersededProcessUuid: string | null;
  newProcessUuid: string | null;
  status: string; version: number; frozenCredit: CreditForFirmaSeguroPdf; reason: string; replacementId: string | null;
  actorUserId: number; previousImei: string; newImei: string; sentPhone: string | null; sentEmail: string | null;
  documentBase64: string | null; documentHash: string | null; requestPayload: unknown | null;
  requestedAt: Date; updatedAt: Date;
  lastCheckedAt: Date | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PENDING = ["PREPARING", "DISPATCHING", "AWAITING_SIGNATURE", "UNCERTAIN"] as const;
const mimeTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function clean(value: unknown, max = 500) {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, max + 1) : "";
}
function reason(value: unknown) {
  const result = clean(value);
  if (result.length < 5 || result.length > 500 || /[\u0000-\u001f\u007f]/.test(result))
    throw new ApprovalOperationalError("INVALID_REASON", "Describe el motivo en 5 a 500 caracteres.", 400);
  return result;
}
function operationId(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value))
    throw new ApprovalOperationalError("INVALID_OPERATION_ID", "Actualiza el caso antes de confirmar la operación.", 400);
  return value.toLowerCase();
}
function digits(value: unknown) { return String(value ?? "").replace(/\D/g, ""); }
function newImei(value: unknown) {
  if (!exactImei(value))
    throw new ApprovalOperationalError("INVALID_IMEI", "El nuevo IMEI debe tener exactamente 15 dígitos.", 400);
  return value;
}
function sameImei(value: unknown, current: unknown) {
  if (typeof value !== "string" || value !== digits(current))
    throw new ApprovalOperationalError("IMEI_CHANGED", "El IMEI actual cambió. Actualiza el caso antes de continuar.", 409);
}
function assertConfirmed(value: unknown) {
  if (value !== true && value !== "true")
    throw new ApprovalOperationalError("CONFIRMATION_REQUIRED", "Confirma que se generará una nueva versión del contrato antes de enviarla.", 400);
}
function phone(value: unknown) {
  if (typeof value !== "string") throw new ApprovalOperationalError("INVALID_PHONE", "Ingresa un celular colombiano válido.", 400);
  const d = digits(value);
  const normalized = d.length === 12 && d.startsWith("57") ? d.slice(2) : d;
  if (!/^3\d{9}$/.test(normalized)) throw new ApprovalOperationalError("INVALID_PHONE", "Ingresa un celular colombiano válido de 10 dígitos.", 400);
  return normalized;
}
function email(value: unknown) {
  const normalized = clean(value, 254).toLowerCase();
  if (normalized.length < 3 || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    throw new ApprovalOperationalError("INVALID_EMAIL", "Ingresa un correo electrónico válido.", 400);
  return normalized;
}
function assertActor(actor: OperationalActor) {
  if (!Number.isSafeInteger(actor.id) || actor.id < 1 || clean(actor.nombre, 160).length < 1)
    throw new ApprovalOperationalError("UNAUTHORIZED", "Inicia sesión con un usuario de Aprobaciones.", 401);
}
function checkPdf(value: string | null | undefined) {
  return signedPdfBytes(value);
}

export async function parseOperationalEvidence(value: FormDataEntryValue | null): Promise<Evidence> {
  if (!(value instanceof File) || value.size === 0) return null;
  if (value.size > 10 * 1024 * 1024 || !mimeTypes.has(value.type))
    throw new ApprovalOperationalError("INVALID_EVIDENCE", "La evidencia debe ser JPG, PNG o PDF de máximo 10 MB.", 400);
  const data = Buffer.from(await value.arrayBuffer());
  const valid = value.type === "application/pdf" ? data.subarray(0, 5).toString() === "%PDF-"
    : value.type === "image/png" ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!valid) throw new ApprovalOperationalError("INVALID_EVIDENCE", "El archivo no corresponde a su formato declarado.", 400);
  return { name: clean(value.name, 160).replace(/[\\/\r\n]/g, "_") || "evidencia",
    mime: value.type, data, hash: createHash("sha256").update(data).digest("hex") };
}

async function readCredit(db: Db, id: number, lock = false) {
  const rows = await db.$queryRawUnsafe<Credit[]>(`SELECT credit."id",credit."folio",credit."imei",credit."deviceUid",
      credit."clienteNombre",credit."clienteDocumento",credit."clienteTelefono",credit."clienteCorreo",credit."clienteDireccion",
      credit."clienteDepartamento",credit."clienteCiudad",credit."referenciaEquipo",credit."equipoMarca",credit."equipoModelo",
      credit."valorEquipoTotal",credit."cuotaInicial",credit."saldoBaseFinanciado",credit."montoCredito",credit."valorCuota",
      credit."plazoMeses",credit."tasaInteresEa",credit."frecuenciaPago",credit."contratoSnapshot",credit."estado",
      COALESCE(credit."contratoSnapshot" #>> '{equipo,plataforma}', '') AS platform,
      EXISTS (SELECT 1 FROM "LiquidacionAliadoCredito" paid WHERE paid."creditoId"=credit."id") AS "paidToAlly",
      EXISTS (SELECT 1 FROM "CreditoBorrador" draft WHERE draft."creditoId"=credit."id"
        AND draft."estado"='CERRADO' AND draft."closedReason"='FINALIZADA') AS "finishedDraft",
      EXISTS (SELECT 1 FROM "CreditApprovalReview" review
        JOIN "CreditApprovalPolicy" policy ON policy."id"=1
        JOIN "Sede" site ON site."id"=credit."sedeId"
        JOIN "Aliado" ally ON ally."id"=site."aliadoId"
        WHERE review."creditoId"=credit."id" AND review."status" IN ('PENDING','APPROVED')
          AND credit."createdAt">=policy."activatedAt"
          AND UPPER(BTRIM(COALESCE(ally."codigo",'')))<>'FINSERPAY'
          AND NOT (COALESCE(credit."equalityService",'')='IMPORTACION_MASIVA'
            AND COALESCE(credit."contratoSnapshot" #>> '{origen,tipo}','')='IMPORTACION_MASIVA')) AS "hasApprovalReview"
    FROM "Credito" credit WHERE credit."id"=$1 ${lock ? "FOR UPDATE OF credit" : ""}`, id);
  if (!rows[0]) throw new ApprovalOperationalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
  return rows[0];
}
async function readDraft(db: Db, id: number, lock = false) {
  const rows = await db.$queryRawUnsafe<Draft[]>(`SELECT "id","estado","creditoId","currentStep","imei","payload","expiresAt","createdAt"
    FROM "CreditoBorrador" WHERE "id"=$1 ${lock ? "FOR UPDATE" : ""}`, id);
  const row = rows[0];
  if (!row || row.estado !== "ABIERTO" || row.creditoId !== null ||
      (row.expiresAt || new Date(new Date(row.createdAt).getTime() + 15 * 86400000)) <= new Date())
    throw new ApprovalOperationalError("DRAFT_NOT_AVAILABLE", "La solicitud ya no está abierta o venció.", 409);
  return row;
}
async function currentProcess(db: Db, kind: OperationalKind, id: number) {
  const column = kind === "CREDIT" ? "creditoId" : "draftId";
  const rows = await db.$queryRawUnsafe<Array<FirmaSeguroProcessRow & { activeCount: number }>>(`SELECT *, COUNT(*) OVER()::integer AS "activeCount"
    FROM "FirmaSeguroProcess" WHERE "${column}"=$1 AND "supersededAt" IS NULL
    ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, id);
  if (rows[0]?.activeCount !== undefined && rows[0].activeCount !== 1)
    throw new ApprovalOperationalError("SIGNATURE_AMBIGUOUS", "Hay varias firmas vigentes. Requiere revisión técnica.");
  return rows[0] || null;
}
async function signedDraftSource(db: Db, draftId: number) {
  const rows = await db.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `SELECT * FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "creditoId" IS NULL
     AND "signedDocumentBase64" IS NOT NULL ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, draftId);
  const process = rows[0];
  return process && hasVerifiedDraftSignature(process.signedDocumentBase64,
    Boolean(process.completedAt || isFirmaSeguroCompletedStatus(process.status))) ? process : null;
}
async function readVersion(db: Db, id: string) {
  const rows = await db.$queryRawUnsafe<Version[]>(`SELECT * FROM "ApprovalOperationalContractVersion" WHERE "id"=$1::uuid`, id);
  return rows[0] || null;
}
async function latestVersion(db: Db, creditId: number) {
  const rows = await db.$queryRawUnsafe<Version[]>(`SELECT * FROM "ApprovalOperationalContractVersion" WHERE "creditoId"=$1
    ORDER BY "version" DESC LIMIT 1`, creditId);
  return rows[0] || null;
}
async function terminalVersionForProcess(db: Db, creditId: number, processUuid: string) {
  const rows = await db.$queryRawUnsafe<Version[]>(`SELECT * FROM "ApprovalOperationalContractVersion"
    WHERE "creditoId"=$1 AND "newProcessUuid"=$2 AND "status"='TECHNICAL_ERROR'
    ORDER BY "version" DESC LIMIT 1`, creditId, processUuid);
  return rows[0] || null;
}
async function contractualSourceProcess(db: Db, creditId: number, current: FirmaSeguroProcessRow) {
  const first = await db.$queryRawUnsafe<Array<{ previousProcessUuid: string }>>(
    `SELECT "previousProcessUuid" FROM "ApprovalOperationalContractVersion"
     WHERE "creditoId"=$1 ORDER BY "version" ASC LIMIT 1`, creditId);
  if (!first[0]) return current;
  const rows = await db.$queryRawUnsafe<FirmaSeguroProcessRow[]>(
    `SELECT * FROM "FirmaSeguroProcess" WHERE "creditoId"=$1 AND "processUuid"=$2 LIMIT 1`,
    creditId, first[0].previousProcessUuid);
  if (!rows[0] || !checkPdf(rows[0].signedDocumentBase64))
    throw new ApprovalOperationalError("CONTRACT_NOT_VERIFIED", "El contrato de origen firmado no está disponible. Requiere revisión técnica.");
  return rows[0];
}
async function insertAction(db: Db, input: {
  id: string; kind: OperationalKind; targetId: number; creditId?: number | null; eventType: string;
  actor: OperationalActor; previousImei?: string | null; newImei?: string | null; reason: string;
  evidence?: Evidence; beforeContact?: unknown; afterContact?: unknown; status: string;
}) {
  const existing = await db.$queryRawUnsafe<Array<{ targetKind: string; targetId: number; eventType: string; actorUserId: number; status: string }>>(
    `SELECT "targetKind","targetId","eventType","actorUserId","status" FROM "ApprovalOperationalAction" WHERE "id"=$1::uuid`, input.id);
  if (existing[0]) {
    if (existing[0].targetKind !== input.kind || existing[0].targetId !== input.targetId
      || existing[0].eventType !== input.eventType || existing[0].actorUserId !== input.actor.id)
      throw new ApprovalOperationalError("IDEMPOTENCY_CONFLICT", "Esta confirmación pertenece a otra operación.", 409);
    return { replayed: true, status: existing[0].status };
  }
  await db.$executeRawUnsafe(`INSERT INTO "ApprovalOperationalAction"
    ("id","targetKind","targetId","creditId","eventType","actorUserId","actorName","previousImei","newImei",
     "reason","evidenceMime","evidenceName","evidenceData","evidenceSha256","beforeContact","afterContact","status")
    VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17)`,
    input.id, input.kind, input.targetId, input.creditId ?? null, input.eventType, input.actor.id,
    clean(input.actor.nombre, 160), input.previousImei ?? null, input.newImei ?? null, input.reason,
    input.evidence?.mime ?? null, input.evidence?.name ?? null, input.evidence?.data ?? null, input.evidence?.hash ?? null,
    input.beforeContact === undefined ? null : JSON.stringify(input.beforeContact),
    input.afterContact === undefined ? null : JSON.stringify(input.afterContact), input.status);
  return { replayed: false, status: input.status };
}

function snapshot(credit: Credit) {
  return {
    clienteNombre: credit.clienteNombre, clienteCorreo: credit.clienteCorreo,
    clienteTelefono: credit.clienteTelefono, clienteDepartamento: credit.clienteDepartamento ?? null,
    clienteCiudad: credit.clienteCiudad ?? null, clienteDireccion: credit.clienteDireccion ?? null,
    referenciaEquipo: credit.referenciaEquipo ?? null,
  };
}
async function correctionChain(db: Db, creditId: number) {
  const corrections = await db.$queryRawUnsafe<Array<ApprovalDataCorrectionChainEntry & { createdAt: Date }>>(
    `SELECT "before","after","requestedRevision","resultingRevision","createdAt" FROM "CreditApprovalDataCorrection"
     WHERE "creditoId"=$1 ORDER BY "createdAt","id"`, creditId);
  const operational = await db.$queryRawUnsafe<Array<{ beforeContact: unknown; afterContact: unknown; createdAt: Date }>>(
    `SELECT "beforeContact","afterContact","createdAt" FROM "ApprovalOperationalAction"
     WHERE "creditId"=$1 AND "eventType"='CONTACT_UPDATED' ORDER BY "createdAt","id"`, creditId);
  return [...corrections.map((row) => ({ ...row, sort: new Date(row.createdAt).getTime() })),
    ...operational.map((row) => ({ before: row.beforeContact, after: row.afterContact, sort: new Date(row.createdAt).getTime() }))]
    .sort((a, b) => a.sort - b.sort);
}

export async function getOperationalEvidence(actionId: string) {
  const id = operationId(actionId);
  const rows = await prisma.$queryRawUnsafe<Array<{ evidenceMime: string | null; evidenceName: string | null; evidenceData: Uint8Array | null }>>(
    `SELECT "evidenceMime","evidenceName","evidenceData" FROM "ApprovalOperationalAction" WHERE "id"=$1::uuid`, id);
  const row = rows[0];
  if (!row?.evidenceMime || !row.evidenceName || !row.evidenceData)
    throw new ApprovalOperationalError("EVIDENCE_NOT_FOUND", "Evidencia no encontrada.", 404);
  return { mime: row.evidenceMime, name: row.evidenceName, data: Buffer.from(row.evidenceData) };
}

function versionPublic(row: Version) {
  const message = row.status === "AWAITING_SIGNATURE" ? "Contrato actualizado enviado. Esperando firma del cliente."
    : row.status === "COMPLETED" ? "La nueva versión del contrato fue firmada."
    : row.status === "FAILED_SAFE" ? "Error técnico: requiere revisión. No se envió una nueva firma."
    : row.status === "TECHNICAL_ERROR" ? "Error técnico: requiere revisión. La nueva firma terminó sin completarse."
    : row.status === "UNCERTAIN" ? "Error técnico: requiere revisión. El envío no pudo verificarse; no lo repitas."
    : "Preparando la nueva versión del contrato.";
  return { id: row.id, status: row.status, message, version: row.version };
}

async function requestOperationalVersion(input: {
  creditId: number; actor: OperationalActor; idempotencyKey: string; expectedProcessUuid: string;
  reason: string; replacementId?: string | null;
}) {
  await ensureFirmaSeguroSchema();
  await ensureApprovalOperationalSchema();
  await ensureCreditDeviceReplacementSchema();
  const id = operationId(input.idempotencyKey);
  const wantedProcess = clean(input.expectedProcessUuid, 160);
  if (!wantedProcess || !/^[A-Za-z0-9_-]{1,160}$/.test(wantedProcess))
    throw new ApprovalOperationalError("PROCESS_CHANGED", "Actualiza el estado de la firma antes de continuar.", 409);
  const original = await prisma.$transaction(async (db) => {
    const credit = await readCredit(db, input.creditId, true);
    if (input.replacementId) assertOperationalImeiCredit(credit);
    else assertSettledOperationalCredit(credit);
    const previous = await readVersion(db, id);
    if (previous) {
      if (previous.creditoId !== input.creditId || previous.actorUserId !== input.actor.id || previous.reason !== input.reason
        || operationalProcessToSupersede(previous) !== wantedProcess
        || (input.replacementId && previous.replacementId !== input.replacementId))
        throw new ApprovalOperationalError("IDEMPOTENCY_CONFLICT", "Esta confirmación pertenece a otra operación.");
      if (!input.replacementId && previous.replacementId) {
        const signatureAction = await db.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id"::text FROM "ApprovalOperationalAction" WHERE "id"=$1::uuid
           AND "eventType"='SIGNATURE_REQUESTED' AND "actorUserId"=$2 LIMIT 1`, id, input.actor.id);
        if (!signatureAction[0]) throw new ApprovalOperationalError("IDEMPOTENCY_CONFLICT",
          "Esta confirmación pertenece a un cambio de IMEI.");
      }
      // FAILED_SAFE is only retriable when preparation failed before claiming
      // the provider POST. An uncertain dispatch must never be repeated.
      if (input.replacementId && previous.status === "FAILED_SAFE" &&
          previous.newProcessUuid === null && previous.supersededProcessUuid === null &&
          previous.requestPayload === null) {
        if ((await latestVersion(db, input.creditId))?.id !== previous.id)
          throw new ApprovalOperationalError("SIGNATURE_STATE_CHANGED",
            "Existe una versión posterior del contrato. Actualiza el caso antes de continuar.");
        const process = await currentProcess(db, "CREDIT", input.creditId);
        if (!process || process.processUuid !== wantedProcess || !checkPdf(process.signedDocumentBase64)
          || !(process.completedAt || isFirmaSeguroCompletedStatus(process.status)))
          throw new ApprovalOperationalError("SIGNED_DOCUMENT_REQUIRED",
            "La firma de origen cambió. Requiere revisión técnica antes de reintentar.");
        const resumed = await db.$executeRawUnsafe(`UPDATE "ApprovalOperationalContractVersion"
          SET "status"='PREPARING',"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
          WHERE "id"=$1::uuid AND "status"='FAILED_SAFE' AND "requestPayload" IS NULL
            AND "newProcessUuid" IS NULL AND "supersededProcessUuid" IS NULL`, id);
        return { version: (await readVersion(db, id))!, dispatch: resumed === 1, process, terminalRetry: false };
      }
      const retryProcess = canDispatchReservedVersion(previous.status)
        ? await currentProcess(db, "CREDIT", input.creditId) : null;
      if (retryProcess && retryProcess.processUuid !== wantedProcess)
        throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma cambió. Actualiza el caso.");
      const retryAnchor = retryProcess?.processUuid
        ? await terminalVersionForProcess(db, input.creditId, retryProcess.processUuid) : null;
      const terminalRetry = Boolean(previous.supersededProcessUuid && retryProcess
        && isVerifiedTerminalOperationalRetry(retryAnchor, retryProcess));
      if (previous.supersededProcessUuid && !terminalRetry) {
        await db.$executeRawUnsafe(`UPDATE "ApprovalOperationalContractVersion"
          SET "status"='FAILED_SAFE',"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
          WHERE "id"=$1::uuid AND "status"='PREPARING'`, id);
        return { version: (await readVersion(db, id))!, dispatch: false, process: retryProcess, terminalRetry: false };
      }
      return { version: previous, dispatch: Boolean(retryProcess), process: retryProcess, terminalRetry };
    }
    const other = await latestVersion(db, input.creditId);
    if (other && (PENDING as readonly string[]).includes(other.status))
      throw new ApprovalOperationalError("SIGNATURE_PENDING", "Hay una nueva firma en curso. Consulta su estado antes de enviar otra.");
    const replacementInProgress = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id"::text FROM "CreditDeviceReplacement" WHERE "creditId"=$1
       AND "status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED') LIMIT 1`, input.creditId);
    if (replacementInProgress[0]) throw new ApprovalOperationalError("REPLACEMENT_PENDING",
      "Hay un cambio de equipo en revisión. Espera su aprobación antes de reenviar la firma.");
    const pendingApproval = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id"::text FROM "CreditApprovalReissue"
      WHERE "creditoId"=$1 AND "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN') LIMIT 1`, input.creditId);
    if (pendingApproval.length) throw new ApprovalOperationalError("SIGNATURE_PENDING", "Hay un reenvío de firma en curso.");
    const process = await currentProcess(db, "CREDIT", input.creditId);
    const terminalAnchor = process
      ? await terminalVersionForProcess(db, input.creditId, process.processUuid) : null;
    const terminalRetry = isVerifiedTerminalOperationalRetry(terminalAnchor, process)
      && Boolean(other?.id === terminalAnchor?.id || (other?.status === "FAILED_SAFE"
        && operationalProcessToSupersede(other) === process?.processUuid));
    if (other?.status === "TECHNICAL_ERROR" && !terminalRetry)
      throw new ApprovalOperationalError("SIGNATURE_STATE_CHANGED",
        "El estado de la firma cambió. Requiere revisión técnica antes de reenviar.");
    if (!process || process.processUuid !== wantedProcess || (!terminalRetry &&
      (!checkPdf(process.signedDocumentBase64)
        || !(process.completedAt || isFirmaSeguroCompletedStatus(process.status)))))
      throw new ApprovalOperationalError("SIGNED_DOCUMENT_REQUIRED", "El documento firmado vigente no está disponible. Requiere revisión técnica.");
    const currentImei = newImei(digits(credit.imei || credit.deviceUid));
    if (["FAILED_SAFE", "TECHNICAL_ERROR"].includes(other?.status || "") && other?.newImei !== currentImei)
      throw new ApprovalOperationalError("CONTRACT_ORIGIN_CHANGED",
        "El equipo cambió después del último intento de firma. Requiere revisión técnica antes de reenviar.");
    let replacement: Replacement | null = null;
    if (input.replacementId) {
      const rows = await db.$queryRawUnsafe<Replacement[]>(`SELECT "id"::text,"creditId","status","previousImei","newImei","reason"
        FROM "CreditDeviceReplacement" WHERE "id"=$1::uuid AND "creditId"=$2`, input.replacementId, input.creditId);
      replacement = rows[0] || null;
      if (!replacement || replacement.status !== "COMPLETED" || replacement.newImei !== currentImei)
        throw new ApprovalOperationalError("REPLACEMENT_NOT_READY", "El nuevo IMEI requiere aprobación y aplicación del enrolamiento.");
    }
    const contractualSource = await contractualSourceProcess(db, input.creditId, process);
    let sealed: ReturnType<typeof frozenReissueCredit>;
    try { sealed = frozenReissueCredit(credit, contractualSource,
      await correctionChain(db, input.creditId)); }
    catch { throw new ApprovalOperationalError("CONTRACT_NOT_VERIFIED", "No se pudo verificar el contrato y sus condiciones originales. Requiere revisión técnica."); }
    const sourcePdf = checkPdf(terminalRetry ? contractualSource.signedDocumentBase64 : process.signedDocumentBase64);
    if (!sourcePdf) throw new ApprovalOperationalError("SIGNED_DOCUMENT_REQUIRED", "No se pudo verificar el documento firmado vigente.");
    // The signed financial seal remains the sole source of amounts, rate, term and due dates.
    const frozenCredit: CreditForFirmaSeguroPdf = operationalFrozenCredit(sealed.credit,
      currentImei, credit.clienteTelefono, credit.clienteCorreo);
    const version = (other?.version || 0) + 1;
    const reusableFailedVersion = ["FAILED_SAFE", "TECHNICAL_ERROR"].includes(other?.status || "")
      && other?.newImei === currentImei
      && (other.status !== "TECHNICAL_ERROR" || terminalRetry);
    const failedReplacement = !replacement && reusableFailedVersion
      ? other.replacementId : null;
    const previousImei = !replacement && reusableFailedVersion
      ? other.previousImei : currentImei;
    const lineage = operationalSignatureLineage(process.processUuid, contractualSource.processUuid, terminalRetry);
    await db.$executeRawUnsafe(`INSERT INTO "ApprovalOperationalContractVersion"
      ("id","creditoId","replacementId","previousProcessUuid","supersededProcessUuid","previousImei","newImei","sentPhone","sentEmail","reason",
       "actorUserId","actorName","status","version","sourceTermsHash","originalDocumentHash","frozenCredit")
      VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PREPARING',$13,$14,$15,$16::jsonb)`,
      id, input.creditId, replacement?.id || failedReplacement || null,
      lineage.previousProcessUuid, lineage.supersededProcessUuid,
      replacement?.previousImei || previousImei, currentImei, credit.clienteTelefono, credit.clienteCorreo,
      input.reason, input.actor.id, clean(input.actor.nombre, 160), version, sealed.termsHash,
      reissueHash(sourcePdf), JSON.stringify(frozenCredit));
    if (!replacement) await insertAction(db, { id, kind: "CREDIT", targetId: input.creditId,
      creditId: input.creditId, eventType: "SIGNATURE_REQUESTED", actor: input.actor,
      previousImei: currentImei, newImei: currentImei, reason: input.reason, status: "PREPARING" });
    return { version: (await readVersion(db, id))!, dispatch: true, process, terminalRetry };
  }, { timeout: 15000 });
  if (!original.dispatch || !original.process) return versionPublic(original.version);

  let dispatched = false;
  try {
    if (original.terminalRetry) {
      // Recheck directly with FirmaSeguro immediately before claiming its POST.
      // A stale local terminal state must never authorize a second signature.
      await refreshFirmaSeguroProcess(original.process);
    }
    const document = await buildFirmaSeguroCreditPdf(original.version.frozenCredit);
    if (document.length > 32 * 1024 * 1024 || document.subarray(0, 5).toString() !== "%PDF-")
      throw new Error("OPERATIONAL_PDF_INVALID");
    const prepared = await prepareFirmaSeguroReissue(original.version.frozenCredit, document, id);
    const claimed = await prisma.$transaction(async (db) => {
      const credit = await readCredit(db, input.creditId, true);
      if (input.replacementId) assertOperationalImeiCredit(credit);
      else assertSettledOperationalCredit(credit);
      if (digits(credit.imei) !== original.version.newImei || digits(credit.deviceUid) !== original.version.newImei
        || credit.clienteTelefono !== original.version.sentPhone || credit.clienteCorreo !== original.version.sentEmail)
        throw new Error("OPERATIONAL_CREDIT_CHANGED");
      const pendingReplacement = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id"::text FROM "CreditDeviceReplacement" WHERE "creditId"=$1
         AND "status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED') LIMIT 1`, input.creditId);
      if (pendingReplacement[0]) throw new Error("OPERATIONAL_REPLACEMENT_PENDING");
      const process = await currentProcess(db, "CREDIT", input.creditId);
      if (process?.processUuid !== wantedProcess) throw new Error("OPERATIONAL_SOURCE_CHANGED");
      if (original.terminalRetry) {
        const anchor = await terminalVersionForProcess(db, input.creditId, wantedProcess);
        if (!isVerifiedTerminalOperationalRetry(anchor, process))
          throw new Error("OPERATIONAL_TERMINAL_SOURCE_CHANGED");
      }
      return db.$executeRawUnsafe(`UPDATE "ApprovalOperationalContractVersion"
        SET "status"='DISPATCHING',"documentBase64"=$2,"documentHash"=$3,"requestPayload"=$4::jsonb,
            "updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE "id"=$1::uuid AND "status"='PREPARING'`, id, document.toString("base64"), reissueHash(document),
        JSON.stringify(prepared.requestPayload));
    });
    if (claimed !== 1) return versionPublic((await readVersion(prisma, id))!);
    dispatched = true;
    const sent = await prepared.sendOnce();
    await prisma.$transaction(async (db) => {
      const credit = await readCredit(db, input.creditId, true);
      if (digits(credit.imei) !== original.version.newImei || digits(credit.deviceUid) !== original.version.newImei)
        throw new Error("OPERATIONAL_CREDIT_CHANGED");
      const version = await readVersion(db, id);
      const process = await currentProcess(db, "CREDIT", input.creditId);
      if (!version || !["DISPATCHING", "UNCERTAIN"].includes(version.status)
        || process?.processUuid !== wantedProcess) throw new Error("OPERATIONAL_BINDING_CHANGED");
      if (original.terminalRetry) {
        const anchor = await terminalVersionForProcess(db, input.creditId, wantedProcess);
        if (!isVerifiedTerminalOperationalRetry(anchor, process))
          throw new Error("OPERATIONAL_TERMINAL_SOURCE_CHANGED");
      }
      const superseded = await db.$executeRawUnsafe(`UPDATE "FirmaSeguroProcess"
        SET "supersededAt"=CURRENT_TIMESTAMP,"supersededByUserId"=$3,"supersededReason"=$4
        WHERE "creditoId"=$1 AND "processUuid"=$2 AND "supersededAt" IS NULL`,
        input.creditId, wantedProcess, input.actor.id, input.reason);
      if (superseded !== 1) throw new Error("OPERATIONAL_SUPERSEDE_FAILED");
      await db.$executeRawUnsafe(`INSERT INTO "FirmaSeguroProcess"
        ("creditoId","draftId","draftFolio","draftPayload","processUuid","status","requestPayload","createPayload","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8::jsonb,CURRENT_TIMESTAMP AT TIME ZONE 'UTC',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
        input.creditId, process.draftId, original.version.frozenCredit.folio,
        JSON.stringify({ ...object(process.draftPayload), operationalRevision: { id, version: version.version, imei: version.newImei } }),
        sent.processUuid, sent.status, JSON.stringify(prepared.requestPayload), JSON.stringify(sent.createPayload));
      if ((await currentProcess(db, "CREDIT", input.creditId))?.processUuid !== sent.processUuid)
        throw new Error("OPERATIONAL_PROCESS_MISMATCH");
      await db.$executeRawUnsafe(`UPDATE "ApprovalOperationalContractVersion"
        SET "status"='AWAITING_SIGNATURE',"newProcessUuid"=$2,"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE "id"=$1::uuid AND "status" IN ('DISPATCHING','UNCERTAIN')`, id, sent.processUuid);
    }, { timeout: 15000 });
  } catch {
    await prisma.$transaction(async (db) => {
      await readCredit(db, input.creditId, true);
      await db.$executeRawUnsafe(`UPDATE "ApprovalOperationalContractVersion"
        SET "status"=$2,"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE "id"=$1::uuid AND "status"=$3`, id,
        dispatched ? "UNCERTAIN" : "FAILED_SAFE", dispatched ? "DISPATCHING" : "PREPARING");
    });
  }
  return versionPublic((await readVersion(prisma, id))!);
}

async function reserveReplacementVersion(db: Prisma.TransactionClient, input: {
  id: string; creditId: number; actor: OperationalActor; previousProcessUuid: string;
  replacement: { id: string; previousImei: string; newImei: string }; motive: string;
}) {
  const credit = await readCredit(db, input.creditId, true);
  assertOperationalImeiCredit(credit);
  if (digits(credit.imei) !== input.replacement.newImei || digits(credit.deviceUid) !== input.replacement.newImei)
    throw new ApprovalOperationalError("REPLACEMENT_NOT_APPLIED", "El IMEI aprobado no coincide con el equipo vigente.");
  const existing = await latestVersion(db, input.creditId);
  if (existing && (PENDING as readonly string[]).includes(existing.status))
    throw new ApprovalOperationalError("SIGNATURE_PENDING", "Hay una nueva firma en curso.");
  const pendingApproval = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id"::text FROM "CreditApprovalReissue"
    WHERE "creditoId"=$1 AND "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN') LIMIT 1`, input.creditId);
  if (pendingApproval.length) throw new ApprovalOperationalError("SIGNATURE_PENDING", "Hay un reenvío de firma en curso.");
  const process = await currentProcess(db, "CREDIT", input.creditId);
  const sourcePdf = checkPdf(process?.signedDocumentBase64);
  if (!process || process.processUuid !== input.previousProcessUuid || !sourcePdf
    || !(process.completedAt || isFirmaSeguroCompletedStatus(process.status)))
    throw new ApprovalOperationalError("SIGNED_DOCUMENT_REQUIRED", "El contrato firmado vigente no está disponible. Requiere revisión técnica.");
  let sealed: ReturnType<typeof frozenReissueCredit>;
  try { sealed = frozenReissueCredit(credit, await contractualSourceProcess(db, input.creditId, process),
    await correctionChain(db, input.creditId)); }
  catch { throw new ApprovalOperationalError("CONTRACT_NOT_VERIFIED", "El contrato original no pudo verificarse. Requiere revisión técnica."); }
  const frozenCredit: CreditForFirmaSeguroPdf = operationalFrozenCredit(sealed.credit,
    input.replacement.newImei, credit.clienteTelefono, credit.clienteCorreo);
  await db.$executeRawUnsafe(`INSERT INTO "ApprovalOperationalContractVersion"
    ("id","creditoId","replacementId","previousProcessUuid","previousImei","newImei","sentPhone","sentEmail","reason",
     "actorUserId","actorName","status","version","sourceTermsHash","originalDocumentHash","frozenCredit")
    VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,'PREPARING',$12,$13,$14,$15::jsonb)`,
    input.id,input.creditId,input.replacement.id,input.previousProcessUuid,input.replacement.previousImei,
    input.replacement.newImei,credit.clienteTelefono,credit.clienteCorreo,input.motive,input.actor.id,
    clean(input.actor.nombre,160),(existing?.version || 0)+1,sealed.termsHash,reissueHash(sourcePdf),JSON.stringify(frozenCredit));
  await insertAction(db, { id: input.id, kind: "CREDIT", targetId: input.creditId,
    creditId: input.creditId, eventType: "IMEI_APPLIED", actor: input.actor,
    previousImei: input.replacement.previousImei, newImei: input.replacement.newImei,
    reason: input.motive, status: "APPLIED_SIGNATURE_PENDING" });
}

function assertSettledOperationalCredit(credit: Credit) {
  const gate = operationalCreditEligibility(credit);
  if (gate === "CANCELLED") throw new ApprovalOperationalError("CREDIT_NOT_ELIGIBLE",
    "Este crédito no admite modificaciones operativas.");
  if (gate === "NOT_SETTLED") throw new ApprovalOperationalError("PRE_SETTLEMENT_APPROVAL_REQUIRED",
    "Este crédito aún está en aprobación. Usa la corrección y reemisión existentes antes de liquidarlo.");
  if (gate === "NOT_FINALIZED") throw new ApprovalOperationalError("CREDIT_NOT_ELIGIBLE",
    "El crédito no tiene una solicitud de origen finalizada para este proceso.");
  if (gate === "IPHONE_REQUIRED") throw new ApprovalOperationalError("IPHONE_REQUIRED",
    "Esta operación está disponible por ahora únicamente para créditos iPhone.");
}

function assertOperationalImeiCredit(credit: Credit) {
  const gate = operationalImeiEligibility(credit);
  if (gate === "CANCELLED") throw new ApprovalOperationalError("CREDIT_NOT_ELIGIBLE",
    "Este crédito no admite modificaciones operativas.");
  if (gate === "NOT_FINALIZED" || gate === "PRE_SETTLEMENT_REVIEW_REQUIRED")
    throw new ApprovalOperationalError("PRE_SETTLEMENT_REVIEW_REQUIRED",
      "El cambio requiere una solicitud finalizada y una revisión de Aprobaciones vigente.");
  if (gate === "IPHONE_REQUIRED") throw new ApprovalOperationalError("IPHONE_REQUIRED",
    "Esta operación está disponible por ahora únicamente para créditos iPhone.");
}

async function invalidatePreSettlementImeiApproval(db: Db, credit: Credit) {
  if (credit.paidToAlly) return;
  await db.$queryRawUnsafe(`SELECT public.credit_approval_invalidate($1, 'IMEI_REPLACEMENT_REQUESTED')`, credit.id);
  const review = await db.$queryRawUnsafe<Array<{ status: string; approvedRevision: number | null }>>(
    `SELECT "status","approvedRevision" FROM "CreditApprovalReview" WHERE "creditoId"=$1 FOR UPDATE`, credit.id);
  if (review[0]?.status !== "PENDING" || review[0].approvedRevision !== null)
    throw new ApprovalOperationalError("APPROVAL_INVALIDATION_FAILED",
      "No se pudo reabrir la revisión del crédito. No se registró el cambio de equipo.", 503);
}

export async function mutateOperationalImei(kind: OperationalKind, targetId: number, input: {
  action: unknown; newImei: unknown; expectedImei: unknown; expectedProcessUuid: unknown;
  expectedEnrollmentReviewId: unknown; replacementId: unknown; reason: unknown;
  idempotencyKey: unknown; confirmed: unknown; evidence: Evidence;
}, actor: OperationalActor) {
  assertActor(actor);
  if (!Number.isSafeInteger(targetId) || targetId < 1)
    throw new ApprovalOperationalError("INVALID_CASE", "Selecciona un caso válido.", 400);
  const id = operationId(input.idempotencyKey);
  const action = input.action === "CONFIRM" ? "CONFIRM" : "REQUEST";
  if (input.action !== action) throw new ApprovalOperationalError("INVALID_ACTION", "Acción no válida.", 400);
  assertConfirmed(input.confirmed);
  await ensureFirmaSeguroSchema();
  await ensureApprovalOperationalSchema();

  if (kind === "DRAFT") {
    if (action !== "REQUEST") throw new ApprovalOperationalError("INVALID_ACTION", "Esta solicitud no usa confirmación de garantía.", 400);
    const previous = await prisma.$queryRawUnsafe<Array<{ targetKind: string; targetId: number; actorUserId: number;
      newImei: string; reason: string; evidenceSha256: string | null; status: string }>>(
      `SELECT "targetKind","targetId","actorUserId","newImei","reason","evidenceSha256","status"
       FROM "ApprovalOperationalAction" WHERE "id"=$1::uuid`, id);
    if (previous[0]) {
      if (previous[0].targetKind !== "DRAFT" || previous[0].targetId !== targetId || previous[0].actorUserId !== actor.id
        || previous[0].newImei !== input.newImei || previous[0].reason !== reason(input.reason)
        || previous[0].evidenceSha256 !== (input.evidence?.hash || null))
        throw new ApprovalOperationalError("IDEMPOTENCY_CONFLICT", "Esta confirmación pertenece a otro cambio.");
      return { id, status: previous[0].status, message: "El IMEI ya fue corregido. Consulta el estado de la nueva firma." };
    }
    const draft = await readDraft(prisma, targetId);
    if (draft.currentStep < 3 || draft.currentStep > 4)
      throw new ApprovalOperationalError("DRAFT_STEP_CHANGED", "El caso ya no está en Identidad y firma. Actualízalo.");
    const imei = newImei(input.newImei);
    sameImei(input.expectedImei, draft.imei);
    const signed = await currentProcess(prisma, "DRAFT", targetId);
    if (!signed || signed.processUuid !== input.expectedProcessUuid
      || !hasVerifiedDraftSignature(signed.signedDocumentBase64,
        Boolean(signed.completedAt || isFirmaSeguroCompletedStatus(signed.status))))
      throw new ApprovalOperationalError("SIGNED_DOCUMENT_REQUIRED",
        "Error técnico: requiere revisión. La firma vigente no tiene un PDF firmado verificable.");
    const motive = reason(input.reason);
    const expectedEnrollmentReviewId = input.expectedEnrollmentReviewId === "" || input.expectedEnrollmentReviewId === null
      ? null : input.expectedEnrollmentReviewId;
    const result = await correctFirmaSeguroDraftImei({
      draftId: targetId, imei, reason: motive, expectedCurrentImei: input.expectedImei,
      expectedProcessUuid: input.expectedProcessUuid, expectedEnrollmentReviewId,
      actorUserId: actor.id, actorName: actor.nombre,
      onCorrected: async (db, correction) => {
        const source = await signedDraftSource(db, targetId);
        if (!source || source.processUuid !== input.expectedProcessUuid)
          throw new ApprovalOperationalError("SIGNED_DOCUMENT_REQUIRED",
            "Error técnico: requiere revisión. El documento firmado cambió durante la corrección.");
        await insertAction(db, { id, kind, targetId, eventType: "IMEI_CORRECTED", actor,
          previousImei: correction.previousImei, newImei: correction.imei, reason: motive,
          evidence: input.evidence, status: operationalDraftCorrectionStatus(correction.enrollmentReapprovalRequired) });
      },
    });
    return { id, status: operationalDraftCorrectionStatus(result.enrollmentReapprovalRequired), message: result.enrollmentReapprovalRequired
      ? "IMEI corregido y firma anterior archivada. Completa la nueva evidencia y el enrolamiento antes de enviar otra firma."
      : "IMEI corregido y firma anterior archivada. Verifica el expediente antes de enviar el nuevo contrato." };
  }

  await ensureCreditDeviceReplacementSchema();
  const credit = await readCredit(prisma, targetId);
  assertOperationalImeiCredit(credit);
  if (action === "REQUEST") {
    const existing = await prisma.$queryRawUnsafe<Array<{ targetKind: string; targetId: number; actorUserId: number;
      newImei: string; reason: string; evidenceSha256: string | null; status: string }>>(
      `SELECT "targetKind","targetId","actorUserId","newImei","reason","evidenceSha256","status"
       FROM "ApprovalOperationalAction" WHERE "id"=$1::uuid`, id);
    if (existing[0]) {
      if (existing[0].targetKind !== "CREDIT" || existing[0].targetId !== targetId || existing[0].actorUserId !== actor.id
        || existing[0].newImei !== input.newImei || existing[0].reason !== reason(input.reason)
        || existing[0].evidenceSha256 !== (input.evidence?.hash || null))
        throw new ApprovalOperationalError("IDEMPOTENCY_CONFLICT", "Esta confirmación pertenece a otro cambio.");
      return { id, status: existing[0].status, message: "Solicitud de garantía registrada. Esperando aprobación del enrolamiento." };
    }
    const imei = newImei(input.newImei);
    sameImei(input.expectedImei, credit.imei);
    const motive = reason(input.reason);
    const process = await currentProcess(prisma, "CREDIT", targetId);
    if (!process || process.processUuid !== input.expectedProcessUuid || !checkPdf(process.signedDocumentBase64)
      || !(process.completedAt || isFirmaSeguroCompletedStatus(process.status)))
      throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma cambió. Actualiza el caso.");
    try { frozenReissueCredit(credit, await contractualSourceProcess(prisma, targetId, process),
      await correctionChain(prisma, targetId)); }
    catch { throw new ApprovalOperationalError("CONTRACT_NOT_VERIFIED",
      "El contrato firmado no pudo verificarse. Requiere revisión técnica."); }
    const replacement = await createCreditDeviceReplacement({ creditId: targetId, newImei: imei, reason: motive,
      source: "APPROVAL_OPERATIONS",
      actor: { userId: actor.id, name: actor.nombre },
      onCreated: async (db, created) => {
        sameImei(input.expectedImei, created.previousImei);
        const lockedCredit = await readCredit(db, targetId);
        assertOperationalImeiCredit(lockedCredit);
        const active = await currentProcess(db, "CREDIT", targetId);
        if (!active || active.processUuid !== input.expectedProcessUuid || !checkPdf(active.signedDocumentBase64))
          throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma cambió. Actualiza el caso.");
        try { frozenReissueCredit(lockedCredit, await contractualSourceProcess(db, targetId, active),
          await correctionChain(db, targetId)); }
        catch { throw new ApprovalOperationalError("CONTRACT_NOT_VERIFIED",
          "El contrato cambió durante la solicitud. Requiere revisión técnica."); }
        await insertAction(db, { id, kind, targetId, creditId: targetId,
          eventType: "IMEI_REQUESTED", actor, previousImei: created.previousImei, newImei: created.newImei,
          reason: motive, evidence: input.evidence, status: "PENDING_ENROLLMENT" });
        // The same transaction must reopen an approved case before a pending
        // replacement can be visible to ally settlement.
        await invalidatePreSettlementImeiApproval(db, lockedCredit);
      },
    });
    // The request and evidence are committed by the same replacement transaction.
    return { id, replacementId: replacement.id, status: replacement.status,
      message: "Cambio registrado. Se solicitó al aliado una nueva foto de la remisión firmada. Tras verificarla y aprobar el enrolamiento, podrás enviar el contrato con el nuevo IMEI." };
  }

  const replacementId = operationId(input.replacementId);
  const replay = await readVersion(prisma, id);
  if (replay) {
    if (replay.creditoId !== targetId || replay.actorUserId !== actor.id
      || replay.replacementId !== replacementId || replay.previousProcessUuid !== input.expectedProcessUuid)
      throw new ApprovalOperationalError("IDEMPOTENCY_CONFLICT", "Esta confirmación pertenece a otro caso.");
    if (replay.status !== "PREPARING" && !(replay.status === "FAILED_SAFE" &&
      replay.requestPayload === null && replay.newProcessUuid === null && replay.supersededProcessUuid === null))
      return versionPublic(replay);
    return requestOperationalVersion({ creditId: targetId, actor, idempotencyKey: id,
      expectedProcessUuid: replay.previousProcessUuid, reason: replay.reason, replacementId });
  }
  const replacementRows = await prisma.$queryRawUnsafe<Replacement[]>(`SELECT "id"::text,"creditId","status","previousImei","newImei","reason"
    FROM "CreditDeviceReplacement" WHERE "id"=$1::uuid AND "creditId"=$2`, replacementId, targetId);
  const replacement = replacementRows[0];
  if (!replacement || !["ENROLLMENT_APPROVED", "COMPLETED"].includes(replacement.status))
    throw new ApprovalOperationalError("ENROLLMENT_REQUIRED", "El nuevo IMEI requiere aprobación de enrolamiento antes de aplicarse.");
  if (replacement.status === "ENROLLMENT_APPROVED")
    await completeCreditDeviceReplacement({ creditId: targetId, actor: { userId: actor.id, name: actor.nombre },
      onCompleted: async (db, applied) => {
        if (applied.id !== replacementId || applied.newImei !== replacement.newImei)
          throw new ApprovalOperationalError("REPLACEMENT_CHANGED", "La aprobación del equipo cambió. Actualiza el caso.");
        await reserveReplacementVersion(db, { id, creditId: targetId, actor,
          previousProcessUuid: String(input.expectedProcessUuid || ""), replacement: applied,
          motive: replacement.reason });
      },
    });
  else if (!await readVersion(prisma, id))
    throw new ApprovalOperationalError("VERSION_NOT_RESERVED", "El cambio ya fue aplicado sin esta confirmación. Requiere revisión técnica.");
  return requestOperationalVersion({ creditId: targetId, actor, idempotencyKey: id,
    expectedProcessUuid: String(input.expectedProcessUuid || ""), reason: replacement.reason, replacementId });
}

export async function updateOperationalContact(kind: OperationalKind, targetId: number, input: {
  phone?: unknown; email?: unknown; reason: unknown; idempotencyKey: unknown; expectedProcessUuid: unknown;
  expectedRevision?: unknown; expectedReviewHash?: unknown;
}, actor: OperationalActor) {
  assertActor(actor);
  const id = operationId(input.idempotencyKey);
  const motive = reason(input.reason);
  const hasPhone = input.phone !== undefined && input.phone !== null && input.phone !== "";
  const hasEmail = input.email !== undefined && input.email !== null && input.email !== "";
  if (!hasPhone && !hasEmail) throw new ApprovalOperationalError("CONTACT_REQUIRED", "Ingresa un celular o correo para actualizar.", 400);
  const nextPhone = hasPhone ? phone(input.phone) : null;
  const nextEmail = hasEmail ? email(input.email) : null;
  await ensureFirmaSeguroSchema();
  await ensureApprovalOperationalSchema();
  if (kind === "DRAFT") await ensureDraftDispatchSchema();
  if (kind === "CREDIT" && !(await readCredit(prisma, targetId)).paidToAlly) {
    const changes = { ...(hasPhone ? { clienteTelefono: nextPhone! } : {}),
      ...(hasEmail ? { clienteCorreo: nextEmail! } : {}) };
    const parsed = parseApprovalDataCorrection({ changes, reason: motive, idempotencyKey: id,
      revision: input.expectedRevision, reviewHash: input.expectedReviewHash });
    return prisma.$transaction(async (db) => {
      const credit = await readCredit(db, targetId, true);
      if (credit.paidToAlly || !credit.hasApprovalReview ||
        String(credit.platform).toUpperCase() !== "IPHONE")
        throw new ApprovalOperationalError("APPROVAL_FLOW_REQUIRED",
          "El crédito no tiene una revisión de Aprobaciones vigente para corregir el contacto.");
      // A retry is validated by the correction's own request hash before the
      // stale process check, so an already committed operation remains idempotent.
      const prior = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id"::text FROM "CreditApprovalDataCorrection" WHERE "idempotencyKey"=$1::uuid LIMIT 1`, id);
      if (!prior.length) {
        const initialTable = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
          `SELECT to_regclass('public."CreditApprovalInitialSignature"') IS NOT NULL AS "present"`);
        if (initialTable[0]?.present) {
          const initial = await db.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT "id"::text FROM "CreditApprovalInitialSignature" WHERE "creditoId"=$1
             AND "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN') LIMIT 1`, targetId);
          if (initial.length) throw new ApprovalOperationalError("SIGNATURE_PENDING",
            "El primer envío de firma sigue en curso. Espera su resultado antes de cambiar el contacto.");
        }
        const process = await currentProcess(db, kind, targetId);
        if (process && !(process.completedAt || isFirmaSeguroCompletedStatus(process.status)))
          throw new ApprovalOperationalError("SIGNATURE_PENDING",
            "La firma vigente sigue en curso. Espera su resultado antes de cambiar el contacto.");
        if ((process?.processUuid || null) !== (input.expectedProcessUuid || null))
          throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma cambió. Actualiza el caso.");
        const version = await latestVersion(db, targetId);
        if (version && (PENDING as readonly string[]).includes(version.status))
          throw new ApprovalOperationalError("SIGNATURE_PENDING", "Hay una nueva firma en curso. Espera su resultado.");
        const replacements = await db.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id"::text FROM "CreditDeviceReplacement" WHERE "creditId"=$1
           AND "status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED') LIMIT 1`, targetId);
        if (replacements.length) throw new ApprovalOperationalError("REPLACEMENT_PENDING",
          "Hay un cambio de equipo en revisión. Espera su aprobación antes de actualizar el contacto.");
      }
      // The approval correction writes its own immutable audit, increments the
      // review revision and invalidates any previous OK. Do not also write an
      // operational correction: frozenReissueCredit consumes both histories.
      const result = await correctCreditApprovalData(db, targetId, parsed, actor);
      return { id, status: "UPDATED", message: result.replayed
        ? "El contacto ya quedó actualizado. Consulta el estado actual antes de reenviar."
        : "Contacto actualizado. El expediente requiere nueva revisión; ya puedes solicitar otra firma." };
    }, { isolationLevel: "ReadCommitted", timeout: 20_000 });
  }
  return prisma.$transaction(async (db) => {
    const replay = await db.$queryRawUnsafe<Array<{ targetKind: string; targetId: number; eventType: string;
      actorUserId: number; beforeContact: unknown; afterContact: unknown; reason: string }>>(
      `SELECT "targetKind","targetId","eventType","actorUserId","beforeContact","afterContact","reason"
       FROM "ApprovalOperationalAction" WHERE "id"=$1::uuid`, id);
    if (replay[0]) {
      const after = object(replay[0].afterContact);
      if (replay[0].targetKind !== kind || replay[0].targetId !== targetId || replay[0].eventType !== "CONTACT_UPDATED"
        || replay[0].actorUserId !== actor.id || replay[0].reason !== motive
        || (hasPhone && after.clienteTelefono !== nextPhone) || (hasEmail && after.clienteCorreo !== nextEmail))
        throw new ApprovalOperationalError("IDEMPOTENCY_CONFLICT", "Esta confirmación pertenece a otra actualización.");
      return { id, status: "UPDATED", message: "Contacto actualizado. Consulta el estado de la firma antes de reenviar." };
    }
    if (kind === "CREDIT") {
      const credit = await readCredit(db, targetId, true);
      assertSettledOperationalCredit(credit);
      const process = await currentProcess(db, kind, targetId);
      const version = await latestVersion(db, targetId);
      if (version && (PENDING as readonly string[]).includes(version.status))
        throw new ApprovalOperationalError("SIGNATURE_PENDING", "Hay una nueva firma en curso. Espera su resultado.");
      const replacements = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id"::text FROM "CreditDeviceReplacement" WHERE "creditId"=$1
         AND "status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED') LIMIT 1`, targetId);
      if (replacements.length) throw new ApprovalOperationalError("REPLACEMENT_PENDING",
        "Hay un cambio de equipo en revisión. Espera su aprobación antes de actualizar el contacto.");
      const terminalAnchor = process ? await terminalVersionForProcess(db, targetId, process.processUuid) : null;
      const terminalRetry = isVerifiedTerminalOperationalRetry(terminalAnchor, process)
        && Boolean(version?.id === terminalAnchor?.id || (version?.status === "FAILED_SAFE"
          && operationalProcessToSupersede(version) === process?.processUuid));
      const signedActive = Boolean(process && checkPdf(process.signedDocumentBase64)
        && (process.completedAt || isFirmaSeguroCompletedStatus(process.status)));
      if (!process || process.processUuid !== input.expectedProcessUuid || (!signedActive && !terminalRetry))
        throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma vigente cambió. Actualiza el caso.");
      try { frozenReissueCredit(credit, await contractualSourceProcess(db, targetId, process),
        await correctionChain(db, targetId)); }
      catch { throw new ApprovalOperationalError("CONTRACT_NOT_VERIFIED",
        "El contrato firmado no pudo verificarse. Requiere revisión técnica."); }
      const before = snapshot(credit);
      const after = { ...before,
        clienteTelefono: nextPhone ?? before.clienteTelefono,
        clienteCorreo: nextEmail ?? before.clienteCorreo };
      if (before.clienteTelefono === after.clienteTelefono && before.clienteCorreo === after.clienteCorreo)
        throw new ApprovalOperationalError("CONTACT_UNCHANGED", "El contacto no cambió.", 400);
      await db.$executeRawUnsafe(`UPDATE "Credito" SET "clienteTelefono"=$2,"clienteCorreo"=$3,
        "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, targetId, after.clienteTelefono, after.clienteCorreo);
      await insertAction(db, { id, kind, targetId, creditId: targetId, eventType: "CONTACT_UPDATED",
        actor, previousImei: digits(credit.imei), newImei: digits(credit.imei), reason: motive,
        beforeContact: before, afterContact: after, status: "UPDATED" });
    } else {
      await lockSolicitudOperationMutation(db, targetId);
      if (await getUnresolvedDraftDispatch(targetId, db))
        throw new ApprovalOperationalError("SIGNATURE_PENDING",
          "Hay una firma en preparación o envío. Consulta su estado antes de cambiar el contacto.");
      const draft = await readDraft(db, targetId, true);
      if (draft.currentStep < 3 || draft.currentStep > 4)
        throw new ApprovalOperationalError("DRAFT_STEP_CHANGED", "La solicitud ya no está en Identidad y firma.");
      const process = await currentProcess(db, kind, targetId);
      if ((process?.processUuid || null) !== (input.expectedProcessUuid || null))
        throw new ApprovalOperationalError("PROCESS_CHANGED", "La firma cambió. Actualiza el caso.");
      if (process && !(process.completedAt || isFirmaSeguroCompletedStatus(process.status)
        || isFirmaSeguroFailedStatus(process.status)))
        throw new ApprovalOperationalError("SIGNATURE_PENDING", "La firma sigue activa. Actualiza su estado antes de cambiar el contacto.");
      if (!await signedDraftSource(db, targetId))
        throw new ApprovalOperationalError("SIGNED_DOCUMENT_REQUIRED",
          "Error técnico: requiere revisión. No hay contrato firmado verificable para actualizar y reenviar.");
      const payload = object(draft.payload);
      if (clean(payload.plataformaDispositivo, 32).toUpperCase() !== "IPHONE")
        throw new ApprovalOperationalError("IPHONE_REQUIRED", "Esta operación está disponible por ahora únicamente para iPhone.");
      const before = { clienteTelefono: clean(payload.clienteTelefono, 30), clienteCorreo: clean(payload.clienteCorreo, 254) };
      const after = { clienteTelefono: nextPhone ?? before.clienteTelefono, clienteCorreo: nextEmail ?? before.clienteCorreo };
      if (before.clienteTelefono === after.clienteTelefono && before.clienteCorreo === after.clienteCorreo)
        throw new ApprovalOperationalError("CONTACT_UNCHANGED", "El contacto no cambió.", 400);
      const updated: Record<string, unknown> = { ...payload, ...after, wizardStep: 4, firmaSeguroContactCorrectionPending: true };
      delete updated.financialTermsSeal;
      delete updated.firmaSeguroDraftFolio;
      await db.$executeRawUnsafe(`UPDATE "CreditoBorrador" SET "payload"=$2::jsonb,"clienteTelefono"=$3,
        "currentStep"=4,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, targetId, JSON.stringify(updated), after.clienteTelefono);
      if (process) await markFirmaSeguroDraftProcessesSuperseded(db, { draftId: targetId,
        actorUserId: actor.id, reason: motive });
      await insertAction(db, { id, kind, targetId, eventType: "CONTACT_UPDATED", actor,
        previousImei: digits(draft.imei), newImei: digits(draft.imei), reason: motive,
        beforeContact: before, afterContact: after, status: "PENDING_REISSUE" });
    }
    return { id, status: "UPDATED", message: kind === "DRAFT"
      ? "Contacto actualizado y firma anterior archivada. Verifica el expediente antes de reenviar."
      : "Contacto actualizado. Ya puedes solicitar una nueva versión del contrato." };
  }, { timeout: 15000 });
}

export async function requestOperationalSignature(kind: OperationalKind, targetId: number, input: {
  reason: unknown; idempotencyKey: unknown; expectedProcessUuid: unknown; confirmed: unknown;
  expectedRevision?: unknown; expectedReviewHash?: unknown;
}, actor: OperationalActor) {
  assertActor(actor);
  assertConfirmed(input.confirmed);
  const id = operationId(input.idempotencyKey);
  const motive = reason(input.reason);
  if (!Number.isSafeInteger(targetId) || targetId < 1)
    throw new ApprovalOperationalError("INVALID_CASE", "Selecciona un caso válido.", 400);
  if (kind === "DRAFT") {
    const draft = await readDraft(prisma, targetId);
    if (draft.currentStep < 3 || draft.currentStep > 4
      || clean(object(draft.payload).plataformaDispositivo, 32).toUpperCase() !== "IPHONE")
      throw new ApprovalOperationalError("DRAFT_NOT_ELIGIBLE",
        "La solicitud iPhone ya no está en Identidad y firma.");
    return requestSafeDraftSignature({ draftId: targetId, actor, reason: motive,
      idempotencyKey: id, expectedProcessUuid: typeof input.expectedProcessUuid === "string"
        ? input.expectedProcessUuid : null });
  }
  await ensureApprovalOperationalSchema();
  const credit = await readCredit(prisma, targetId);
  if (!credit.paidToAlly) {
    if (!credit.hasApprovalReview || String(credit.platform).toUpperCase() !== "IPHONE")
      throw new ApprovalOperationalError("APPROVAL_FLOW_REQUIRED",
        "El crédito no tiene una revisión de Aprobaciones vigente para reenviar la firma.");
    const process = await currentProcess(prisma, kind, targetId);
    if (!process) return requestInitialApprovalSignature(targetId, {
      idempotencyKey: id, expectedProcessUuid: input.expectedProcessUuid,
      expectedRevision: input.expectedRevision, expectedReviewHash: input.expectedReviewHash,
      reason: motive,
    }, actor);
    const parsed = parseCreditApprovalReissue({ action: "REQUEST", reason: motive,
      idempotencyKey: id, expectedProcessUuid: input.expectedProcessUuid,
      expectedRevision: input.expectedRevision });
    if (parsed.action !== "REQUEST" || typeof input.expectedReviewHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.expectedReviewHash))
      throw new ApprovalOperationalError("REVIEW_CHANGED", "Actualiza la revisión antes de reenviar la firma.", 409);
    const detail = await getCreditApprovalDetail(prisma, targetId, actor);
    if (detail.review.revision !== parsed.expectedRevision ||
      detail.review.reviewHash !== input.expectedReviewHash)
      throw new ApprovalOperationalError("REVIEW_CHANGED", "El expediente cambió. Actualiza los datos antes de reenviar.");
    if (!detail.capabilities.canReissueSignature)
      throw new CreditApprovalError("REISSUE_NOT_ALLOWED",
        detail.capabilities.correctionBlockedReason || "La firma vigente no está verificada para reenviar.", 409);
    const version = await latestVersion(prisma, targetId);
    if (version && (PENDING as readonly string[]).includes(version.status))
      throw new ApprovalOperationalError("SIGNATURE_PENDING", "Hay una nueva firma en curso. Espera su resultado.");
    const replacements = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id"::text FROM "CreditDeviceReplacement" WHERE "creditId"=$1
       AND "status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED') LIMIT 1`, targetId);
    if (replacements.length) throw new ApprovalOperationalError("REPLACEMENT_PENDING",
      "Hay un cambio de equipo en revisión. Espera su aprobación antes de reenviar la firma.");
    const reissue = await requestCreditApprovalReissue(targetId, parsed, actor);
    return { id, status: reissue.operation?.status || "UNCERTAIN",
      message: reissue.operation?.message || "La solicitud de firma quedó registrada. Consulta su estado." };
  }
  assertSettledOperationalCredit(credit);
  return requestOperationalVersion({ creditId: targetId, actor, idempotencyKey: id,
    expectedProcessUuid: String(input.expectedProcessUuid || ""), reason: motive });
}
