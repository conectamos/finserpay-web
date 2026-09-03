import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import {
  getIphoneEnrollmentIdentityKeyVersion,
  hashIphoneEnrollmentChecklist,
  hashIphoneEnrollmentDocument,
  hashIphoneEnrollmentGrantFingerprint,
  hashIphoneEnrollmentImei,
  hashIphoneEnrollmentSharedReviewFingerprint,
  IPHONE_ENROLLMENT_CHECKLIST_VERSION,
  IPHONE_ENROLLMENT_SHARED_ANALYST,
  type IphoneEnrollmentCaseTokenPayload,
  type IphoneEnrollmentChecklist,
} from "@/lib/iphone-enrollment";
import { isValidCreditDeviceReplacementImei } from "@/lib/credit-device-replacement";
import prisma from "@/lib/prisma";
import { lockSolicitudIdentityMutation } from "@/lib/solicitudes-storage";

export { isValidCreditDeviceReplacementImei } from "@/lib/credit-device-replacement";

type Database = typeof prisma | Prisma.TransactionClient;
export type CreditDeviceReplacementStatus =
  | "PENDING_ENROLLMENT"
  | "ENROLLMENT_APPROVED"
  | "COMPLETED"
  | "CANCELLED";
type ReplacementEventType =
  | "CREATED"
  | "ENROLLMENT_APPROVED"
  | "COMPLETED"
  | "CANCELLED";
