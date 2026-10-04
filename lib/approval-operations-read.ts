import "server-only";
import prisma from "@/lib/prisma";
import { resolveAllyPaymentPlatform } from "@/lib/ally-payments-core";
import { isVerifiedTerminalSignatureFailure } from "@/lib/approval-operations-core";
import {
  isFirmaSeguroFailedStatus,
  isFirmaSeguroSuccessfulStatus,
} from "@/lib/firmaseguro-status";
import type {
  OperationalCaseDetail,
  OperationalCaseKind,
  OperationalCaseSummary,
  OperationalSignature,
  OperationalTimelineEvent,
} from "@/lib/approval-operations-types";

type Database = Pick<typeof prisma, "$queryRawUnsafe">;
type CreditRow = {
  id: number;
  folio: string;
  visibleNumber: string | null;
  clienteNombre: string;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  clienteCorreo: string | null;
  estado: string;
  imei: string;
  referenciaEquipo: string | null;
  equipoMarca: string | null;
  equipoModelo: string | null;
  contratoSnapshot?: unknown;
  hasAllySettlement?: boolean;
  hasFinishedDraft?: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type DraftRow = {
  id: number;
  estado: string;
  currentStep: number;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  clienteCorreo: string | null;
  imei: string | null;
  plataforma: string | null;
  payload: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt: Date | string | null;
};
type SignatureRow = {
  id: number;
  processUuid: string;
  status: string;
  draftPayload: unknown;
  requestPayload: unknown;
  lastError: string | null;
  hasSignedDocument: boolean;
  createdAt: Date | string;
  completedAt: Date | string | null;
  supersededAt: Date | string | null;
};
type ReplacementRow = {
  id: string;
  status: string;
  previousImei: string;
  newImei: string;
  reason: string;
  createdAt: Date | string;
};
type ReplacementEventRow = {
  id: string;
  eventType: string;
  actorName: string | null;
  createdAt: Date | string;
};
type DraftImeiEventRow = {
  id: string;
  eventType: string;
  actorName: string | null;
  reason: string | null;
  createdAt: Date | string;
};
type EnrollmentReviewRow = { id: string };
type OperationalActionRow = {
  id: string;
  eventType: string;
  actorName: string | null;
  reason: string | null;
  status: string | null;
  evidenceSha256: string | null;
  previousImei: string | null;
  newImei: string | null;
  createdAt: Date | string;
};
type ContractVersionRow = {
  id: string;
  version: number;
  status: string;
  replacementId: string | null;
  previousProcessUuid: string;
  supersededProcessUuid?: string | null;
  actorName: string;
  reason: string;
  previousImei: string;
  newImei: string;
  newProcessUuid: string | null;
  sentPhone: string | null;
  sentEmail: string | null;
  requestedAt: Date | string;
  lastCheckedAt: Date | string | null;
  completedAt: Date | string | null;
};

export class OperationalCaseReadError extends Error {
  constructor(
    readonly code: "INVALID_SEARCH" | "INVALID_CASE" | "CASE_NOT_FOUND",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OperationalCaseReadError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function clean(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result || null;
}
function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function equipment(reference: unknown, brand: unknown, model: unknown) {
  return clean(reference) || [clean(brand), clean(model)].filter(Boolean).join(" ") || "Equipo sin referencia";
}
function isIphone(value: unknown) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "IPHONE" || normalized === "APPLE";
}

export function operationalSearchTerm(value: unknown) {
  if (typeof value !== "string" || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OperationalCaseReadError("INVALID_SEARCH", "Busca por cédula, crédito o IMEI con hasta 100 caracteres.", 400);
  }
  const term = value.trim();
  if (term.length < 3) {
    throw new OperationalCaseReadError("INVALID_SEARCH", "Escribe al menos tres caracteres de cédula, crédito o IMEI.", 400);
  }
  return { term, digits: term.replace(/\D/g, "") };
}

export function operationalCaseIdentity(kind: unknown, id: unknown): { kind: OperationalCaseKind; id: number } {
  const normalizedKind = String(kind || "").toUpperCase();
  const rawId = String(id || "");
  const parsedId = Number(rawId);
  if ((normalizedKind !== "CREDIT" && normalizedKind !== "DRAFT") ||
    !/^\d+$/.test(rawId) || !Number.isSafeInteger(parsedId) || parsedId < 1) {
    throw new OperationalCaseReadError("INVALID_CASE", "El expediente indicado no es válido.", 400);
  }
  return { kind: normalizedKind, id: parsedId };
}

function creditSummary(row: CreditRow): OperationalCaseSummary {
  return {
    kind: "CREDIT", id: row.id, number: clean(row.visibleNumber) || row.folio,
    clientName: clean(row.clienteNombre) || "Cliente", document: clean(row.clienteDocumento),
    phone: clean(row.clienteTelefono), email: clean(row.clienteCorreo),
    status: clean(row.estado) || "Sin estado",
    equipment: equipment(row.referenciaEquipo, row.equipoMarca, row.equipoModelo),
    imei: clean(row.imei) || "", updatedAt: iso(row.updatedAt) || "",
  };
}
function draftSummary(row: DraftRow): OperationalCaseSummary {
  const payload = record(row.payload);
  return {
    kind: "DRAFT", id: row.id, number: `SOL-${String(row.id).padStart(6, "0")}`,
    clientName: clean(row.clienteNombre) || clean(payload.clienteNombre) || "Cliente",
    document: clean(row.clienteDocumento) || clean(payload.clienteDocumento),
    phone: clean(row.clienteTelefono) || clean(payload.clienteTelefono),
    email: clean(row.clienteCorreo) || clean(payload.clienteCorreo),
    status: row.currentStep === 3 ? "Identidad y firma" : `Paso ${row.currentStep}`,
    equipment: equipment(payload.referenciaEquipo, payload.equipoMarca, payload.equipoModelo),
    imei: clean(row.imei) || clean(payload.imei) || "", updatedAt: iso(row.updatedAt) || "",
  };
}

const CREDIT_SEARCH = `SELECT credit."id",credit."folio",
  COALESCE(NULLIF(BTRIM(sadmin."numeroCredito"),''),credit."folio") AS "visibleNumber",
  credit."clienteNombre",credit."clienteDocumento",credit."clienteTelefono",credit."clienteCorreo",
  credit."estado",credit."imei",credit."referenciaEquipo",credit."equipoMarca",credit."equipoModelo",
  credit."createdAt",credit."updatedAt"
  FROM "Credito" credit
  LEFT JOIN "CreditSadminRegistration" sadmin ON sadmin."creditoId"=credit."id" AND sadmin."numeroCreditoConfirmado"
  WHERE strpos(lower(COALESCE(credit."clienteDocumento",'')),lower($1::text))>0
    OR strpos(lower(credit."folio"),lower($1::text))>0
    OR strpos(lower(COALESCE(sadmin."numeroCredito",'')),lower($1::text))>0
    OR strpos(COALESCE(credit."imei",''),$1::text)>0
    OR strpos(COALESCE(credit."deviceUid",''),$1::text)>0
    OR ($2::text<>'' AND strpos(regexp_replace(COALESCE(credit."clienteDocumento",''),'[^0-9]','','g'),$2::text)>0)
  ORDER BY credit."updatedAt" DESC,credit."id" DESC LIMIT 25`;

const DRAFT_SEARCH = `SELECT draft."id",draft."estado",draft."currentStep",draft."clienteNombre",
  draft."clienteDocumento",draft."clienteTelefono",draft."payload"->>'clienteCorreo' AS "clienteCorreo",
  draft."imei",draft."plataforma",draft."payload",draft."createdAt",draft."updatedAt",draft."expiresAt"
  FROM "CreditoBorrador" draft
  WHERE draft."estado"='ABIERTO' AND draft."creditoId" IS NULL AND draft."currentStep" IN (3,4)
    AND COALESCE(draft."expiresAt",draft."createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP
    AND (strpos(lower(COALESCE(draft."clienteDocumento",'')),lower($1::text))>0
      OR strpos(lower(('SOL-'||LPAD(draft."id"::text,6,'0'))),lower($1::text))>0
      OR strpos(draft."id"::text,$1::text)>0
      OR strpos(COALESCE(draft."imei",''),$1::text)>0
      OR ($2::text<>'' AND strpos(regexp_replace(COALESCE(draft."clienteDocumento",''),'[^0-9]','','g'),$2::text)>0))
  ORDER BY draft."updatedAt" DESC,draft."id" DESC LIMIT 25`;

export async function searchOperationalCases(value: unknown, db: Database = prisma): Promise<OperationalCaseSummary[]> {
  const { term, digits } = operationalSearchTerm(value);
  const [credits, drafts] = await Promise.all([
    db.$queryRawUnsafe<CreditRow[]>(CREDIT_SEARCH, term, digits),
    db.$queryRawUnsafe<DraftRow[]>(DRAFT_SEARCH, term, digits),
  ]);
  return [...credits.map(creditSummary), ...drafts.map(draftSummary)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 30)
    .map(item => ({
      ...item,
      document: item.document ? `•••• ${item.document.replace(/\s/g, "").slice(-4)}` : null,
      phone: null,
      email: null,
      imei: "",
    }));
}

function signatureContact(row: SignatureRow, fallback: { phone: string | null; email: string | null }) {
  const request = record(row.requestPayload);
  const signer = Array.isArray(request.signers) ? record(request.signers[0]) : {};
  const signature = Array.isArray(request.signatures) ? record(request.signatures[0]) : {};
  const contact = record(signature.contactInformation);
  const draft = record(row.draftPayload);
  return {
    phone: clean(signer.number) || clean(record(contact.phone).number) || clean(draft.clienteTelefono) || fallback.phone,
    email: clean(signer.email) || clean(contact.email) || clean(draft.clienteCorreo) || fallback.email,
  };
}
export function operationalSignatureState(row: SignatureRow | null): OperationalSignature["status"] {
  if (!row) return "NOT_SENT";
  if (row.hasSignedDocument) return "SIGNED";
  if (row.completedAt || isFirmaSeguroSuccessfulStatus(row.status) ||
    row.lastError || isFirmaSeguroFailedStatus(row.status)) return "TECHNICAL_ERROR";
  return "PENDING";
}
function signatureDetail(rows: SignatureRow[], fallback: { phone: string | null; email: string | null }): OperationalSignature {
  const active = rows.find((row) => !row.supersededAt) || null;
  const status = operationalSignatureState(active);
  const contact = active ? signatureContact(active, fallback) : fallback;
  return {
    status, rawStatus: status === "TECHNICAL_ERROR" ? null : clean(active?.status),
    processUuid: clean(active?.processUuid), sentPhone: active ? contact.phone : null,
    sentEmail: active ? contact.email : null,
    sentAt: active ? iso(active.createdAt) : null,
    signedAt: active && status === "SIGNED" ? iso(active.completedAt) : null,
  };
}

function signatureTimeline(rows: SignatureRow[]): OperationalTimelineEvent[] {
  return rows.flatMap((row) => {
    const status = operationalSignatureState(row);
    const events: OperationalTimelineEvent[] = [];
    const sent = iso(row.createdAt);
    const signed = iso(row.completedAt);
    if (sent) events.push({ id: `firma:${row.id}:enviada`, at: sent, label: "Firma enviada", detail: null, actor: null });
    if (signed && status === "SIGNED") events.push({ id: `firma:${row.id}:firmada`, at: signed, label: "Firma firmada", detail: null, actor: null });
    else if (status === "TECHNICAL_ERROR" && (signed || sent)) events.push({
      id: `firma:${row.id}:error`, at: signed || sent!, label: "Error técnico: requiere revisión", detail: null, actor: null,
    });
    return events;
  });
}

function missingRelation(error: unknown) {
  const value = error && typeof error === "object" ? error as { code?: string; meta?: { code?: string } } : {};
  return value.code === "42P01" || value.meta?.code === "42P01";
}
async function optionalQuery<T>(db: Database, sql: string, ...params: unknown[]): Promise<T[]> {
  try { return await db.$queryRawUnsafe<T[]>(sql, ...params); }
  catch (error) { if (missingRelation(error)) return []; throw error; }
}
async function relationExists(db: Database, name: string) {
  const rows = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
    'SELECT to_regclass($1::text) IS NOT NULL AS "present"', `public."${name}"`);
  return rows[0]?.present === true;
}

function creditCapabilities(row: CreditRow, signature: OperationalSignature, replacement: ReplacementRow | null,
  pendingVersion: ContractVersionRow | null, latestVersion: ContractVersionRow | null,
  signatures: SignatureRow[], versions: ContractVersionRow[], originalSourceSigned: boolean) {
  const platform = resolveAllyPaymentPlatform(row.contratoSnapshot, row.equipoMarca);
  const state = String(row.estado).trim().toUpperCase();
  const cancelled = ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(state);
  // Historical credits without a closed origin draft remain eligible only when
  // their persisted state explicitly says the obligation was finalized.
  const eligible = !cancelled && (row.hasFinishedDraft === true ||
    ["FINALIZADO", "PAGADO", "PAZ_Y_SALVO"].includes(state));
  const settledToAlly = row.hasAllySettlement === true;
  const pendingReplacement = replacement && ["PENDING_ENROLLMENT", "ENROLLMENT_APPROVED"].includes(replacement.status);
  const versionPending = Boolean(pendingVersion);
  const terminalAnchor = versions.find((version) => version.status === "TECHNICAL_ERROR" &&
    version.newProcessUuid === signature.processUuid);
  const failedProcess = signatures.find((process) => process.processUuid === signature.processUuid &&
    !process.supersededAt);
  const retryFromTerminal = Boolean(terminalAnchor &&
    (latestVersion?.id === terminalAnchor.id ||
      (latestVersion?.status === "FAILED_SAFE" &&
        (latestVersion.supersededProcessUuid || latestVersion.previousProcessUuid) === signature.processUuid)));
  const terminalRetry = Boolean(retryFromTerminal &&
    terminalAnchor?.lastCheckedAt && failedProcess && !failedProcess.completedAt &&
    !failedProcess.hasSignedDocument && isVerifiedTerminalSignatureFailure(failedProcess.status) &&
    signature.status === "TECHNICAL_ERROR" &&
    originalSourceSigned && !versionPending);
  const canResumePreparation = pendingVersion?.status === "PREPARING" &&
    replacement?.status === "COMPLETED" && pendingVersion.replacementId === replacement.id;
  const canFinalizeImei = Boolean(eligible && settledToAlly && platform === "IPHONE" && signature.status === "SIGNED" &&
    ((replacement?.status === "ENROLLMENT_APPROVED" && !versionPending) || canResumePreparation));
  const canChangeImei = Boolean(eligible && settledToAlly && platform === "IPHONE" && !versionPending && signature.status === "SIGNED" && !pendingReplacement);
  const canUpdateContact = Boolean(eligible && settledToAlly && platform === "IPHONE" && !versionPending &&
    !pendingReplacement && (signature.status === "SIGNED" || terminalRetry));
  const canResendSignature = Boolean(eligible && settledToAlly && platform === "IPHONE" && !versionPending &&
    !pendingReplacement && (signature.status === "SIGNED" || terminalRetry));
  const reason = !eligible ? "El cambio por garantía requiere un crédito finalizado y vigente."
    : platform !== "IPHONE" ? "El cambio de IMEI por garantía está disponible solo para iPhone."
    : !settledToAlly ? "El crédito aún está en revisión o pendiente de liquidación al aliado. Gestiona este caso en el flujo de aprobaciones."
    : versionPending && !canResumePreparation ? pendingVersion?.status === "UNCERTAIN"
      ? "Error técnico: requiere revisión. No se pudo confirmar el envío de la nueva firma."
      : "Hay una nueva versión de contrato o firma en curso. Consulta su estado antes de continuar."
    : replacement?.status === "PENDING_ENROLLMENT" ? "Espera la aprobación del enrolamiento del equipo nuevo."
    : terminalRetry ? null
    : !signature.processUuid ? "No hay una firma vigente para regenerar el contrato. Requiere revisión."
    : signature.status === "TECHNICAL_ERROR" ? "Error técnico: requiere revisión. No hay un contrato firmado vigente verificable."
    : signature.status === "PENDING" ? "La firma vigente sigue en curso. Consulta su estado antes de continuar."
    : null;
  return { canChangeImei, canFinalizeImei, canConfirmReplacement: canFinalizeImei,
    canDispatchSignatureWithImei: false,
    canUpdateContact, canResendSignature, reason };
}
function draftCapabilities(row: DraftRow, signature: OperationalSignature,
  signatures: SignatureRow[], unresolvedDispatch: boolean) {
  const platform = clean(row.plataforma) || clean(record(row.payload).plataformaDispositivo);
  const payload = record(row.payload);
  const open = row.estado === "ABIERTO" && [3, 4].includes(row.currentStep) &&
    (!row.expiresAt || new Date(row.expiresAt).getTime() > Date.now());
  const supported = isIphone(platform);
  const correctionPending = payload.firmaSeguroCorrectionPending === true ||
    payload.firmaSeguroContactCorrectionPending === true;
  const archivedSource = signatures.find((item) => item.supersededAt &&
    (item.completedAt || item.hasSignedDocument));
  const signedArchivedSource = Boolean(archivedSource?.hasSignedDocument &&
    record(archivedSource.draftPayload).financialTermsSeal);
  const canChangeImei = open && supported && /^\d{15}$/.test(clean(row.imei) || "") &&
    signature.status === "SIGNED" && !unresolvedDispatch;
  const canUpdateContact = open && supported && signature.status === "SIGNED" && !unresolvedDispatch;
  const canResendSignature = Boolean(open && supported && correctionPending &&
    signature.status === "NOT_SENT" && signedArchivedSource && !unresolvedDispatch);
  const reason = !open ? "La solicitud ya no está abierta en Identidad y firma."
    : !supported ? "El cambio de IMEI con nueva firma está disponible solo para iPhone."
    : unresolvedDispatch ? "Hay un envío de firma en curso o pendiente de conciliación."
    : correctionPending && !signedArchivedSource ? "Error técnico: requiere revisión. No hay un contrato firmado verificable para regenerar."
    : signature.status === "TECHNICAL_ERROR" ? "Error técnico: requiere revisión. No hay un contrato firmado verificable para regenerar."
    : canResendSignature ? null
    : !signature.processUuid ? "La solicitud aún no tiene una firma para reemplazar."
    : signature.status === "PENDING" ? "La firma sigue en curso. Consulta su estado antes de cambiar el IMEI."
    : null;
  return { canChangeImei, canFinalizeImei: false, canConfirmReplacement: false,
    // Draft correction first moves the saved application back through its
    // signing gates. Correction alone is not evidence of provider dispatch.
    canDispatchSignatureWithImei: false,
    canUpdateContact, canResendSignature, reason };
}

const CREDIT_DETAIL = `SELECT credit."id",credit."folio",
  COALESCE(NULLIF(BTRIM(sadmin."numeroCredito"),''),credit."folio") AS "visibleNumber",
  credit."clienteNombre",credit."clienteDocumento",credit."clienteTelefono",credit."clienteCorreo",
  credit."estado",credit."imei",credit."referenciaEquipo",credit."equipoMarca",credit."equipoModelo",
  credit."contratoSnapshot",credit."createdAt",credit."updatedAt",
  EXISTS (SELECT 1 FROM "LiquidacionAliadoCredito" paid WHERE paid."creditoId"=credit."id") AS "hasAllySettlement",
   EXISTS (SELECT 1 FROM "CreditoBorrador" draft WHERE draft."creditoId"=credit."id"
     AND draft."estado"='CERRADO' AND draft."closedReason"='FINALIZADA') AS "hasFinishedDraft"
  FROM "Credito" credit
  LEFT JOIN "CreditSadminRegistration" sadmin ON sadmin."creditoId"=credit."id" AND sadmin."numeroCreditoConfirmado"
  WHERE credit."id"=$1 LIMIT 1`;
const DRAFT_DETAIL = `SELECT draft."id",draft."estado",draft."currentStep",draft."clienteNombre",
  draft."clienteDocumento",draft."clienteTelefono",draft."payload"->>'clienteCorreo' AS "clienteCorreo",
  draft."imei",draft."plataforma",draft."payload",draft."createdAt",draft."updatedAt",draft."expiresAt"
  FROM "CreditoBorrador" draft WHERE draft."id"=$1 AND draft."estado"='ABIERTO'
    AND draft."creditoId" IS NULL AND draft."currentStep" IN (3,4)
    AND COALESCE(draft."expiresAt",draft."createdAt"+INTERVAL '15 days')>CURRENT_TIMESTAMP LIMIT 1`;
const SIGNATURES = `SELECT "id","processUuid","status","draftPayload","requestPayload","lastError",
  (LEFT(COALESCE("signedDocumentBase64",''),7)='JVBERi0') AS "hasSignedDocument",
  "createdAt","completedAt","supersededAt"
  FROM "FirmaSeguroProcess" WHERE %KEY%=$1 %CREDIT_FILTER%
  ORDER BY "createdAt" DESC,"id" DESC LIMIT 12`;

export async function getOperationalCase(kindValue: unknown, idValue: unknown, db: Database = prisma): Promise<OperationalCaseDetail> {
  const { kind, id } = operationalCaseIdentity(kindValue, idValue);
  const rows = kind === "CREDIT"
    ? await db.$queryRawUnsafe<CreditRow[]>(CREDIT_DETAIL, id)
    : await db.$queryRawUnsafe<DraftRow[]>(DRAFT_DETAIL, id);
  if (!rows[0]) throw new OperationalCaseReadError("CASE_NOT_FOUND", "Expediente no encontrado.", 404);
  const summary = kind === "CREDIT" ? creditSummary(rows[0] as CreditRow) : draftSummary(rows[0] as DraftRow);
  const signatures = await db.$queryRawUnsafe<SignatureRow[]>(SIGNATURES
    .replace("%KEY%", kind === "CREDIT" ? '"creditoId"' : '"draftId"')
    .replace("%CREDIT_FILTER%", kind === "CREDIT" ? "" : 'AND "creditoId" IS NULL'), id);
  const signature = signatureDetail(signatures, summary);
  const timeline = signatureTimeline(signatures);
  let replacement: ReplacementRow | null = null;
  let enrollmentReviewId: string | null = null;
  let versions: ContractVersionRow[] = [];
  let originalSourceSigned = false;
  let unresolvedDraftDispatch = false;
  if (kind === "CREDIT") {
    if (await relationExists(db, "ApprovalOperationalContractVersion")) {
      versions = await optionalQuery<ContractVersionRow>(db,
        `SELECT "id"::text,"version","status","replacementId"::text,"previousProcessUuid",
          NULLIF(to_jsonb(versionRow)->>'supersededProcessUuid','') AS "supersededProcessUuid",
          "actorName","reason","previousImei","newImei",
          "newProcessUuid","sentPhone","sentEmail","requestedAt","lastCheckedAt","completedAt"
         FROM "ApprovalOperationalContractVersion" versionRow WHERE "creditoId"=$1
         ORDER BY "version" DESC LIMIT 15`, id);
      if (versions.length && signature.status === "TECHNICAL_ERROR") {
        const source = await optionalQuery<{ signed: boolean }>(db,
          `SELECT EXISTS (
             SELECT 1 FROM "ApprovalOperationalContractVersion" originalVersion
             JOIN "FirmaSeguroProcess" original
               ON original."processUuid"=originalVersion."previousProcessUuid"
              AND original."creditoId"=originalVersion."creditoId"
             WHERE originalVersion."creditoId"=$1
               AND originalVersion."version"=(SELECT MIN("version") FROM "ApprovalOperationalContractVersion"
                 WHERE "creditoId"=$1)
               AND original."supersededAt" IS NOT NULL
               AND LEFT(COALESCE(original."signedDocumentBase64",''),7)='JVBERi0'
               AND (original."completedAt" IS NOT NULL OR original."status" IN ('SIGNED','COMPLETED'))
               AND original."draftPayload"->'financialTermsSeal' IS NOT NULL
           ) AS "signed"`, id);
        originalSourceSigned = source[0]?.signed === true;
      }
    }
    const activeVersion = versions.find((version) =>
      version.newProcessUuid && version.newProcessUuid === signature.processUuid);
    if (activeVersion) {
      signature.sentPhone = clean(activeVersion.sentPhone) || signature.sentPhone;
      signature.sentEmail = clean(activeVersion.sentEmail) || signature.sentEmail;
    }
    for (const version of versions) {
      const at = iso(version.requestedAt);
      const detail = `Versión ${version.version} · IMEI ${version.previousImei} → ${version.newImei}. ${version.reason}`;
      if (at) timeline.push({ id: `contrato:${version.id}`, at,
        label: ["FAILED_SAFE", "UNCERTAIN", "TECHNICAL_ERROR"].includes(version.status)
          ? "Error técnico: requiere revisión"
          : version.status === "PREPARING" ? "Preparando nueva versión del contrato"
          : version.status === "DISPATCHING" ? "Enviando nueva firma"
          : "Nueva versión de contrato solicitada",
        detail, actor: clean(version.actorName), status: version.status });
      const completedAt = iso(version.completedAt);
      if (completedAt) timeline.push({ id: `contrato:${version.id}:firmado`, at: completedAt,
        label: "Nueva versión firmada", detail: `Versión ${version.version}`,
        actor: null, status: "COMPLETED" });
    }
    const records = await optionalQuery<ReplacementRow>(db,
      `SELECT "id"::text,"status","previousImei","newImei","reason","createdAt"
       FROM "CreditDeviceReplacement" WHERE "creditId"=$1
       ORDER BY CASE WHEN "status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED') THEN 0 ELSE 1 END,
       "createdAt" DESC LIMIT 1`, id);
    replacement = records[0] || null;
    const events = await optionalQuery<ReplacementEventRow>(db,
      `SELECT event."id"::text,event."eventType",event."actorName",event."createdAt"
       FROM "CreditDeviceReplacementEvent" event
       JOIN "CreditDeviceReplacement" replacement ON replacement."id"=event."replacementId"
       WHERE replacement."creditId"=$1 ORDER BY event."createdAt" DESC LIMIT 25`, id);
    const labels: Record<string, string> = {
      CREATED: "Cambio de IMEI solicitado", ENROLLMENT_APPROVED: "Enrolamiento aprobado",
      COMPLETED: "Cambio de IMEI aplicado", CANCELLED: "Cambio de IMEI cancelado",
    };
    for (const event of events) {
      const at = iso(event.createdAt);
      if (at) timeline.push({ id: `imei:${event.id}`, at,
        label: labels[event.eventType] || "Cambio de IMEI actualizado", detail: null, actor: clean(event.actorName) });
    }
    const createdAt = iso((rows[0] as CreditRow).createdAt);
    if (createdAt) timeline.push({ id: `credit:${id}`, at: createdAt,
      label: "Crédito registrado", detail: null, actor: null });
  } else {
    if (await relationExists(db, "FirmaSeguroDraftDispatch")) {
      const dispatch = await optionalQuery<Array<{ id: string }>[number]>(db,
        `SELECT "id"::text FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=$1
         AND "status" IN ('PREPARING','DISPATCHING','UNCERTAIN') LIMIT 1`, id);
      unresolvedDraftDispatch = dispatch.length > 0;
    }
    const reviews = await optionalQuery<EnrollmentReviewRow>(db,
      `SELECT "id"::text FROM "IphoneEnrollmentReview"
       WHERE "solicitudId"=$1 AND "supersededAt" IS NULL
       ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, id);
    enrollmentReviewId = reviews[0]?.id || null;
    const events = await optionalQuery<DraftImeiEventRow>(db,
      `SELECT "id"::text,"eventType","actorName","reason","createdAt"
       FROM "SolicitudImeiCorrectionAudit" WHERE "draftId"=$1
       ORDER BY "createdAt" DESC LIMIT 25`, id);
    for (const event of events) {
      const at = iso(event.createdAt);
      if (at) timeline.push({ id: `imei:${event.id}`, at,
        label: event.eventType === "REISSUED" ? "Nueva firma enviada" : "IMEI corregido",
        detail: clean(event.reason), actor: clean(event.actorName) });
    }
    const createdAt = iso((rows[0] as DraftRow).createdAt);
    if (createdAt) timeline.push({ id: `draft:${id}`, at: createdAt,
      label: "Solicitud registrada", detail: null, actor: null });
  }
  const operationalEvents = await relationExists(db, "ApprovalOperationalAction")
    ? await optionalQuery<OperationalActionRow>(db,
      `SELECT "id"::text,"eventType","actorName","reason","status","evidenceSha256",
         "previousImei","newImei","createdAt"
       FROM "ApprovalOperationalAction" WHERE "targetKind"=$1 AND "targetId"=$2
       ORDER BY "createdAt" DESC LIMIT 25`, kind, id)
    : [];
  for (const event of operationalEvents) {
    const at = iso(event.createdAt);
    if (!at) continue;
    const label = event.eventType === "CONTACT_UPDATED" ? "Contacto actualizado"
      : event.eventType === "SIGNATURE_REQUESTED" ? "Preparación de nueva firma"
      : event.eventType === "IMEI_APPLIED" ? "Cambio de IMEI aplicado"
      : event.eventType === "IMEI_CORRECTED" ? "IMEI corregido"
      : event.eventType === "IMEI_REQUESTED" ? "Cambio de IMEI solicitado"
      : "Gestión del expediente";
    const imeiChange = event.previousImei && event.newImei
      ? `IMEI ${event.previousImei} → ${event.newImei}` : null;
    timeline.push({ id: `operativo:${event.id}`, at, label,
      detail: [clean(event.reason), imeiChange].filter(Boolean).join(" · ") || null,
      actor: clean(event.actorName), status: clean(event.status),
      evidenceHref: event.evidenceSha256 ? `/api/aprobaciones/operativo/evidencia/${event.id}` : null });
  }
  timeline.sort((a, b) => b.at.localeCompare(a.at));
  const pendingVersion = kind === "CREDIT"
    ? versions.find((version) => ["PREPARING", "DISPATCHING", "AWAITING_SIGNATURE", "UNCERTAIN"].includes(version.status)) || null
    : null;
  return {
    ...summary, signature, enrollmentReviewId,
    requiresEnrollmentReapproval: Boolean(enrollmentReviewId),
    pendingVersion: pendingVersion ? {
      id: pendingVersion.id, status: pendingVersion.status,
      replacementId: pendingVersion.replacementId,
      previousProcessUuid: pendingVersion.previousProcessUuid,
      newProcessUuid: pendingVersion.newProcessUuid,
    } : null,
    replacement: replacement ? { ...replacement, createdAt: iso(replacement.createdAt) || "" } : null,
    timeline: timeline.slice(0, 30),
    capabilities: kind === "CREDIT"
      ? creditCapabilities(rows[0] as CreditRow, signature, replacement, pendingVersion,
          versions[0] || null, signatures, versions, originalSourceSigned)
      : draftCapabilities(rows[0] as DraftRow, signature, signatures, unresolvedDraftDispatch),
  };
}