type ReplacementActor = {
  userId: number;
  name: string;
  username?: string | null;
};
type ReplacementRow = {
  id: string;
  creditId: number;
  solicitudId: number;
  previousImei: string;
  newImei: string;
  reason: string;
  status: CreditDeviceReplacementStatus;
  requestedCreditUpdatedAt: Date | string;
  createdByUserId: number | null;
  createdByName: string;
  createdByUsername: string | null;
  correlationId: string;
  completedByUserId: number | null;
  completedByName: string | null;
  completedAt: Date | string | null;
  cancelledByUserId: number | null;
  cancelledByName: string | null;
  cancelledReason: string | null;
  cancelledAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ReplacementReviewRow = {
  id: string;
  replacementId: string;
  decision: "APROBADO";
  checklistVersion: string;
  checklist: unknown;
  documentHash: string;
  imeiHash: string;
  checklistHash: string;
  identityKeyVersion: string;
  grantId: string | null;
  grantIssuedByUserId: number | null;
  grantIssuedByName: string | null;
  accessFingerprint: string;
  analystName: string;
  analystExternalId: string;
  correlationId: string;
  approvedAt: Date | string;
  createdAt: Date | string;
};
type CreditContextRow = {
  creditId: number;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string | null;
  creditImei: string;
  creditDeviceUid: string;
  referenciaEquipo: string | null;
  equipoMarca: string | null;
  equipoModelo: string | null;
  estado: string;
  warrantyUntil: Date | string | null;
  creditUpdatedAt: Date | string;
  solicitudId: number | null;
  draftEstado: string | null;
  draftClosedReason: string | null;
  plataforma: string | null;
  sedeNombre: string | null;
  aliadoNombre: string | null;
};
type ReplacementContextRow = ReplacementRow &
  CreditContextRow & {
    reviewId: string | null;
    reviewDecision: "APROBADO" | null;
    reviewChecklistVersion: string | null;
    reviewChecklist: unknown;
    reviewDocumentHash: string | null;
    reviewImeiHash: string | null;
    reviewChecklistHash: string | null;
    reviewIdentityKeyVersion: string | null;
    reviewGrantId: string | null;
    reviewGrantIssuedByUserId: number | null;
    reviewGrantIssuedByName: string | null;
    reviewAccessFingerprint: string | null;
    reviewAnalystName: string | null;
    reviewAnalystExternalId: string | null;
    reviewCorrelationId: string | null;
    reviewApprovedAt: Date | string | null;
    reviewCreatedAt: Date | string | null;
  };

export type SerializedReplacementReview = {
  id: string;
  solicitudId: number;
  decision: "APROBADO";
  checklistVersion: string;
  checklist: unknown;
  checklistHash: string;
  analystName: string;
  analystExternalId: string;
  identityKeyVersion: string;
  grantId: string | null;
  grantIssuedBy: { userId: number; name: string } | null;
  correlationId: string;
  approvedAt: string;
  createdAt: string;
};
export type ReplacementEnrollmentCase = {
  targetType: "DEVICE_REPLACEMENT";
  targetId: string;
  solicitudId: number;
  solicitudNumero: string;
  currentStep: 4;
  clienteNombre: string;
  documentoMasked: string;
  imeiMasked: string;
  equipo: string;
  sede: string;
  aliado: string;
  documentHash: string;
  imeiHash: string;
  review: SerializedReplacementReview | null;
  operationLabel: "Cambio por garantía";
};
export type CreditDeviceReplacementOverview = {
  credit: {
    id: number;
    folio: string;
    clienteNombre: string;
    clienteDocumentoMasked: string;
    equipment: string;
    platform: string;
    currentImeiMasked: string;
  };
  replacement: {
    id: string;
    status: CreditDeviceReplacementStatus;
    newImeiMasked: string;
    reason: string;
    createdAt: string;
    completedAt: string | null;
    analystName: string | null;
  } | null;
};

export class CreditDeviceReplacementError extends Error {
  readonly code:
    | "SCHEMA_NOT_READY"
    | "CREDIT_NOT_FOUND"
    | "CREDIT_NOT_ELIGIBLE"
    | "WARRANTY_EXPIRED"
    | "IPHONE_REQUIRED"
    | "IMEI_INVALID"
    | "IMEI_UNCHANGED"
    | "IMEI_CONFLICT"
    | "REASON_INVALID"
    | "ACTIVE_REPLACEMENT_EXISTS"
    | "REPLACEMENT_NOT_FOUND"
    | "REPLACEMENT_NOT_PENDING"
    | "ENROLLMENT_REQUIRED"
    | "REPLACEMENT_CONCURRENT_CHANGE"
    | "REVIEW_INCONSISTENT"
    | "CASE_IDENTITY_CHANGED";
  readonly status: number;

  constructor(
    code: CreditDeviceReplacementError["code"],
    message: string,
    status = 409
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "CreditDeviceReplacementError";
  }
}

const ACTIVE_STATUSES = ["PENDING_ENROLLMENT", "ENROLLMENT_APPROVED"] as const;
const CANCELLED_CREDIT_STATES = new Set([
  "ANULADO",
  "ANULADA",
  "CANCELADO",
  "CANCELADA",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
let schemaPromise: Promise<void> | null = null;

function cleanText(value: unknown, maxLength: number) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
function normalizedDigits(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}
function toIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
function maskDocument(value: string) {
  return value.length <= 4
    ? value
    : "•".repeat(value.length - 4) + value.slice(-4);
}
function maskImei(value: string) {
  return value.length <= 7
    ? value
    : value.slice(0, 3) + "•".repeat(value.length - 7) + value.slice(-4);
}
function displayClientName(value: unknown) {
  return cleanText(value, 160) || "Cliente";
}
function equipmentLabel(row: {
  referenciaEquipo: string | null;
  equipoMarca: string | null;
  equipoModelo: string | null;
}) {
  return (
    cleanText(row.referenciaEquipo, 180) ||
    [row.equipoMarca, row.equipoModelo]
      .map((value) => cleanText(value, 100))
      .filter(Boolean)
      .join(" ") ||
    "iPhone"
  );
}
function normalizedPlatform(row: CreditContextRow) {
  const platform = cleanText(row.plataforma, 24).toUpperCase();
  const equipment = [row.referenciaEquipo, row.equipoMarca, row.equipoModelo]
    .map((value) => cleanText(value, 180).toUpperCase())
    .join(" ");
  return platform === "IPHONE" || equipment.includes("IPHONE")
    ? "IPHONE"
    : platform || "ANDROID";
}
function isCreditCancelled(value: unknown) {
  return CANCELLED_CREDIT_STATES.has(cleanText(value, 30).toUpperCase());
}
function warrantyIsActive(value: Date | string | null, now = new Date()) {
  if (!value) return false;
  const warrantyUntil = value instanceof Date ? value : new Date(value);
  return (
    !Number.isNaN(warrantyUntil.getTime()) &&
    warrantyUntil.getTime() >= now.getTime()
  );
}
function normalizeReason(value: unknown) {
  const reason = cleanText(value, 500);
  if (reason.length < 5 || reason.length > 500) {
    throw new CreditDeviceReplacementError(
      "REASON_INVALID",
      "Describe el motivo del cambio en al menos 5 caracteres.",
      400
    );
  }
  return reason;
}
function normalizeImei(value: unknown) {
  const imei = String(value || "").trim();
  if (!isValidCreditDeviceReplacementImei(imei)) {
    throw new CreditDeviceReplacementError(
      "IMEI_INVALID",
      "El IMEI debe tener 15 dígitos y un dígito de control válido.",
      400
    );
  }
  return imei;
}
function assertEligibleCredit(
  row: CreditContextRow,
  options: { requireActiveWarranty?: boolean } = {}
) {
  if (
    isCreditCancelled(row.estado) ||
    !row.solicitudId ||
    row.draftEstado !== "CERRADO" ||
    row.draftClosedReason !== "FINALIZADA"
  ) {
    throw new CreditDeviceReplacementError(
      "CREDIT_NOT_ELIGIBLE",
      "El cambio de equipo solo está disponible para créditos finalizados y vigentes."
    );
  }
  if (normalizedPlatform(row) !== "IPHONE") {
    throw new CreditDeviceReplacementError(
      "IPHONE_REQUIRED",
      "El cambio con enrolamiento especializado solo está disponible para iPhone."
    );
  }
  if (options.requireActiveWarranty !== false && !warrantyIsActive(row.warrantyUntil)) {
    throw new CreditDeviceReplacementError(
      "WARRANTY_EXPIRED",
      "La garantía de este crédito no está vigente."
    );
  }
}

function replacementReviewFromContext(
  row: ReplacementContextRow
): ReplacementReviewRow | null {
  if (!row.reviewId) return null;
  if (
    !row.reviewDecision ||
    !row.reviewChecklistVersion ||
    !row.reviewDocumentHash ||
    !row.reviewImeiHash ||
    !row.reviewChecklistHash ||
    !row.reviewIdentityKeyVersion ||
    !row.reviewAccessFingerprint ||
    !row.reviewAnalystName ||
    !row.reviewAnalystExternalId ||
    !row.reviewCorrelationId ||
    !row.reviewApprovedAt ||
    !row.reviewCreatedAt
  ) {
    throw new CreditDeviceReplacementError(
      "REVIEW_INCONSISTENT",
      "La revisión de enrolamiento del reemplazo está incompleta."
    );
  }
  return {
    id: row.reviewId,
    replacementId: row.id,
    decision: row.reviewDecision,
    checklistVersion: row.reviewChecklistVersion,
    checklist: row.reviewChecklist,
    documentHash: row.reviewDocumentHash,
    imeiHash: row.reviewImeiHash,
    checklistHash: row.reviewChecklistHash,
    identityKeyVersion: row.reviewIdentityKeyVersion,
    grantId: row.reviewGrantId,
    grantIssuedByUserId: row.reviewGrantIssuedByUserId,
    grantIssuedByName: row.reviewGrantIssuedByName,
    accessFingerprint: row.reviewAccessFingerprint,
    analystName: row.reviewAnalystName,
    analystExternalId: row.reviewAnalystExternalId,
    correlationId: row.reviewCorrelationId,
    approvedAt: row.reviewApprovedAt,
    createdAt: row.reviewCreatedAt,
  };
}
function checklistIsApproved(value: unknown): value is IphoneEnrollmentChecklist {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checklist = value as Record<string, unknown>;
  const keys = Object.keys(checklist).sort();
  return (
    keys.length === 3 &&
    keys[0] === "documentMatched" &&
    keys[1] === "enrollmentApproved" &&
    keys[2] === "imeiMatched" &&
    checklist.documentMatched === true &&
    checklist.imeiMatched === true &&
    checklist.enrollmentApproved === true
  );
}
function reviewHasValidProvenance(row: ReplacementReviewRow) {
  const fingerprint = row.accessFingerprint.trim();
  if (!HASH_PATTERN.test(fingerprint)) return false;
  if (row.grantId) {
    return Boolean(
      UUID_PATTERN.test(row.grantId) &&
        cleanText(row.grantIssuedByName, 160) &&
        fingerprint === hashIphoneEnrollmentGrantFingerprint(row.grantId)
    );
  }
  return (
    row.analystName === IPHONE_ENROLLMENT_SHARED_ANALYST.name &&
    row.analystExternalId === IPHONE_ENROLLMENT_SHARED_ANALYST.externalId &&
    row.grantIssuedByUserId === null &&
    row.grantIssuedByName === null &&
    fingerprint === hashIphoneEnrollmentSharedReviewFingerprint()
  );
}
function reviewIsValid(
  row: ReplacementReviewRow,
  identity: { document: string; imei: string }
) {
  return (
    row.decision === "APROBADO" &&
    row.checklistVersion === IPHONE_ENROLLMENT_CHECKLIST_VERSION &&
    row.identityKeyVersion === getIphoneEnrollmentIdentityKeyVersion() &&
    checklistIsApproved(row.checklist) &&
    row.checklistHash.trim() === hashIphoneEnrollmentChecklist(row.checklist) &&
    row.documentHash.trim() === hashIphoneEnrollmentDocument(identity.document) &&
    row.imeiHash.trim() === hashIphoneEnrollmentImei(identity.imei) &&
    reviewHasValidProvenance(row)
  );
}
function serializeReview(
  row: ReplacementReviewRow,
  solicitudId: number
): SerializedReplacementReview {
  return {
    id: row.id,
    solicitudId,
    decision: row.decision,
    checklistVersion: row.checklistVersion,
    checklist: row.checklist,
    checklistHash: row.checklistHash,
    analystName: row.analystName,
    analystExternalId: row.analystExternalId,
    identityKeyVersion: row.identityKeyVersion,
    grantId: row.grantId,
    grantIssuedBy:
      row.grantIssuedByUserId && row.grantIssuedByName
        ? { userId: row.grantIssuedByUserId, name: row.grantIssuedByName }
        : null,
    correlationId: row.correlationId,
    approvedAt: toIso(row.approvedAt),
    createdAt: toIso(row.createdAt),
  };
}

export async function ensureCreditDeviceReplacementSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ tableName: string; columnName: string }>
      >(
        `
          SELECT table_name AS "tableName", column_name AS "columnName"
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN (
              'CreditDeviceReplacement',
              'CreditDeviceReplacementReview',
              'CreditDeviceReplacementEvent'
            )
        `
      );
      const columns = new Map<string, Set<string>>();
      for (const row of rows) {
        const present = columns.get(row.tableName) || new Set<string>();
        present.add(row.columnName);
        columns.set(row.tableName, present);
      }
      const required: Record<string, string[]> = {
        CreditDeviceReplacement: [
          "id", "creditId", "solicitudId", "previousImei", "newImei",
          "reason", "status", "requestedCreditUpdatedAt", "createdByUserId",
          "createdByName", "createdByUsername", "source", "correlationId",
          "completedByUserId", "completedByName", "completedAt",
          "cancelledByUserId", "cancelledByName", "cancelledReason",
          "cancelledAt", "createdAt", "updatedAt",
        ],
        CreditDeviceReplacementReview: [
          "id", "replacementId", "decision", "checklistVersion", "checklist",
          "documentHash", "imeiHash", "checklistHash", "identityKeyVersion",
          "grantId", "grantIssuedByUserId", "grantIssuedByName",
          "accessFingerprint", "analystName", "analystExternalId",
          "correlationId", "approvedAt", "createdAt",
        ],
        CreditDeviceReplacementEvent: [
          "id", "replacementId", "eventType", "actorType", "actorUserId",
          "actorName", "correlationId", "payload", "createdAt",
        ],
      };
      for (const [tableName, names] of Object.entries(required)) {
        const present = columns.get(tableName);
        if (!present || names.some((name) => !present.has(name))) {
          throw new CreditDeviceReplacementError(
            "SCHEMA_NOT_READY",
            "El módulo de cambio de equipo todavía no está disponible.",
            503
          );
        }
      }
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

async function advisoryLocks(database: Database, keys: string[]) {
  for (const key of [...new Set(keys)].sort()) {
    await database.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
      key
    );
  }
}
const CREDIT_CONTEXT_SELECT = `
  credit."id" AS "creditId", credit."folio", credit."clienteNombre",
  credit."clienteDocumento", credit."imei" AS "creditImei",
  credit."deviceUid" AS "creditDeviceUid",
  credit."referenciaEquipo", credit."equipoMarca", credit."equipoModelo",
  credit."estado", credit."warrantyUntil",
  credit."updatedAt" AS "creditUpdatedAt",
  draft."id" AS "solicitudId", draft."estado" AS "draftEstado",
  draft."closedReason" AS "draftClosedReason",
  COALESCE(
    NULLIF(draft."plataforma", ''),
    NULLIF(credit."contratoSnapshot"->'equipo'->>'plataforma', '')
  ) AS "plataforma",
  sede."nombre" AS "sedeNombre", aliado."nombre" AS "aliadoNombre"
`;
const REPLACEMENT_SELECT = `
  replacement."id"::text, replacement."creditId", replacement."solicitudId",
  replacement."previousImei", replacement."newImei", replacement."reason",
  replacement."status", replacement."requestedCreditUpdatedAt",
  replacement."createdByUserId", replacement."createdByName",
  replacement."createdByUsername", replacement."correlationId"::text,
  replacement."completedByUserId", replacement."completedByName",
  replacement."completedAt", replacement."cancelledByUserId",
  replacement."cancelledByName", replacement."cancelledReason",
  replacement."cancelledAt", replacement."createdAt", replacement."updatedAt"
`;
const REVIEW_CONTEXT_SELECT = `
  review."id"::text AS "reviewId",
  review."decision" AS "reviewDecision",
  review."checklistVersion" AS "reviewChecklistVersion",
  review."checklist" AS "reviewChecklist",
  review."documentHash" AS "reviewDocumentHash",
  review."imeiHash" AS "reviewImeiHash",
  review."checklistHash" AS "reviewChecklistHash",
  review."identityKeyVersion" AS "reviewIdentityKeyVersion",
  review."grantId"::text AS "reviewGrantId",
  review."grantIssuedByUserId" AS "reviewGrantIssuedByUserId",
  review."grantIssuedByName" AS "reviewGrantIssuedByName",
  review."accessFingerprint" AS "reviewAccessFingerprint",
  review."analystName" AS "reviewAnalystName",
  review."analystExternalId" AS "reviewAnalystExternalId",
  review."correlationId"::text AS "reviewCorrelationId",
  review."approvedAt" AS "reviewApprovedAt",
  review."createdAt" AS "reviewCreatedAt"
`;

async function creditContextForUpdate(database: Database, creditId: number) {
  const rows = await database.$queryRawUnsafe<CreditContextRow[]>(
    `
      SELECT ${CREDIT_CONTEXT_SELECT}
      FROM "Credito" credit
      LEFT JOIN LATERAL (
        SELECT draft.* FROM "CreditoBorrador" draft
        WHERE draft."creditoId" = credit."id"
        ORDER BY draft."createdAt" DESC, draft."id" DESC
        LIMIT 1
      ) draft ON TRUE
      LEFT JOIN "Sede" sede ON sede."id" = credit."sedeId"
      LEFT JOIN "Aliado" aliado ON aliado."id" = sede."aliadoId"
      WHERE credit."id" = $1
      LIMIT 1
      FOR UPDATE OF credit
    `,
    creditId
  );
  return rows[0] || null;
}
async function replacementContextForUpdate(
  database: Database,
  options: { creditId?: number; replacementId?: string }
) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.creditId) {
    values.push(options.creditId);
    clauses.push(
      'replacement."creditId" = $' + String(values.length),
      "replacement.\"status\" IN ('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED')"
    );
  }
  if (options.replacementId) {
    values.push(options.replacementId);
    clauses.push('replacement."id" = $' + String(values.length) + "::uuid");
  }
  const rows = await database.$queryRawUnsafe<ReplacementContextRow[]>(
    `
      SELECT ${REPLACEMENT_SELECT}, ${CREDIT_CONTEXT_SELECT},
        ${REVIEW_CONTEXT_SELECT}
      FROM "CreditDeviceReplacement" replacement
      INNER JOIN "Credito" credit ON credit."id" = replacement."creditId"
      INNER JOIN "CreditoBorrador" draft
        ON draft."id" = replacement."solicitudId"
      LEFT JOIN "Sede" sede ON sede."id" = credit."sedeId"
      LEFT JOIN "Aliado" aliado ON aliado."id" = sede."aliadoId"
      LEFT JOIN "CreditDeviceReplacementReview" review
        ON review."replacementId" = replacement."id"
      WHERE ${clauses.join(" AND ")}
      ORDER BY replacement."createdAt" DESC
      LIMIT 1
      FOR UPDATE OF replacement, credit
    `,
    ...values
  );
  return rows[0] || null;
}
async function assertImeiAvailable(
  database: Database,
  input: {
    imei: string;
    creditId: number;
    solicitudId: number | null;
    replacementId?: string | null;
  }
) {
  const rows = await database.$queryRawUnsafe<
    Array<{
      creditConflict: string | null;
      draftConflict: number | null;
      replacementConflict: string | null;
    }>
  >(
    `
      SELECT
        (
          SELECT credit."folio" FROM "Credito" credit
          WHERE credit."id" <> $2
            AND (
              regexp_replace(COALESCE(credit."imei", ''), '[^0-9]', '', 'g') = $1
              OR regexp_replace(COALESCE(credit."deviceUid", ''), '[^0-9]', '', 'g') = $1
            )
          LIMIT 1
        ) AS "creditConflict",
        (
          SELECT draft."id" FROM "CreditoBorrador" draft
          WHERE ($3::integer IS NULL OR draft."id" <> $3)
            AND draft."estado" = 'ABIERTO' AND draft."creditoId" IS NULL
            AND COALESCE(
              draft."expiresAt", draft."createdAt" + INTERVAL '15 days'
            ) > CURRENT_TIMESTAMP
            AND regexp_replace(COALESCE(draft."imei", ''), '[^0-9]', '', 'g') = $1
          LIMIT 1
        ) AS "draftConflict",
        (
          SELECT active."id"::text FROM "CreditDeviceReplacement" active
          WHERE active."newImei" = $1
            AND active."status" IN ('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED')
            AND ($4::uuid IS NULL OR active."id" <> $4::uuid)
          LIMIT 1
        ) AS "replacementConflict"
    `,
    input.imei,
    input.creditId,
    input.solicitudId,
    input.replacementId || null
  );
  const conflict = rows[0];
  if (
    conflict?.creditConflict ||
    conflict?.draftConflict ||
    conflict?.replacementConflict
  ) {
    throw new CreditDeviceReplacementError(
      "IMEI_CONFLICT",
      conflict.creditConflict
        ? "El IMEI ya pertenece al crédito " + conflict.creditConflict + "."
        : "El IMEI ya está reservado por otra solicitud o reemplazo."
    );
  }
}

export async function lockCreditDeviceReplacementImeiForCreditCreation(
  database: Prisma.TransactionClient,
  input: { imei: string; solicitudId?: number | null }
) {
  const imei = normalizeImei(input.imei);
  const solicitudId =
    Number.isSafeInteger(input.solicitudId) && Number(input.solicitudId) > 0
      ? Number(input.solicitudId)
      : null;
  await advisoryLocks(database, ["credit-device-replacement:imei:" + imei]);
  await lockSolicitudIdentityMutation(database, "imei", imei);
  await assertImeiAvailable(database, {
    imei,
    creditId: 0,
    solicitudId,
  });
}
async function insertEvent(
  database: Database,
  input: {
    replacementId: string;
    eventType: ReplacementEventType;
    actorType: "USER" | "ANALYST" | "SYSTEM_SUPPORT";
    actorUserId: number | null;
    actorName: string;
    correlationId?: string;
    payload: Record<string, unknown>;
  }
) {
  await database.$executeRawUnsafe(
    `
      INSERT INTO "CreditDeviceReplacementEvent" (
        "id", "replacementId", "eventType", "actorType", "actorUserId",
        "actorName", "correlationId", "payload", "createdAt"
      )
      VALUES (
        $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::jsonb,
        CURRENT_TIMESTAMP
      )
    `,
    randomUUID(),
    input.replacementId,
    input.eventType,
    input.actorType,
    input.actorUserId,
    cleanText(input.actorName, 160) || "Sistema",
    input.correlationId || randomUUID(),
    JSON.stringify(input.payload)
  );
}

export async function getCreditDeviceReplacementOverview(
  creditId: number
): Promise<CreditDeviceReplacementOverview> {
  await ensureCreditDeviceReplacementSchema();
  const rows = await prisma.$queryRawUnsafe<ReplacementContextRow[]>(
    `
      SELECT ${REPLACEMENT_SELECT}, ${CREDIT_CONTEXT_SELECT},
        ${REVIEW_CONTEXT_SELECT}
      FROM "Credito" credit
      LEFT JOIN LATERAL (
        SELECT draft.* FROM "CreditoBorrador" draft
        WHERE draft."creditoId" = credit."id"
        ORDER BY draft."createdAt" DESC, draft."id" DESC LIMIT 1
      ) draft ON TRUE
      LEFT JOIN "Sede" sede ON sede."id" = credit."sedeId"
      LEFT JOIN "Aliado" aliado ON aliado."id" = sede."aliadoId"
      LEFT JOIN LATERAL (
        SELECT item.* FROM "CreditDeviceReplacement" item
        WHERE item."creditId" = credit."id"
        ORDER BY
          CASE WHEN item."status" IN (
            'PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED'
          ) THEN 0 ELSE 1 END,
          item."createdAt" DESC
        LIMIT 1
      ) replacement ON TRUE
      LEFT JOIN "CreditDeviceReplacementReview" review
        ON review."replacementId" = replacement."id"
      WHERE credit."id" = $1 LIMIT 1
    `,
    creditId
  );
  const row = rows[0];
  if (!row) {
    throw new CreditDeviceReplacementError(
      "CREDIT_NOT_FOUND",
      "Crédito no encontrado.",
      404
    );
  }
  const document = normalizedDigits(row.clienteDocumento);
  const currentImei = normalizedDigits(row.creditImei || row.creditDeviceUid);
  return {
    credit: {
      id: row.creditId,
      folio: row.folio,
      clienteNombre: cleanText(row.clienteNombre, 180) || "Cliente",
      clienteDocumentoMasked: maskDocument(document),
      equipment: equipmentLabel(row),
      platform: normalizedPlatform(row),
      currentImeiMasked: maskImei(currentImei),
    },
    replacement: row.id
      ? {
          id: row.id,
          status: row.status,
          newImeiMasked: maskImei(row.newImei),
          reason: row.reason,
          createdAt: toIso(row.createdAt),
          completedAt: row.completedAt ? toIso(row.completedAt) : null,
          analystName: row.reviewAnalystName || null,
        }
      : null,
  };
}

export async function createCreditDeviceReplacement(input: {
  creditId: number;
  newImei: unknown;
  reason: unknown;
  actor: ReplacementActor;
}) {
  await ensureCreditDeviceReplacementSchema();
  const newImei = normalizeImei(input.newImei);
  const reason = normalizeReason(input.reason);
  const actorName = cleanText(input.actor.name, 160);
  if (!Number.isInteger(input.creditId) || input.creditId <= 0 || !actorName) {
    throw new CreditDeviceReplacementError(
      "CREDIT_NOT_FOUND",
      "Crédito no encontrado.",
      404
    );
  }
  return prisma.$transaction(async (transaction) => {
    await advisoryLocks(transaction, [
      "credit-device-replacement:credit:" + input.creditId,
      "credit-device-replacement:imei:" + newImei,
    ]);
    await lockSolicitudIdentityMutation(transaction, "imei", newImei);
    const credit = await creditContextForUpdate(transaction, input.creditId);
    if (!credit) {
      throw new CreditDeviceReplacementError(
        "CREDIT_NOT_FOUND",
        "Crédito no encontrado.",
        404
      );
    }
    assertEligibleCredit(credit);
    const previousImei = normalizeImei(normalizedDigits(credit.creditImei));
    const previousDeviceUid = normalizeImei(
      normalizedDigits(credit.creditDeviceUid)
    );
    if (previousImei !== previousDeviceUid) {
      throw new CreditDeviceReplacementError(
        "CREDIT_NOT_ELIGIBLE",
        "El crédito tiene identificadores de equipo inconsistentes. Escala el caso antes de reemplazarlo."
      );
    }
    if (previousImei === newImei) {
      throw new CreditDeviceReplacementError(
        "IMEI_UNCHANGED",
        "El nuevo IMEI es igual al equipo vigente.",
        400
      );
    }
    const active = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
      `
        SELECT "id"::text FROM "CreditDeviceReplacement"
        WHERE "creditId" = $1
          AND "status" IN ('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED')
        LIMIT 1
      `,
      input.creditId
    );
    if (active[0]) {
      throw new CreditDeviceReplacementError(
        "ACTIVE_REPLACEMENT_EXISTS",
        "Este crédito ya tiene un cambio de equipo en proceso."
      );
    }
    await assertImeiAvailable(transaction, {
      imei: newImei,
      creditId: credit.creditId,
      solicitudId: credit.solicitudId!,
    });
    const replacementId = randomUUID();
    const correlationId = randomUUID();
    await transaction.$executeRawUnsafe(
      `
        INSERT INTO "CreditDeviceReplacement" (
          "id", "creditId", "solicitudId", "previousImei", "newImei",
          "reason", "status", "requestedCreditUpdatedAt", "createdByUserId",
          "createdByName", "createdByUsername", "source", "correlationId",
          "createdAt", "updatedAt"
        )
        VALUES (
          $1::uuid, $2, $3, $4, $5, $6, 'PENDING_ENROLLMENT', $7,
          $8, $9, $10, 'ADMIN_PORTAL', $11::uuid,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `,
      replacementId,
      credit.creditId,
      credit.solicitudId,
      previousImei,
      newImei,
      reason,
      credit.creditUpdatedAt,
      input.actor.userId,
      actorName,
      cleanText(input.actor.username, 120) || null,
      correlationId
    );
    await insertEvent(transaction, {
      replacementId,
      eventType: "CREATED",
      actorType: "USER",
      actorUserId: input.actor.userId,
      actorName,
      correlationId,
      payload: {
        creditId: credit.creditId,
        folio: credit.folio,
        reason,
        warrantyUntil: credit.warrantyUntil ? toIso(credit.warrantyUntil) : null,
        previousImeiMasked: maskImei(previousImei),
        newImeiMasked: maskImei(newImei),
        previousImeiHash: hashIphoneEnrollmentImei(previousImei),
        newImeiHash: hashIphoneEnrollmentImei(newImei),
      },
    });
    return { id: replacementId, status: "PENDING_ENROLLMENT" as const };
  });
}

async function replacementCreditId(
  database: Database,
  replacementId: string
) {
  const rows = await database.$queryRawUnsafe<Array<{ creditId: number }>>(
    `
      SELECT "creditId" FROM "CreditDeviceReplacement"
      WHERE "id" = $1::uuid LIMIT 1
    `,
    replacementId
  );
  return rows[0]?.creditId || null;
}

export async function completeCreditDeviceReplacement(input: {
  creditId: number;
  actor: ReplacementActor;
}) {
  await ensureCreditDeviceReplacementSchema();
  return prisma.$transaction(async (transaction) => {
    await advisoryLocks(transaction, [
      "credit-device-replacement:credit:" + input.creditId,
    ]);
    const row = await replacementContextForUpdate(transaction, {
      creditId: input.creditId,
    });
    if (!row) {
      throw new CreditDeviceReplacementError(
        "REPLACEMENT_NOT_FOUND",
        "No hay un cambio de equipo activo para este crédito.",
        404
      );
    }
    await advisoryLocks(transaction, [
      "credit-device-replacement:imei:" + row.previousImei,
      "credit-device-replacement:imei:" + row.newImei,
      "credit-device-replacement:replacement:" + row.id,
    ]);
    await lockSolicitudIdentityMutation(transaction, "imei", row.newImei);
    assertEligibleCredit(row, { requireActiveWarranty: false });
    if (row.status !== "ENROLLMENT_APPROVED") {
      throw new CreditDeviceReplacementError(
        "ENROLLMENT_REQUIRED",
        "El analista debe aprobar el enrolamiento del nuevo IMEI antes de aplicar el cambio."
      );
    }
    const document = normalizedDigits(row.clienteDocumento);
    const review = replacementReviewFromContext(row);
    if (!review || !reviewIsValid(review, { document, imei: row.newImei })) {
      throw new CreditDeviceReplacementError(
        "REVIEW_INCONSISTENT",
        "La aprobación de enrolamiento no pudo verificarse."
      );
    }
    if (
      normalizedDigits(row.creditImei) !== row.previousImei ||
      normalizedDigits(row.creditDeviceUid) !== row.previousImei
    ) {
      throw new CreditDeviceReplacementError(
        "REPLACEMENT_CONCURRENT_CHANGE",
        "El equipo vigente cambió. Recarga el crédito antes de continuar."
      );
    }
    await assertImeiAvailable(transaction, {
      imei: row.newImei,
      creditId: row.creditId,
      solicitudId: row.solicitudId,
      replacementId: row.id,
    });
    const updatedCredit = await transaction.$queryRawUnsafe<Array<{ id: number }>>(
      `
        UPDATE "Credito"
        SET "imei" = $1, "deviceUid" = $1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $2
          AND regexp_replace(COALESCE("imei", ''), '[^0-9]', '', 'g') = $3
          AND regexp_replace(COALESCE("deviceUid", ''), '[^0-9]', '', 'g') = $3
        RETURNING "id"
      `,
      row.newImei,
      row.creditId,
      row.previousImei
    );
    if (!updatedCredit[0]) {
      throw new CreditDeviceReplacementError(
        "REPLACEMENT_CONCURRENT_CHANGE",
        "El equipo vigente cambió durante la operación."
      );
    }
    const actorName = cleanText(input.actor.name, 160) || "Administrador";
    await transaction.$executeRawUnsafe(
      `
        UPDATE "CreditDeviceReplacement"
        SET "status" = 'COMPLETED', "completedByUserId" = $2,
          "completedByName" = $3, "completedAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid AND "status" = 'ENROLLMENT_APPROVED'
      `,
      row.id,
      input.actor.userId,
      actorName
    );
    await insertEvent(transaction, {
      replacementId: row.id,
      eventType: "COMPLETED",
      actorType: "USER",
      actorUserId: input.actor.userId,
      actorName,
      payload: {
        creditId: row.creditId,
        folio: row.folio,
        reviewId: review.id,
        previousImeiMasked: maskImei(row.previousImei),
        newImeiMasked: maskImei(row.newImei),
        previousImeiHash: hashIphoneEnrollmentImei(row.previousImei),
        newImeiHash: hashIphoneEnrollmentImei(row.newImei),
      },
    });
    return { id: row.id, status: "COMPLETED" as const };
  });
}

export async function cancelCreditDeviceReplacement(input: {
  creditId: number;
  reason: unknown;
  actor: ReplacementActor;
}) {
  await ensureCreditDeviceReplacementSchema();
  const reason = normalizeReason(input.reason);
  return prisma.$transaction(async (transaction) => {
    await advisoryLocks(transaction, [
      "credit-device-replacement:credit:" + input.creditId,
    ]);
    const row = await replacementContextForUpdate(transaction, {
      creditId: input.creditId,
    });
    if (!row) {
      throw new CreditDeviceReplacementError(
        "REPLACEMENT_NOT_FOUND",
        "No hay un cambio de equipo activo para cancelar.",
        404
      );
    }
    await advisoryLocks(transaction, [
      "credit-device-replacement:imei:" + row.newImei,
      "credit-device-replacement:replacement:" + row.id,
    ]);
    const actorName = cleanText(input.actor.name, 160) || "Administrador";
    await transaction.$executeRawUnsafe(
      `
        UPDATE "CreditDeviceReplacement"
        SET "status" = 'CANCELLED', "cancelledByUserId" = $2,
          "cancelledByName" = $3, "cancelledReason" = $4,
          "cancelledAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid
          AND "status" IN ('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED')
      `,
      row.id,
      input.actor.userId,
      actorName,
      reason
    );
    await insertEvent(transaction, {
      replacementId: row.id,
      eventType: "CANCELLED",
      actorType: "USER",
      actorUserId: input.actor.userId,
      actorName,
      payload: {
        creditId: row.creditId,
        folio: row.folio,
        reason,
        newImeiMasked: maskImei(row.newImei),
      },
    });
    return { id: row.id, status: "CANCELLED" as const };
  });
}

export async function findCreditDeviceReplacementEnrollmentCase(input: {
  document: string;
  imei: string;
  documentHash: string;
  imeiHash: string;
}): Promise<ReplacementEnrollmentCase | null> {
  await ensureCreditDeviceReplacementSchema();
  const document = normalizedDigits(input.document);
  const imei = normalizedDigits(input.imei);
  if (
    !document ||
    !/^\d{15}$/.test(imei) ||
    input.documentHash !== hashIphoneEnrollmentDocument(document) ||
    input.imeiHash !== hashIphoneEnrollmentImei(imei)
  ) {
    return null;
  }
  const rows = await prisma.$queryRawUnsafe<ReplacementContextRow[]>(
    `
      SELECT ${REPLACEMENT_SELECT}, ${CREDIT_CONTEXT_SELECT},
        ${REVIEW_CONTEXT_SELECT}
      FROM "CreditDeviceReplacement" replacement
      INNER JOIN "Credito" credit ON credit."id" = replacement."creditId"
      INNER JOIN "CreditoBorrador" draft
        ON draft."id" = replacement."solicitudId"
      LEFT JOIN "Sede" sede ON sede."id" = credit."sedeId"
      LEFT JOIN "Aliado" aliado ON aliado."id" = sede."aliadoId"
      LEFT JOIN "CreditDeviceReplacementReview" review
        ON review."replacementId" = replacement."id"
      WHERE replacement."status" IN (
          'PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED'
        )
        AND replacement."newImei" = $1
        AND regexp_replace(
          COALESCE(credit."clienteDocumento", ''), '[^0-9]', '', 'g'
        ) = $2
      ORDER BY replacement."createdAt" DESC LIMIT 2
    `,
    imei,
    document
  );
  if (!rows.length) return null;
  if (rows.length > 1) {
    throw new CreditDeviceReplacementError(
      "REVIEW_INCONSISTENT",
      "Existe más de un cambio activo para estos datos."
    );
  }
  const row = rows[0];
  assertEligibleCredit(row, { requireActiveWarranty: false });
  const review = replacementReviewFromContext(row);
  if (
    (row.status === "ENROLLMENT_APPROVED" && !review) ||
    (row.status === "PENDING_ENROLLMENT" && review) ||
    (review && !reviewIsValid(review, { document, imei }))
  ) {
    throw new CreditDeviceReplacementError(
      "REVIEW_INCONSISTENT",
      "El estado del enrolamiento del reemplazo no pudo verificarse."
    );
  }
  return {
    targetType: "DEVICE_REPLACEMENT",
    targetId: row.id,
    solicitudId: row.solicitudId,
    solicitudNumero: "SOL-" + String(row.solicitudId).padStart(6, "0"),
    currentStep: 4,
    clienteNombre: displayClientName(row.clienteNombre),
    documentoMasked: maskDocument(document),
    imeiMasked: maskImei(imei),
    equipo: equipmentLabel(row),
    sede: cleanText(row.sedeNombre, 120) || "Sede",
    aliado: cleanText(row.aliadoNombre, 120) || "Aliado",
    documentHash: input.documentHash,
    imeiHash: input.imeiHash,
    review: review ? serializeReview(review, row.solicitudId) : null,
    operationLabel: "Cambio por garantía",
  };
}

type ReplacementApprovalInput = {
  replacementId: string;
  solicitudId: number;
  documentHash: string;
  imeiHash: string;
  checklistVersion: string;
  checklist: IphoneEnrollmentChecklist;
  checklistHash: string;
  identityKeyVersion: string;
  correlationId: string;
  analyst: { name: string; externalId: string };
  access: {
    grantId: string | null;
    issuedByUserId: number | null;
    issuedByName: string | null;
    fingerprint: string;
  };
};
function validateApprovalInput(input: ReplacementApprovalInput) {
  if (
    !UUID_PATTERN.test(input.replacementId) ||
    !Number.isInteger(input.solicitudId) ||
    input.solicitudId <= 0 ||
    !HASH_PATTERN.test(input.documentHash) ||
    !HASH_PATTERN.test(input.imeiHash) ||
    input.checklistVersion !== IPHONE_ENROLLMENT_CHECKLIST_VERSION ||
    !checklistIsApproved(input.checklist) ||
    input.checklistHash !== hashIphoneEnrollmentChecklist(input.checklist) ||
    input.identityKeyVersion !== getIphoneEnrollmentIdentityKeyVersion() ||
    !UUID_PATTERN.test(input.correlationId) ||
    !cleanText(input.analyst.name, 100) ||
    !cleanText(input.analyst.externalId, 120) ||
    !HASH_PATTERN.test(input.access.fingerprint)
  ) {
    throw new CreditDeviceReplacementError(
      "CASE_IDENTITY_CHANGED",
      "La consulta venció o los datos del reemplazo cambiaron."
    );
  }
  if (
    input.access.grantId &&
    (!UUID_PATTERN.test(input.access.grantId) ||
      !input.access.issuedByUserId ||
      !cleanText(input.access.issuedByName, 160))
  ) {
    throw new CreditDeviceReplacementError(
      "CASE_IDENTITY_CHANGED",
      "La autorización del analista no pudo verificarse."
    );
  }
  if (
    !input.access.grantId &&
    (input.access.issuedByUserId !== null ||
      input.access.issuedByName !== null)
  ) {
    throw new CreditDeviceReplacementError(
      "CASE_IDENTITY_CHANGED",
      "La autorización compartida del analista no es válida."
    );
  }
}
async function approveReplacementWith(
  input: ReplacementApprovalInput,
  transaction: Prisma.TransactionClient
) {
  validateApprovalInput(input);
  const creditId = await replacementCreditId(transaction, input.replacementId);
  if (!creditId) {
    throw new CreditDeviceReplacementError(
      "REPLACEMENT_NOT_FOUND",
      "El cambio de equipo ya no está disponible.",
      404
    );
  }
  await advisoryLocks(transaction, [
    "credit-device-replacement:credit:" + creditId,
    "credit-device-replacement:replacement:" + input.replacementId,
  ]);
  const row = await replacementContextForUpdate(transaction, {
    replacementId: input.replacementId,
  });
  if (
    !row ||
    !ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number])
  ) {
    throw new CreditDeviceReplacementError(
      "REPLACEMENT_NOT_PENDING",
      "El cambio de equipo ya no está disponible para enrolamiento."
    );
  }
  await advisoryLocks(transaction, [
    "credit-device-replacement:imei:" + row.newImei,
  ]);
  await lockSolicitudIdentityMutation(transaction, "imei", row.newImei);
  assertEligibleCredit(row, { requireActiveWarranty: false });
  const document = normalizedDigits(row.clienteDocumento);
  if (
    row.solicitudId !== input.solicitudId ||
    hashIphoneEnrollmentDocument(document) !== input.documentHash ||
    hashIphoneEnrollmentImei(row.newImei) !== input.imeiHash
  ) {
    throw new CreditDeviceReplacementError(
      "CASE_IDENTITY_CHANGED",
      "La cédula o el IMEI cambiaron. Consulta nuevamente el reemplazo."
    );
  }
  const existing = replacementReviewFromContext(row);
  if (existing) {
    if (!reviewIsValid(existing, { document, imei: row.newImei })) {
      throw new CreditDeviceReplacementError(
        "REVIEW_INCONSISTENT",
        "La aprobación existente no pudo verificarse."
      );
    }
    return {
      review: serializeReview(existing, row.solicitudId),
      alreadyApproved: true,
    };
  }
  if (row.status !== "PENDING_ENROLLMENT") {
    throw new CreditDeviceReplacementError(
      "REVIEW_INCONSISTENT",
      "El reemplazo figura aprobado sin una revisión verificable."
    );
  }
  await assertImeiAvailable(transaction, {
    imei: row.newImei,
    creditId: row.creditId,
    solicitudId: row.solicitudId,
    replacementId: row.id,
  });
  const reviewId = randomUUID();
  const inserted = await transaction.$queryRawUnsafe<ReplacementReviewRow[]>(
    `
      INSERT INTO "CreditDeviceReplacementReview" (
        "id", "replacementId", "decision", "checklistVersion", "checklist",
        "documentHash", "imeiHash", "checklistHash", "identityKeyVersion",
        "grantId", "grantIssuedByUserId", "grantIssuedByName",
        "accessFingerprint", "analystName", "analystExternalId",
        "correlationId", "approvedAt", "createdAt"
      )
      VALUES (
        $1::uuid, $2::uuid, 'APROBADO', $3, $4::jsonb, $5, $6, $7, $8,
        $9::uuid, $10, $11, $12, $13, $14, $15::uuid,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING "id"::text, "replacementId"::text, "decision",
        "checklistVersion", "checklist", "documentHash", "imeiHash",
        "checklistHash", "identityKeyVersion", "grantId"::text,
        "grantIssuedByUserId", "grantIssuedByName", "accessFingerprint",
        "analystName", "analystExternalId", "correlationId"::text,
        "approvedAt", "createdAt"
    `,
    reviewId,
    row.id,
    input.checklistVersion,
    JSON.stringify(input.checklist),
    input.documentHash,
    input.imeiHash,
    input.checklistHash,
    input.identityKeyVersion,
    input.access.grantId,
    input.access.issuedByUserId,
    cleanText(input.access.issuedByName, 160) || null,
    input.access.fingerprint,
    cleanText(input.analyst.name, 100),
    cleanText(input.analyst.externalId, 120),
    input.correlationId
  );
  const review = inserted[0];
  if (!review || !reviewIsValid(review, { document, imei: row.newImei })) {
    throw new CreditDeviceReplacementError(
      "REVIEW_INCONSISTENT",
      "No fue posible verificar la aprobación registrada."
    );
  }
  await transaction.$executeRawUnsafe(
    `
      UPDATE "CreditDeviceReplacement"
      SET "status" = 'ENROLLMENT_APPROVED', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1::uuid AND "status" = 'PENDING_ENROLLMENT'
    `,
    row.id
  );
  await insertEvent(transaction, {
    replacementId: row.id,
    eventType: "ENROLLMENT_APPROVED",
    actorType: "ANALYST",
    actorUserId: null,
    actorName: input.analyst.name,
    correlationId: input.correlationId,
    payload: {
      creditId: row.creditId,
      folio: row.folio,
      reviewId,
      checklistVersion: input.checklistVersion,
      imeiHash: input.imeiHash,
      analystExternalId: cleanText(input.analyst.externalId, 120),
    },
  });
  return {
    review: serializeReview(review, row.solicitudId),
    alreadyApproved: false,
  };
}
export async function approveCreditDeviceReplacementEnrollment(
  input: ReplacementApprovalInput,
  database?: Prisma.TransactionClient
) {
  await ensureCreditDeviceReplacementSchema();
  if (database) return approveReplacementWith(input, database);
  return prisma.$transaction((transaction) =>
    approveReplacementWith(input, transaction)
  );
}
export function isCreditDeviceReplacementCaseToken(
  token: IphoneEnrollmentCaseTokenPayload
) {
  return (
    token.targetType === "DEVICE_REPLACEMENT" &&
    Boolean(token.targetId && UUID_PATTERN.test(token.targetId))
  );
}
