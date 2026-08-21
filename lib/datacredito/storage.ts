import "server-only";

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import {
  DataCreditoPolicyValidationError,
  parseDataCreditoPolicyBands,
  resolveDataCreditoDecision,
  type DataCreditoDecision,
  type DataCreditoOffer,
  type DataCreditoPlatform,
  type DataCreditoPolicy,
  type DataCreditoPolicyBand,
} from "@/lib/datacredito/policy";
import {
  matchesDataCreditoSchemaIndex,
  type DataCreditoSchemaIndexMetadata,
} from "@/lib/datacredito/schema-index";

export const DEFAULT_DATACREDITO_POLICY_PROFILE_ID =
  "00000000-0000-4000-8000-000000000001";
export const DATACREDITO_ASSESSMENT_DEFAULT_TTL_MINUTES = 21_600;

export const DATACREDITO_CONSENT_VERSION = "v1";
export const DATACREDITO_CONSENT_TEXT =
  "Confirmo que el titular, antes de esta consulta, autorizó de manera previa, expresa e informada a FINSER PAY S.A.S. para consultar su información crediticia y financiera en DataCrédito Experian con el fin de evaluar esta solicitud de financiación.";
export const DATACREDITO_CONSENT_HASH = createHash("sha256")
  .update(DATACREDITO_CONSENT_TEXT, "utf8")
  .digest("hex");

export type DataCreditoAssessmentStatus =
  | DataCreditoDecision
  | "PENDING"
  | "NO_EVALUADO";

export type DataCreditoAssessmentScope = {
  userId: number;
  sellerId: number | null;
  sedeId: number;
  aliadoId: number | null;
};

export type DataCreditoIdentityInput = {
  documentNumber: string;
  firstSurname: string;
  platform: DataCreditoPlatform;
};

export type DataCreditoAssessmentRow = {
  id: string;
  documentHash: string;
  documentLast4: string;
  surnameHash: string;
  platform: DataCreditoPlatform;
  providerEnvironment: string;
  status: DataCreditoAssessmentStatus;
  score: number | null;
  decision: DataCreditoDecision | null;
  offer: DataCreditoOffer | null;
  policyVersion: number;
  policyRevisionId: string;
  reusedFromAssessmentId: string | null;
  consentVersion: string;
  consentHash: string;
  consentAt: Date;
  userId: number;
  sellerId: number | null;
  sedeId: number;
  aliadoId: number | null;
  ipHash: string | null;
  userAgentHash: string | null;
  correlationId: string;
  transactionCode: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  durationMs: number | null;
  expiresAt: Date;
  claimedAt: Date | null;
  claimTokenHash: string | null;
  claimExpiresAt: Date | null;
  consumedAt: Date | null;
  creditId: number | null;
  retainedUntil: Date;
  createdAt: Date;
  updatedAt: Date;
};

type DataCreditoPolicyRow = {
  version: number;
  policy: unknown;
  createdByUserId: number;
  createdAt: Date;
};

type DataCreditoPolicyRevisionRow = DataCreditoPolicyRow & {
  revisionId: string;
  profileId: string;
  profileName: string;
  profileDescription: string | null;
  profileActive: boolean;
};

type DataCreditoAssignedPolicyRow = {
  allyId: number;
  policyId: string | null;
  profileName: string | null;
  profileDescription: string | null;
  profileActive: boolean | null;
  revisionId: string | null;
  version: number | null;
  policy: unknown;
  createdByUserId: number | null;
  createdAt: Date | null;
};

type DataCreditoQueryExecutor = Prisma.TransactionClient | typeof prisma;

export type DataCreditoAssessmentReuseInput = DataCreditoAssessmentScope & {
  platform: DataCreditoPlatform;
  providerEnvironment: string;
  documentHash: string;
  documentLast4: string;
  surnameHash: string;
  correlationId: string;
  consentAt: Date;
  ipHash: string | null;
  userAgentHash: string | null;
};

type CreatePendingAssessmentInput = DataCreditoAssessmentReuseInput & {
  policyVersion: number;
  policyRevisionId: string;
};

type CompleteAssessmentInput = {
  id: string;
  score: number;
  decision: DataCreditoDecision;
  offer: DataCreditoOffer;
  transactionCode: string | null;
  providerStatus: string | null;
  durationMs: number | null;
};

export type DataCreditoAssessmentReservation =
  | { kind: "CREATED"; assessment: DataCreditoAssessmentRow }
  | { kind: "IN_PROGRESS" }
  | { kind: "RATE_LIMITED" }
  | { kind: "REUSED"; assessment: DataCreditoAssessmentRow };

export class DataCreditoStorageConfigurationError extends Error {
  readonly code: "AUDIT_NOT_CONFIGURED" | "SCHEMA_NOT_READY";

  constructor(
    message: string,
    code: "AUDIT_NOT_CONFIGURED" | "SCHEMA_NOT_READY" = "AUDIT_NOT_CONFIGURED"
  ) {
    super(message);
    this.name = "DataCreditoStorageConfigurationError";
    this.code = code;
  }
}

export class DataCreditoPolicyConflictError extends Error {
  readonly currentVersion: number | null;

  constructor(currentVersion: number | null) {
    super("La politica fue modificada por otro usuario. Recarga antes de guardar.");
    this.name = "DataCreditoPolicyConflictError";
    this.currentVersion = currentVersion;
  }
}

export class DataCreditoPolicyNotFoundError extends Error {
  constructor() {
    super("La politica seleccionada no existe.");
    this.name = "DataCreditoPolicyNotFoundError";
  }
}

let schemaPromise: Promise<void> | null = null;

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function readBoundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function getDataCreditoAssessmentTtlMinutes() {
  // Contractual validity: exactly 15 days. Historical environment values
  // (for example 120 minutes) must not silently shorten the production cache.
  return DATACREDITO_ASSESSMENT_DEFAULT_TTL_MINUTES;
}

export function getDataCreditoRetentionDays() {
  const raw = String(process.env.DATACREDITO_RETENTION_DAYS || '').trim();
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 15 || parsed > 730) {
      throw new DataCreditoStorageConfigurationError(
        'DATACREDITO_RETENTION_DAYS debe ser un entero entre 15 y 730'
      );
    }
  }

  return readBoundedInteger("DATACREDITO_RETENTION_DAYS", 90, 15, 730);
}

export function getDataCreditoRateLimitMax() {
  return readBoundedInteger("DATACREDITO_RATE_LIMIT_MAX", 5, 1, 100);
}

function getDataCreditoPendingStaleMinutes() {
  const timeoutMs = readBoundedInteger(
    "DATACREDITO_TIMEOUT_MS",
    12_000,
    1_000,
    60_000
  );
  const maximumProviderSequenceMs = timeoutMs * 4;

  // Token + query + one complete authentication retry can consume four
  // provider timeouts. Two extra minutes prevent a live request from being
  // invalidated by a concurrent reservation at the boundary.
  return Math.max(5, Math.ceil(maximumProviderSequenceMs / 60_000) + 2);
}

function getAuditHmacSecret() {
  const secret = String(process.env.DATACREDITO_AUDIT_HMAC_SECRET || "");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new DataCreditoStorageConfigurationError(
      "DATACREDITO_AUDIT_HMAC_SECRET debe tener al menos 32 bytes"
    );
  }
  return secret;
}

export function isDataCreditoAuditConfigured() {
  return (
    Buffer.byteLength(
      String(process.env.DATACREDITO_AUDIT_HMAC_SECRET || ""),
      "utf8"
    ) >= 32
  );
}

export function normalizeDataCreditoDocument(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizeDataCreditoSurname(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("es-CO");
}

export function hmacDataCreditoValue(label: string, value: string) {
  return createHmac("sha256", getAuditHmacSecret())
    .update(`${label}\u0000${value}`, "utf8")
    .digest("hex");
}

export function buildDataCreditoIdentityHashes(input: {
  documentNumber: string;
  firstSurname: string;
}) {
  const documentNumber = normalizeDataCreditoDocument(input.documentNumber);
  const firstSurname = normalizeDataCreditoSurname(input.firstSurname);

  return {
    documentHash: hmacDataCreditoValue("document", documentNumber),
    documentLast4: documentNumber.slice(-4),
    surnameHash: hmacDataCreditoValue("surname", firstSurname),
  };
}

export function hashDataCreditoRequestMetadata(label: "ip" | "user-agent", value: string) {
  const normalized = String(value || "").trim();
  return normalized ? hmacDataCreditoValue(label, normalized) : null;
}

function policyFromRow(row: DataCreditoPolicyRow | null): DataCreditoPolicy | null {
  if (!row) return null;
  const payload =
    row.policy && typeof row.policy === "object" && !Array.isArray(row.policy)
      ? (row.policy as Record<string, unknown>)
      : {};
  const bands = parseDataCreditoPolicyBands(payload.bands);

  return {
    version: row.version,
    bands,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

function policyFromRevisionRow(
  row: DataCreditoPolicyRevisionRow | null
): DataCreditoPolicy | null {
  const policy = policyFromRow(row);
  if (!policy || !row) return null;
  return {
    ...policy,
    profileId: row.profileId,
    profileName: row.profileName,
    revisionId: row.revisionId,
  };
}

export type DataCreditoAssignedPolicyResolution =
  | { kind: "READY"; policy: DataCreditoPolicy & { profileId: string; revisionId: string } }
  | {
      kind:
        | "ALLY_NOT_FOUND"
        | "POLICY_NOT_ASSIGNED"
        | "POLICY_INACTIVE"
        | "POLICY_NO_REVISION";
      policy: null;
      profileId: string | null;
    };

async function setupDataCreditoSchema() {
  const setupSql = await readFile(
    join(process.cwd(), "scripts", "setup-datacredito.sql"),
    "utf8"
  );
  await prisma.$executeRawUnsafe(setupSql);
}

const REQUIRED_POLICY_COLUMNS = [
  "version",
  "policy",
  "createdByUserId",
  "createdAt",
] as const;

const REQUIRED_ASSESSMENT_COLUMNS = [
  "id",
  "documentHash",
  "documentLast4",
  "surnameHash",
  "platform",
  "providerEnvironment",
  "status",
  "score",
  "decision",
  "offer",
  "policyVersion",
  "policyRevisionId",
  "reusedFromAssessmentId",
  "consentVersion",
  "consentHash",
  "consentAt",
  "userId",
  "sellerId",
  "sedeId",
  "aliadoId",
  "ipHash",
  "userAgentHash",
  "correlationId",
  "transactionCode",
  "providerStatus",
  "errorCode",
  "durationMs",
  "expiresAt",
  "claimedAt",
  "claimTokenHash",
  "claimExpiresAt",
  "consumedAt",
  "creditId",
  "retainedUntil",
  "createdAt",
  "updatedAt",
] as const;

const REQUIRED_SECURE_PAYLOAD_COLUMNS = [
  "assessmentId",
  "algorithm",
  "keyId",
  "aadVersion",
  "plaintextVersion",
  "nonce",
  "authTag",
  "ciphertext",
  "plaintextBytes",
  "createdAt",
] as const;

const REQUIRED_ADMIN_AUDIT_COLUMNS = [
  "id",
  "assessmentId",
  "actorUserId",
  "action",
  "outcome",
  "requestCorrelationId",
  "ipHash",
  "userAgentHash",
  "retainedUntil",
  "createdAt",
] as const;

const REQUIRED_POLICY_NOT_NULL_COLUMNS = REQUIRED_POLICY_COLUMNS;
const REQUIRED_ASSESSMENT_NOT_NULL_COLUMNS = [
  "id",
  "documentHash",
  "documentLast4",
  "surnameHash",
  "platform",
  "providerEnvironment",
  "status",
  "policyVersion",
  "policyRevisionId",
  "consentVersion",
  "consentHash",
  "consentAt",
  "userId",
  "sedeId",
  "correlationId",
  "expiresAt",
  "retainedUntil",
  "createdAt",
  "updatedAt",
] as const;

const REQUIRED_SECURE_PAYLOAD_NOT_NULL_COLUMNS = REQUIRED_SECURE_PAYLOAD_COLUMNS;
const REQUIRED_ADMIN_AUDIT_NOT_NULL_COLUMNS = [
  "id",
  "assessmentId",
  "actorUserId",
  "action",
  "outcome",
  "requestCorrelationId",
  "retainedUntil",
  "createdAt",
] as const;

const REQUIRED_ASSESSMENT_INDEXES = [
  "DataCreditoAssessment_correlation_key",
  "DataCreditoAssessment_pending_key",
  "DataCreditoAssessment_pending_document_key",
  "DataCreditoAssessment_reuse_idx",
  "DataCreditoAssessment_reuse_environment_idx",
  "DataCreditoAssessment_rate_idx",
  "DataCreditoAssessment_retention_idx",
  "DataCreditoAssessment_admin_created_idx",
  "DataCreditoAssessment_admin_document_idx",
  "DataCreditoAssessment_admin_status_idx",
] as const;

const REQUIRED_SECURE_PAYLOAD_INDEXES = [
  "DataCreditoSecurePayload_key_nonce_key",
] as const;

const REQUIRED_ADMIN_AUDIT_INDEXES = [
  "DataCreditoAdminAudit_retention_idx",
  "DataCreditoAdminAudit_assessment_created_idx",
] as const;

const REQUIRED_SECURE_PAYLOAD_CHECKS = [
  "DataCreditoSecurePayload_algorithm_check",
  "DataCreditoSecurePayload_key_id_check",
  "DataCreditoSecurePayload_aad_version_check",
  "DataCreditoSecurePayload_plaintext_version_check",
  "DataCreditoSecurePayload_nonce_check",
  "DataCreditoSecurePayload_auth_tag_check",
  "DataCreditoSecurePayload_plaintext_size_check",
  "DataCreditoSecurePayload_ciphertext_size_check",
] as const;

const REQUIRED_ADMIN_AUDIT_CHECKS = [
  "DataCreditoAdminAudit_action_check",
  "DataCreditoAdminAudit_outcome_check",
] as const;

function schemaNotReady() {
  return new DataCreditoStorageConfigurationError(
    "El esquema de DataCredito no esta preparado. Ejecuta npm run db:setup-datacredito antes de habilitar la integracion.",
    "SCHEMA_NOT_READY"
  );
}

async function verifyDataCreditoPolicyProfileSchema() {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      aliasPolicyNotNull: boolean;
      aliasPolicyTable: string | null;
      assignmentAuditHasPrimaryKey: boolean;
      assignmentAuditTable: string | null;
      policyProfileHasPrimaryKey: boolean;
      policyProfileTable: string | null;
      policyRevisionHasPrimaryKey: boolean;
      policyRevisionTable: string | null;
      requiredIndexesPresent: boolean;
      requiredTriggersPresent: boolean;
    }>
  >(`
    SELECT
      to_regclass('"Aliado"')::text AS "aliasPolicyTable",
      to_regclass('"DataCreditoPolicyProfile"')::text AS "policyProfileTable",
      to_regclass('"DataCreditoPolicyRevision"')::text AS "policyRevisionTable",
      to_regclass('"DataCreditoPolicyAssignmentAudit"')::text AS "assignmentAuditTable",
      EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('"Aliado"')
          AND attname = 'dataCreditoPolicyId' AND attnotnull
      ) AS "aliasPolicyNotNull",
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('"DataCreditoPolicyProfile"') AND contype = 'p'
      ) AS "policyProfileHasPrimaryKey",
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('"DataCreditoPolicyRevision"') AND contype = 'p'
      ) AS "policyRevisionHasPrimaryKey",
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('"DataCreditoPolicyAssignmentAudit"') AND contype = 'p'
      ) AS "assignmentAuditHasPrimaryKey",
      NOT EXISTS (
        SELECT required.name
        FROM (VALUES
          ('DataCreditoPolicyProfile_name_ci_key'),
          ('DataCreditoPolicyRevision_profile_version_key'),
          ('Aliado_dataCreditoPolicyId_idx'),
          ('DataCreditoPolicyAssignmentAudit_ally_created_idx')
        ) AS required(name)
        WHERE to_regclass(quote_ident(required.name)) IS NULL
      ) AS "requiredIndexesPresent",
      NOT EXISTS (
        SELECT required.name
        FROM (VALUES
          ('DataCreditoPolicy_sync_profile_revision'),
          ('DataCreditoPolicyRevision_immutable'),
          ('DataCreditoAssessment_resolve_legacy_revision'),
          ('DataCreditoAssessment_terminal_expiry')
        ) AS required(name)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = required.name AND NOT tgisinternal AND tgenabled <> 'D'
        )
      ) AS "requiredTriggersPresent"
  `);
  const state = rows[0];
  if (
    !state?.aliasPolicyTable ||
    !state.policyProfileTable ||
    !state.policyRevisionTable ||
    !state.assignmentAuditTable ||
    !state.aliasPolicyNotNull ||
    !state.policyProfileHasPrimaryKey ||
    !state.policyRevisionHasPrimaryKey ||
    !state.assignmentAuditHasPrimaryKey ||
    !state.requiredIndexesPresent ||
    !state.requiredTriggersPresent
  ) {
    throw schemaNotReady();
  }

  const columnRows = await prisma.$queryRawUnsafe<
    Array<{ columnName: string; isNotNull: boolean; tableName: string }>
  >(`
    SELECT c.relname AS "tableName", a.attname AS "columnName",
      a.attnotnull AS "isNotNull"
    FROM pg_attribute a
    INNER JOIN pg_class c ON c.oid = a.attrelid
    WHERE a.attrelid IN (
      to_regclass('"DataCreditoPolicyProfile"'),
      to_regclass('"DataCreditoPolicyRevision"'),
      to_regclass('"DataCreditoPolicyAssignmentAudit"')
    ) AND a.attnum > 0 AND NOT a.attisdropped
  `);
  const requiredColumns: Record<string, string[]> = {
    DataCreditoPolicyProfile: [
      "id", "name", "description", "active", "createdByUserId", "createdAt", "updatedAt",
    ],
    DataCreditoPolicyRevision: [
      "id", "profileId", "version", "policy", "createdByUserId", "createdAt",
    ],
    DataCreditoPolicyAssignmentAudit: [
      "id", "allyId", "previousPolicyId", "policyId", "actorUserId", "createdAt",
    ],
  };
  const nullableColumns = new Set([
    "DataCreditoPolicyProfile:description",
    "DataCreditoPolicyProfile:createdByUserId",
  ]);
  for (const [tableName, columns] of Object.entries(requiredColumns)) {
    for (const columnName of columns) {
      const column = columnRows.find(
        (candidate) =>
          candidate.tableName === tableName && candidate.columnName === columnName
      );
      if (
        !column ||
        (!nullableColumns.has(`${tableName}:${columnName}`) && !column.isNotNull)
      ) {
        throw schemaNotReady();
      }
    }
  }

  const constraints = await prisma.$queryRawUnsafe<
    Array<{
      constraintName: string;
      constraintType: string;
      deleteAction: string;
      isValid: boolean;
      referencedTable: string | null;
    }>
  >(`
    SELECT constraint_state.conname AS "constraintName",
      constraint_state.contype::text AS "constraintType",
      constraint_state.confdeltype::text AS "deleteAction",
      constraint_state.convalidated AS "isValid",
      referenced_table.relname AS "referencedTable"
    FROM pg_constraint constraint_state
    LEFT JOIN pg_class referenced_table
      ON referenced_table.oid = constraint_state.confrelid
    WHERE constraint_state.conname IN (
      'Aliado_dataCreditoPolicy_fkey',
      'DataCreditoPolicyRevision_profile_fkey',
      'DataCreditoAssessment_policyRevision_fkey',
      'DataCreditoAssessment_reusedFrom_fkey',
      'DataCreditoPolicyAssignmentAudit_ally_fkey',
      'DataCreditoPolicyAssignmentAudit_previous_fkey',
      'DataCreditoPolicyAssignmentAudit_policy_fkey'
    )
  `);
  const constraintMap = new Map(
    constraints.map((constraint) => [constraint.constraintName, constraint])
  );
  const requiredForeignKeys: Array<[string, string, string]> = [
    ["Aliado_dataCreditoPolicy_fkey", "DataCreditoPolicyProfile", "r"],
    ["DataCreditoPolicyRevision_profile_fkey", "DataCreditoPolicyProfile", "r"],
    ["DataCreditoAssessment_policyRevision_fkey", "DataCreditoPolicyRevision", "r"],
    ["DataCreditoAssessment_reusedFrom_fkey", "DataCreditoAssessment", "c"],
    ["DataCreditoPolicyAssignmentAudit_ally_fkey", "Aliado", "r"],
    ["DataCreditoPolicyAssignmentAudit_previous_fkey", "DataCreditoPolicyProfile", "r"],
    ["DataCreditoPolicyAssignmentAudit_policy_fkey", "DataCreditoPolicyProfile", "r"],
  ];
  if (
    requiredForeignKeys.some(([name, referencedTable, deleteAction]) => {
      const constraint = constraintMap.get(name);
      return (
        constraint?.constraintType !== "f" ||
        !constraint.isValid ||
        constraint.referencedTable !== referencedTable ||
        constraint.deleteAction !== deleteAction
      );
    })
  ) {
    throw schemaNotReady();
  }
}

async function verifyDataCreditoSchema() {
  await verifyDataCreditoPolicyProfileSchema();
  const tableRows = await prisma.$queryRawUnsafe<
    Array<{
      adminAuditHasPrimaryKey: boolean;
      adminAuditTable: string | null;
      assessmentHasPrimaryKey: boolean;
      assessmentTable: string | null;
      policyHasPrimaryKey: boolean;
      policyTable: string | null;
      securePayloadHasPrimaryKey: boolean;
      securePayloadTable: string | null;
    }>
  >(`
    SELECT
      to_regclass('"DataCreditoPolicy"')::text AS "policyTable",
      to_regclass('"DataCreditoAssessment"')::text AS "assessmentTable",
      to_regclass('"DataCreditoAssessmentSecurePayload"')::text AS "securePayloadTable",
      to_regclass('"DataCreditoAdminAccessAudit"')::text AS "adminAuditTable",
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('"DataCreditoPolicy"') AND contype = 'p'
      ) AS "policyHasPrimaryKey",
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('"DataCreditoAssessment"') AND contype = 'p'
      ) AS "assessmentHasPrimaryKey",
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('"DataCreditoAssessmentSecurePayload"') AND contype = 'p'
      ) AS "securePayloadHasPrimaryKey",
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('"DataCreditoAdminAccessAudit"') AND contype = 'p'
      ) AS "adminAuditHasPrimaryKey"
  `);
  const tableState = tableRows[0];

  if (
    !tableState?.policyTable ||
    !tableState.assessmentTable ||
    !tableState.securePayloadTable ||
    !tableState.adminAuditTable ||
    !tableState.policyHasPrimaryKey ||
    !tableState.assessmentHasPrimaryKey ||
    !tableState.securePayloadHasPrimaryKey ||
    !tableState.adminAuditHasPrimaryKey
  ) {
    throw schemaNotReady();
  }

  const columnRows = await prisma.$queryRawUnsafe<
    Array<{ columnName: string; isNotNull: boolean; tableName: string }>
  >(`
    SELECT
      c.relname AS "tableName",
      a.attname AS "columnName",
      a.attnotnull AS "isNotNull"
    FROM pg_attribute a
    INNER JOIN pg_class c ON c.oid = a.attrelid
    WHERE a.attrelid IN (
      to_regclass('"DataCreditoPolicy"'),
      to_regclass('"DataCreditoAssessment"'),
      to_regclass('"DataCreditoAssessmentSecurePayload"'),
      to_regclass('"DataCreditoAdminAccessAudit"')
    )
      AND a.attnum > 0
      AND NOT a.attisdropped
  `);
  const policyColumns = new Set(
    columnRows
      .filter((row) => row.tableName === "DataCreditoPolicy")
      .map((row) => row.columnName)
  );
  const assessmentColumns = new Set(
    columnRows
      .filter((row) => row.tableName === "DataCreditoAssessment")
      .map((row) => row.columnName)
  );
  const securePayloadColumns = new Set(
    columnRows
      .filter((row) => row.tableName === "DataCreditoAssessmentSecurePayload")
      .map((row) => row.columnName)
  );
  const adminAuditColumns = new Set(
    columnRows
      .filter((row) => row.tableName === "DataCreditoAdminAccessAudit")
      .map((row) => row.columnName)
  );
  const policyNotNullColumns = new Set(
    columnRows
      .filter((row) => row.tableName === "DataCreditoPolicy" && row.isNotNull)
      .map((row) => row.columnName)
  );
  const assessmentNotNullColumns = new Set(
    columnRows
      .filter(
        (row) => row.tableName === "DataCreditoAssessment" && row.isNotNull
      )
      .map((row) => row.columnName)
  );

  const securePayloadNotNullColumns = new Set(
    columnRows
      .filter(
        (row) =>
          row.tableName === "DataCreditoAssessmentSecurePayload" && row.isNotNull
      )
      .map((row) => row.columnName)
  );
  const adminAuditNotNullColumns = new Set(
    columnRows
      .filter(
        (row) => row.tableName === "DataCreditoAdminAccessAudit" && row.isNotNull
      )
      .map((row) => row.columnName)
  );

  if (
    REQUIRED_POLICY_COLUMNS.some((column) => !policyColumns.has(column)) ||
    REQUIRED_ASSESSMENT_COLUMNS.some((column) => !assessmentColumns.has(column)) ||
    REQUIRED_SECURE_PAYLOAD_COLUMNS.some(
      (column) => !securePayloadColumns.has(column)
    ) ||
    REQUIRED_ADMIN_AUDIT_COLUMNS.some((column) => !adminAuditColumns.has(column)) ||
    REQUIRED_POLICY_NOT_NULL_COLUMNS.some(
      (column) => !policyNotNullColumns.has(column)
    ) ||
    REQUIRED_ASSESSMENT_NOT_NULL_COLUMNS.some(
      (column) => !assessmentNotNullColumns.has(column)
    ) ||
    REQUIRED_SECURE_PAYLOAD_NOT_NULL_COLUMNS.some(
      (column) => !securePayloadNotNullColumns.has(column)
    ) ||
    REQUIRED_ADMIN_AUDIT_NOT_NULL_COLUMNS.some(
      (column) => !adminAuditNotNullColumns.has(column)
    )
  ) {
    throw schemaNotReady();
  }

  const constraintRows = await prisma.$queryRawUnsafe<
    Array<{
      constraintName: string;
      constraintType: string;
      deleteAction: string;
      isValid: boolean;
      referencedTable: string | null;
      tableName: string;
    }>
  >(`
    SELECT
      constraint_state.conname AS "constraintName",
      constraint_state.contype::text AS "constraintType",
      constraint_state.confdeltype::text AS "deleteAction",
      constraint_state.convalidated AS "isValid",
      referenced_table.relname AS "referencedTable",
      source_table.relname AS "tableName"
    FROM pg_constraint constraint_state
    INNER JOIN pg_class source_table
      ON source_table.oid = constraint_state.conrelid
    LEFT JOIN pg_class referenced_table
      ON referenced_table.oid = constraint_state.confrelid
    WHERE constraint_state.conrelid IN (
      to_regclass('"DataCreditoAssessmentSecurePayload"'),
      to_regclass('"DataCreditoAdminAccessAudit"')
    )
  `);
  const constraints = new Map(
    constraintRows.map((row) => [
      `${row.tableName}:${row.constraintName}`,
      row,
    ])
  );
  const securePayloadForeignKey = constraints.get(
    "DataCreditoAssessmentSecurePayload:DataCreditoSecurePayload_assessment_fkey"
  );
  const adminAuditForeignKey = constraints.get(
    "DataCreditoAdminAccessAudit:DataCreditoAdminAudit_assessment_fkey"
  );
  const hasValidCascadeForeignKey = (
    constraint:
      | {
          constraintType: string;
          deleteAction: string;
          isValid: boolean;
          referencedTable: string | null;
        }
      | undefined
  ) =>
    constraint?.constraintType === "f" &&
    constraint.deleteAction === "c" &&
    constraint.isValid &&
    constraint.referencedTable === "DataCreditoAssessment";

  if (
    !hasValidCascadeForeignKey(securePayloadForeignKey) ||
    !hasValidCascadeForeignKey(adminAuditForeignKey) ||
    REQUIRED_SECURE_PAYLOAD_CHECKS.some(
      (name) =>
        constraints.get(`DataCreditoAssessmentSecurePayload:${name}`)
          ?.constraintType !== "c" ||
        !constraints.get(`DataCreditoAssessmentSecurePayload:${name}`)?.isValid
    ) ||
    REQUIRED_ADMIN_AUDIT_CHECKS.some(
      (name) =>
        constraints.get(`DataCreditoAdminAccessAudit:${name}`)?.constraintType !==
          "c" ||
        !constraints.get(`DataCreditoAdminAccessAudit:${name}`)?.isValid
    )
  ) {
    throw schemaNotReady();
  }

  const indexRows = await prisma.$queryRawUnsafe<
    Array<
      DataCreditoSchemaIndexMetadata & {
        indexName: string;
        tableName: string;
      }
    >
  >(`
    SELECT
      ARRAY(
        SELECT indexed_attribute.attname::text
        FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
          AS index_key(attnum, position)
        LEFT JOIN pg_attribute indexed_attribute
          ON indexed_attribute.attrelid = index_state.indrelid
          AND indexed_attribute.attnum = index_key.attnum
          AND index_key.attnum > 0
        WHERE index_key.position <= index_state.indnkeyatts
        ORDER BY index_key.position
      ) AS "columnNames",
      ARRAY(
        SELECT CASE
          WHEN index_key.attnum = 0 THEN pg_get_indexdef(
            index_state.indexrelid,
            index_key.position::integer,
            false
          )
          ELSE NULL
        END
        FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
          AS index_key(attnum, position)
        WHERE index_key.position <= index_state.indnkeyatts
        ORDER BY index_key.position
      ) AS "expressionDefinitions",
      index_class.relname AS "indexName",
      index_table.relname AS "tableName",
      index_state.indisunique AS "isUnique",
      index_state.indisvalid AS "isValid",
      pg_get_expr(index_state.indpred, index_state.indrelid) AS "predicate"
    FROM pg_index index_state
    INNER JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
    INNER JOIN pg_class index_table ON index_table.oid = index_state.indrelid
    WHERE index_state.indrelid IN (
      to_regclass('"DataCreditoAssessment"'),
      to_regclass('"DataCreditoAssessmentSecurePayload"'),
      to_regclass('"DataCreditoAdminAccessAudit"')
    )
  `);
  const indexes = new Map(
    indexRows.map((row) => [`${row.tableName}:${row.indexName}`, row])
  );
  const assessmentIndex = (name: string) =>
    indexes.get(`DataCreditoAssessment:${name}`);
  const securePayloadIndex = (name: string) =>
    indexes.get(`DataCreditoAssessmentSecurePayload:${name}`);
  const adminAuditIndex = (name: string) =>
    indexes.get(`DataCreditoAdminAccessAudit:${name}`);
  const correlationIndex = assessmentIndex(
    "DataCreditoAssessment_correlation_key"
  );
  const identityPendingIndex = assessmentIndex(
    "DataCreditoAssessment_pending_key"
  );
  const pendingIndex = assessmentIndex(
    "DataCreditoAssessment_pending_document_key"
  );
  const reuseEnvironmentIndex = assessmentIndex(
    "DataCreditoAssessment_reuse_environment_idx"
  );
  const secureKeyNonceIndex = securePayloadIndex(
    "DataCreditoSecurePayload_key_nonce_key"
  );
  const auditRetentionIndex = adminAuditIndex(
    "DataCreditoAdminAudit_retention_idx"
  );

  if (
    REQUIRED_ASSESSMENT_INDEXES.some(
      (index) => !assessmentIndex(index)?.isValid
    ) ||
    REQUIRED_SECURE_PAYLOAD_INDEXES.some(
      (index) => !securePayloadIndex(index)?.isValid
    ) ||
    REQUIRED_ADMIN_AUDIT_INDEXES.some(
      (index) => !adminAuditIndex(index)?.isValid
    ) ||
    !matchesDataCreditoSchemaIndex(correlationIndex, {
      keys: [{ column: "correlationId" }],
      predicate: null,
      unique: true,
    }) ||
    !matchesDataCreditoSchemaIndex(identityPendingIndex, {
      keys: [
        { column: "documentHash" },
        { column: "surnameHash" },
        { column: "platform" },
        { column: "policyRevisionId" },
        { column: "userId" },
        { expression: 'COALESCE("sellerId", 0)' },
        { column: "sedeId" },
        { expression: 'COALESCE("aliadoId", 0)' },
      ],
      predicate: "PENDING_STATUS",
      unique: true,
    }) ||
    !matchesDataCreditoSchemaIndex(pendingIndex, {
      keys: [
        { column: "documentHash" },
        { column: "providerEnvironment" },
        { expression: 'COALESCE("aliadoId", 0)' },
      ],
      predicate: "PENDING_STATUS",
      unique: true,
    }) ||
    !matchesDataCreditoSchemaIndex(reuseEnvironmentIndex, {
      keys: [
        { column: "documentHash" },
        { column: "providerEnvironment" },
        { expression: 'COALESCE("aliadoId", 0)' },
        { column: "expiresAt" },
        { column: "createdAt" },
      ],
      predicate: null,
      unique: false,
    }) ||
    !matchesDataCreditoSchemaIndex(secureKeyNonceIndex, {
      keys: [{ column: "keyId" }, { column: "nonce" }],
      predicate: null,
      unique: true,
    }) ||
    !matchesDataCreditoSchemaIndex(auditRetentionIndex, {
      keys: [{ column: "retainedUntil" }],
      predicate: null,
      unique: false,
    })
  ) {
    throw schemaNotReady();
  }
}

async function initializeDataCreditoSchema() {
  if (process.env.NODE_ENV === "production") {
    await verifyDataCreditoSchema();
    return;
  }

  await setupDataCreditoSchema();
  await verifyDataCreditoSchema();
}

export async function ensureDataCreditoSchema() {
  if (!schemaPromise) {
    schemaPromise = initializeDataCreditoSchema().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

async function getLatestDataCreditoPolicyRevision(
  profileId: string,
  database: DataCreditoQueryExecutor = prisma
) {
  const rows = await database.$queryRawUnsafe<DataCreditoPolicyRevisionRow[]>(
    `
      SELECT revision."id" AS "revisionId", revision."profileId",
        profile."name" AS "profileName",
        profile."description" AS "profileDescription",
        profile."active" AS "profileActive",
        revision."version", revision."policy", revision."createdByUserId",
        revision."createdAt"
      FROM "DataCreditoPolicyRevision" revision
      INNER JOIN "DataCreditoPolicyProfile" profile
        ON profile."id" = revision."profileId"
      WHERE revision."profileId" = $1
      ORDER BY revision."version" DESC
      LIMIT 1
    `,
    profileId
  );
  return policyFromRevisionRow(rows[0] || null);
}

export async function getCurrentDataCreditoPolicy() {
  await ensureDataCreditoSchema();
  return getLatestDataCreditoPolicyRevision(DEFAULT_DATACREDITO_POLICY_PROFILE_ID);
}

export async function getAssignedDataCreditoPolicy(
  allyId: number | null
): Promise<DataCreditoAssignedPolicyResolution> {
  await ensureDataCreditoSchema();
  if (!Number.isInteger(allyId) || Number(allyId) <= 0) {
    return { kind: "ALLY_NOT_FOUND", policy: null, profileId: null };
  }
  const rows = await prisma.$queryRawUnsafe<DataCreditoAssignedPolicyRow[]>(
    `
      SELECT ally."id" AS "allyId", ally."dataCreditoPolicyId" AS "policyId",
        profile."name" AS "profileName",
        profile."description" AS "profileDescription",
        profile."active" AS "profileActive",
        revision."id" AS "revisionId", revision."version", revision."policy",
        revision."createdByUserId", revision."createdAt"
      FROM "Aliado" ally
      LEFT JOIN "DataCreditoPolicyProfile" profile
        ON profile."id" = ally."dataCreditoPolicyId"
      LEFT JOIN LATERAL (
        SELECT candidate."id", candidate."version", candidate."policy",
          candidate."createdByUserId", candidate."createdAt"
        FROM "DataCreditoPolicyRevision" candidate
        WHERE candidate."profileId" = profile."id"
        ORDER BY candidate."version" DESC
        LIMIT 1
      ) revision ON true
      WHERE ally."id" = $1
      LIMIT 1
    `,
    allyId
  );
  const row = rows[0];
  if (!row) return { kind: "ALLY_NOT_FOUND", policy: null, profileId: null };
  if (!row.policyId || !row.profileName) {
    return { kind: "POLICY_NOT_ASSIGNED", policy: null, profileId: row.policyId };
  }
  if (!row.profileActive) {
    return { kind: "POLICY_INACTIVE", policy: null, profileId: row.policyId };
  }
  if (
    !row.revisionId ||
    row.version === null ||
    !row.createdAt ||
    row.createdByUserId === null
  ) {
    return { kind: "POLICY_NO_REVISION", policy: null, profileId: row.policyId };
  }
  const policy = policyFromRevisionRow({
    revisionId: row.revisionId,
    profileId: row.policyId,
    profileName: row.profileName,
    profileDescription: row.profileDescription,
    profileActive: row.profileActive,
    version: row.version,
    policy: row.policy,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  });
  if (!policy?.profileId || !policy.revisionId) {
    return { kind: "POLICY_NO_REVISION", policy: null, profileId: row.policyId };
  }
  return {
    kind: "READY",
    policy: policy as DataCreditoPolicy & { profileId: string; revisionId: string },
  };
}

export async function createDataCreditoPolicyRevision(input: {
  profileId: string;
  bands: DataCreditoPolicyBand[];
  createdByUserId: number;
  expectedVersion?: number | null;
}) {
  await ensureDataCreditoSchema();
  if (!isUuid(input.profileId)) throw new DataCreditoPolicyNotFoundError();
  const bands = parseDataCreditoPolicyBands(input.bands);

  return prisma.$transaction(async (tx) => {
    if (input.profileId === DEFAULT_DATACREDITO_POLICY_PROFILE_ID) {
      await tx.$executeRawUnsafe(`LOCK TABLE "DataCreditoPolicy" IN EXCLUSIVE MODE`);
    }
    const profiles = await tx.$queryRawUnsafe<Array<{ active: boolean }>>(
      `SELECT "active" FROM "DataCreditoPolicyProfile" WHERE "id" = $1 FOR UPDATE`,
      input.profileId
    );
    if (!profiles[0]) throw new DataCreditoPolicyNotFoundError();
    if (!profiles[0].active) {
      throw new DataCreditoPolicyValidationError([
        "La politica inactiva no admite nuevas revisiones",
      ]);
    }
    const currentRows = await tx.$queryRawUnsafe<Array<{ version: number }>>(
      `
        SELECT "version" FROM "DataCreditoPolicyRevision"
        WHERE "profileId" = $1 ORDER BY "version" DESC LIMIT 1
      `,
      input.profileId
    );
    const currentVersion = currentRows[0]?.version ?? null;
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== currentVersion
    ) {
      throw new DataCreditoPolicyConflictError(currentVersion);
    }
    const nextVersion = (currentVersion || 0) + 1;
    const revisionId = randomUUID();
    await tx.$executeRawUnsafe(
      `
        INSERT INTO "DataCreditoPolicyRevision" (
          "id", "profileId", "version", "policy", "createdByUserId"
        ) VALUES ($1, $2, $3, $4::jsonb, $5)
      `,
      revisionId,
      input.profileId,
      nextVersion,
      JSON.stringify({ bands }),
      input.createdByUserId
    );
    if (input.profileId === DEFAULT_DATACREDITO_POLICY_PROFILE_ID) {
      await tx.$executeRawUnsafe(
        `
          INSERT INTO "DataCreditoPolicy" (
            "version", "policy", "createdByUserId"
          ) VALUES ($1, $2::jsonb, $3)
          ON CONFLICT ("version") DO NOTHING
        `,
        nextVersion,
        JSON.stringify({ bands }),
        input.createdByUserId
      );
    }
    return getLatestDataCreditoPolicyRevision(input.profileId, tx);
  });
}

export async function createDataCreditoPolicyVersion(input: {
  profileId?: string;
  bands: DataCreditoPolicyBand[];
  createdByUserId: number;
  expectedVersion?: number | null;
}) {
  return createDataCreditoPolicyRevision({
    ...input,
    profileId: input.profileId || DEFAULT_DATACREDITO_POLICY_PROFILE_ID,
  });
}

export async function purgeExpiredDataCreditoAssessments() {
  await ensureDataCreditoSchema();
  const now = new Date();
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `DELETE FROM "DataCreditoAdminAccessAudit" WHERE "retainedUntil" < $1`,
      now
    );
    return transaction.$executeRawUnsafe(
      `DELETE FROM "DataCreditoAssessment" WHERE "retainedUntil" < $1`,
      now
    );
  });
}

async function findReusableDataCreditoAssessment(
  input: {
    hashes: ReturnType<typeof buildDataCreditoIdentityHashes>;
    platform: DataCreditoPlatform;
    providerEnvironment: string;
    scope: DataCreditoAssessmentScope;
  },
  database: DataCreditoQueryExecutor
) {
  const rows = await database.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      SELECT assessment.*
      FROM "DataCreditoAssessment" assessment
      WHERE assessment."documentHash" = $1
        AND assessment."providerEnvironment" = $2
        AND assessment."aliadoId" IS NOT DISTINCT FROM $3
        AND assessment."status" IN ('APROBADO', 'RECHAZADO')
        AND assessment."expiresAt" > CURRENT_TIMESTAMP
        AND assessment."consumedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "DataCreditoAssessment" consumed
          WHERE COALESCE(consumed."reusedFromAssessmentId", consumed."id") =
            COALESCE(assessment."reusedFromAssessmentId", assessment."id")
            AND consumed."consumedAt" IS NOT NULL
        )
      ORDER BY (
        assessment."surnameHash" = $4
        AND assessment."platform" = $5
        AND assessment."userId" = $6
        AND assessment."sellerId" IS NOT DISTINCT FROM $7
        AND assessment."sedeId" = $8
      ) DESC,
        assessment."expiresAt" DESC, assessment."createdAt" DESC
      LIMIT 1
    `,
    input.hashes.documentHash,
    input.providerEnvironment,
    input.scope.aliadoId,
    input.hashes.surnameHash,
    input.platform,
    input.scope.userId,
    input.scope.sellerId,
    input.scope.sedeId
  );
  return rows[0] || null;
}

function dataCreditoAssessmentHasCurrentIdentityAndScope(
  row: DataCreditoAssessmentRow,
  input: DataCreditoAssessmentReuseInput
) {
  return (
    row.surnameHash === input.surnameHash &&
    row.platform === input.platform &&
    row.userId === input.userId &&
    row.sellerId === input.sellerId &&
    row.sedeId === input.sedeId &&
    row.aliadoId === input.aliadoId
  );
}

async function hasActiveClaimForDataCreditoAssessmentGroup(
  sourceRow: DataCreditoAssessmentRow,
  database: DataCreditoQueryExecutor
) {
  const rootId = sourceRow.reusedFromAssessmentId || sourceRow.id;
  const rows = await database.$queryRawUnsafe<Array<{ active: boolean }>>(
    `
      SELECT EXISTS (
        SELECT 1 FROM "DataCreditoAssessment" claimed
        WHERE COALESCE(claimed."reusedFromAssessmentId", claimed."id") = $1
          AND claimed."claimTokenHash" IS NOT NULL
          AND claimed."claimExpiresAt" > CURRENT_TIMESTAMP
      ) AS "active"
    `,
    rootId
  );
  return Boolean(rows[0]?.active);
}

async function cloneReusableDataCreditoAssessment(
  sourceRow: DataCreditoAssessmentRow,
  input: DataCreditoAssessmentReuseInput,
  database: DataCreditoQueryExecutor
) {
  const rootId = sourceRow.reusedFromAssessmentId || sourceRow.id;
  const revisionRows = await database.$queryRawUnsafe<DataCreditoPolicyRevisionRow[]>(
    `
      SELECT revision."id" AS "revisionId", revision."profileId",
        profile."name" AS "profileName",
        profile."description" AS "profileDescription",
        profile."active" AS "profileActive", revision."version",
        revision."policy", revision."createdByUserId", revision."createdAt"
      FROM "DataCreditoPolicyRevision" revision
      INNER JOIN "DataCreditoPolicyProfile" profile
        ON profile."id" = revision."profileId"
      WHERE revision."id" = $1
      LIMIT 1
    `,
    sourceRow.policyRevisionId
  );
  const historicalPolicy = policyFromRevisionRow(revisionRows[0] || null);
  const resolution =
    historicalPolicy && sourceRow.score !== null
      ? resolveDataCreditoDecision(historicalPolicy, input.platform, sourceRow.score)
      : null;
  if (!resolution) throw schemaNotReady();

  const rows = await database.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      INSERT INTO "DataCreditoAssessment" (
        "id", "documentHash", "documentLast4", "surnameHash", "platform",
        "providerEnvironment", "status", "score", "decision", "offer",
        "policyVersion", "policyRevisionId", "reusedFromAssessmentId",
        "consentVersion", "consentHash", "consentAt", "userId", "sellerId",
        "sedeId", "aliadoId", "ipHash", "userAgentHash", "correlationId",
        "transactionCode", "providerStatus", "errorCode", "durationMs",
        "expiresAt", "retainedUntil"
      )
      SELECT $1, source."documentHash", source."documentLast4",
        $3, $4, source."providerEnvironment",
        $5, source."score", $5, $6::jsonb,
        source."policyVersion", source."policyRevisionId", $2,
        $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        source."transactionCode", source."providerStatus", NULL,
        source."durationMs", source."expiresAt", source."retainedUntil"
      FROM "DataCreditoAssessment" source
      WHERE source."id" = $17
        AND source."status" IN ('APROBADO', 'RECHAZADO')
        AND source."expiresAt" > CURRENT_TIMESTAMP
        AND source."consumedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "DataCreditoAssessment" consumed
          WHERE COALESCE(consumed."reusedFromAssessmentId", consumed."id") = $2
            AND consumed."consumedAt" IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM "DataCreditoAssessment" claimed
          WHERE COALESCE(claimed."reusedFromAssessmentId", claimed."id") = $2
            AND claimed."claimTokenHash" IS NOT NULL
            AND claimed."claimExpiresAt" > CURRENT_TIMESTAMP
        )
      RETURNING *
    `,
    randomUUID(),
    rootId,
    input.surnameHash,
    input.platform,
    resolution.decision,
    JSON.stringify(resolution.offer),
    DATACREDITO_CONSENT_VERSION,
    DATACREDITO_CONSENT_HASH,
    input.consentAt,
    input.userId,
    input.sellerId,
    input.sedeId,
    input.aliadoId,
    input.ipHash,
    input.userAgentHash,
    input.correlationId,
    sourceRow.id
  );
  return rows[0] || null;
}

async function tryReuseDataCreditoAssessment(
  input: DataCreditoAssessmentReuseInput,
  database: DataCreditoQueryExecutor
): Promise<Extract<DataCreditoAssessmentReservation, { kind: "REUSED" | "IN_PROGRESS" }> | null> {
  const reusable = await findReusableDataCreditoAssessment(
    {
      hashes: {
        documentHash: input.documentHash,
        documentLast4: input.documentLast4,
        surnameHash: input.surnameHash,
      },
      platform: input.platform,
      providerEnvironment: input.providerEnvironment,
      scope: input,
    },
    database
  );
  if (!reusable) return null;
  if (await hasActiveClaimForDataCreditoAssessmentGroup(reusable, database)) {
    return { kind: "IN_PROGRESS" };
  }
  if (dataCreditoAssessmentHasCurrentIdentityAndScope(reusable, input)) {
    return { kind: "REUSED", assessment: reusable };
  }
  const clone = await cloneReusableDataCreditoAssessment(reusable, input, database);
  if (clone) return { kind: "REUSED", assessment: clone };
  if (await hasActiveClaimForDataCreditoAssessmentGroup(reusable, database)) {
    return { kind: "IN_PROGRESS" };
  }
  return null;
}

function dataCreditoDocumentLockKey(input: {
  aliadoId: number | null;
  documentHash: string;
  providerEnvironment: string;
}) {
  return [
    "datacredito-document",
    input.aliadoId || 0,
    input.providerEnvironment,
    input.documentHash,
  ].join(":");
}

export async function reuseDataCreditoAssessment(
  input: DataCreditoAssessmentReuseInput
): Promise<Extract<DataCreditoAssessmentReservation, { kind: "REUSED" | "IN_PROGRESS" }> | null> {
  await ensureDataCreditoSchema();
  const staleMinutes = getDataCreditoPendingStaleMinutes();
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
      dataCreditoDocumentLockKey(input)
    );
    const reusable = await tryReuseDataCreditoAssessment(input, transaction);
    if (reusable) return reusable;
    const pendingRows = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
      `
        SELECT "id" FROM "DataCreditoAssessment"
        WHERE "status" = 'PENDING' AND "documentHash" = $1
          AND "providerEnvironment" = $2
          AND "aliadoId" IS NOT DISTINCT FROM $3
          AND "createdAt" >= CURRENT_TIMESTAMP - ($4::integer * INTERVAL '1 minute')
        LIMIT 1
      `,
      input.documentHash,
      input.providerEnvironment,
      input.aliadoId,
      staleMinutes
    );
    return pendingRows.length ? { kind: "IN_PROGRESS" as const } : null;
  });
}

async function countRecentDataCreditoAssessments(
  input: {
    documentHash: string;
    scope: DataCreditoAssessmentScope;
  },
  database: DataCreditoQueryExecutor
) {
  const rows = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
    `
      SELECT COUNT(*)::bigint AS "count"
      FROM "DataCreditoAssessment"
      WHERE "sedeId" = $1
        AND "aliadoId" IS NOT DISTINCT FROM $2
        AND "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '15 minutes'
        AND ("userId" = $3 OR "documentHash" = $4)
    `,
    input.scope.sedeId,
    input.scope.aliadoId,
    input.scope.userId,
    input.documentHash
  );
  return Number(rows[0]?.count || 0);
}

async function insertPendingDataCreditoAssessment(
  input: CreatePendingAssessmentInput,
  database: DataCreditoQueryExecutor
) {
  const ttlMinutes = getDataCreditoAssessmentTtlMinutes();
  const retentionDays = getDataCreditoRetentionDays();
  const id = randomUUID();
  const rows = await database.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      INSERT INTO "DataCreditoAssessment" (
        "id", "documentHash", "documentLast4", "surnameHash", "platform",
        "providerEnvironment", "status", "policyVersion", "policyRevisionId",
        "consentVersion", "consentHash", "consentAt",
        "userId", "sellerId", "sedeId", "aliadoId", "ipHash", "userAgentHash",
        "correlationId", "expiresAt", "retainedUntil"
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18,
        CURRENT_TIMESTAMP + ($19::integer * INTERVAL '1 minute'),
        CURRENT_TIMESTAMP + ($20::integer * INTERVAL '1 day')
      )
      RETURNING *
    `,
    id,
    input.documentHash,
    input.documentLast4,
    input.surnameHash,
    input.platform,
    input.providerEnvironment,
    input.policyVersion,
    input.policyRevisionId,
    DATACREDITO_CONSENT_VERSION,
    DATACREDITO_CONSENT_HASH,
    input.consentAt,
    input.userId,
    input.sellerId,
    input.sedeId,
    input.aliadoId,
    input.ipHash,
    input.userAgentHash,
    input.correlationId,
    ttlMinutes,
    retentionDays
  );
  return rows[0] || null;
}

export async function reserveDataCreditoAssessment(
  input: CreatePendingAssessmentInput & {
    rateLimitMax?: number;
  }
): Promise<DataCreditoAssessmentReservation> {
  await ensureDataCreditoSchema();
  const rateLimitMax = input.rateLimitMax ?? getDataCreditoRateLimitMax();
  const staleMinutes = getDataCreditoPendingStaleMinutes();
  const actorLockKey = [
    "datacredito-rate",
    input.aliadoId || 0,
    input.sedeId,
    input.userId,
  ].join(":");
  const documentLockKey = dataCreditoDocumentLockKey(input);
  const lockKeys = [actorLockKey, documentLockKey].sort();

  return prisma.$transaction(
    async (transaction) => {
      for (const lockKey of lockKeys) {
        await transaction.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
          lockKey
        );
      }

      // Only the same tenant/site/document can release a stale reservation.
      // The threshold covers the provider's longest documented retry sequence.
      await transaction.$executeRawUnsafe(
        `
          UPDATE "DataCreditoAssessment"
          SET "status" = 'NO_EVALUADO',
              "errorCode" = 'STALE_PENDING',
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "status" = 'PENDING'
            AND "documentHash" = $1
            AND "providerEnvironment" = $2
            AND "aliadoId" IS NOT DISTINCT FROM $3
            AND "createdAt" < CURRENT_TIMESTAMP - ($4::integer * INTERVAL '1 minute')
        `,
        input.documentHash,
        input.providerEnvironment,
        input.aliadoId,
        staleMinutes
      );

      const reusable = await tryReuseDataCreditoAssessment(input, transaction);
      if (reusable) return reusable;

      const activeRows = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
        `
          SELECT "id"
          FROM "DataCreditoAssessment"
          WHERE "status" = 'PENDING'
            AND "documentHash" = $1
            AND "providerEnvironment" = $2
            AND "aliadoId" IS NOT DISTINCT FROM $3
          LIMIT 1
        `,
        input.documentHash,
        input.providerEnvironment,
        input.aliadoId
      );
      if (activeRows.length) {
        return { kind: "IN_PROGRESS" };
      }

      const recentCount = await countRecentDataCreditoAssessments(
        { documentHash: input.documentHash, scope: input },
        transaction
      );
      if (recentCount >= rateLimitMax) {
        return { kind: "RATE_LIMITED" };
      }

      const assessment = await insertPendingDataCreditoAssessment(input, transaction);
      if (!assessment) {
        throw new Error("DATACREDITO_ASSESSMENT_RESERVATION_FAILED");
      }

      return { kind: "CREATED", assessment };
    },
    { maxWait: 5_000, timeout: 10_000 }
  );
}

export async function completeDataCreditoAssessment(input: CompleteAssessmentInput) {
  await ensureDataCreditoSchema();
  const rows = await prisma.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      UPDATE "DataCreditoAssessment"
      SET "status" = $2,
          "score" = $3,
          "decision" = $2,
          "offer" = $4::jsonb,
          "transactionCode" = $5,
          "providerStatus" = $6,
          "durationMs" = $7,
          "errorCode" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "status" = 'PENDING'
      RETURNING *
    `,
    input.id,
    input.decision,
    input.score,
    JSON.stringify(input.offer),
    input.transactionCode,
    input.providerStatus,
    input.durationMs
  );
  return rows[0] || null;
}

export async function failDataCreditoAssessment(input: {
  id: string;
  errorCode: string;
  transactionCode?: string | null;
  providerStatus?: string | null;
  durationMs?: number | null;
}) {
  await ensureDataCreditoSchema();
  const rows = await prisma.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      UPDATE "DataCreditoAssessment"
      SET "status" = 'NO_EVALUADO',
          "errorCode" = $2,
          "transactionCode" = $3,
          "providerStatus" = $4,
          "durationMs" = $5,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "status" = 'PENDING'
      RETURNING *
    `,
    input.id,
    input.errorCode,
    input.transactionCode || null,
    input.providerStatus || null,
    input.durationMs ?? null
  );
  return rows[0] || null;
}

export async function getDataCreditoAssessmentById(id: string) {
  if (!isUuid(id)) return null;
  await ensureDataCreditoSchema();
  const rows = await prisma.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `SELECT * FROM "DataCreditoAssessment" WHERE "id" = $1 LIMIT 1`,
    id
  );
  return rows[0] || null;
}

export function dataCreditoAssessmentMatchesScope(
  row: DataCreditoAssessmentRow,
  scope: DataCreditoAssessmentScope
) {
  return (
    row.userId === scope.userId &&
    row.sellerId === scope.sellerId &&
    row.sedeId === scope.sedeId &&
    row.aliadoId === scope.aliadoId
  );
}

export function serializeDataCreditoAssessment(row: DataCreditoAssessmentRow) {
  const approved = row.status === "APROBADO";
  return {
    assessmentId: row.id,
    status: row.status === "RECHAZADO" ? "RECHAZADO" : approved ? "APROBADO" : "NO_EVALUADO",
    expiresAt:
      row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt),
    offer: approved
      ? {
          initialPaymentPercentage: Number(row.offer?.initialPaymentPercentage),
          suretyPercentage: Number(row.offer?.suretyPercentage),
          maxFinancedAmount: Number(row.offer?.maxFinancedAmount),
          policyVersion: row.policyVersion,
        }
      : null,
  } as const;
}

export type DataCreditoAssessmentMatchInput = DataCreditoIdentityInput &
  DataCreditoAssessmentScope & {
    assessmentId: string;
    providerEnvironment: string;
  };

export type DataCreditoAssessmentCreditClassification =
  | { status: "CONSUMED"; creditId: number }
  | { status: "EXPIRED" }
  | { status: "IN_PROGRESS" }
  | { status: "INVALID" };

function assessmentMatchParams(input: DataCreditoAssessmentMatchInput) {
  return {
    ...buildDataCreditoIdentityHashes(input),
    ...input,
  };
}

export async function classifyDataCreditoAssessmentForCredit(
  input: DataCreditoAssessmentMatchInput
): Promise<DataCreditoAssessmentCreditClassification> {
  if (!isUuid(input.assessmentId)) return { status: "INVALID" };

  await ensureDataCreditoSchema();
  const match = assessmentMatchParams(input);
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      claimExpiresAt: Date | null;
      claimTokenHash: string | null;
      consumedAt: Date | null;
      creditId: number | null;
      expiresAt: Date | null;
      providerEnvironment: string;
      status: string;
    }>
  >(
    `
      SELECT
        "status",
        "expiresAt",
        "claimTokenHash",
        "claimExpiresAt",
        "consumedAt",
        "creditId",
        "providerEnvironment"
      FROM "DataCreditoAssessment"
      WHERE "id" = $1
        AND "documentHash" = $2
        AND "surnameHash" = $3
        AND "platform" = $4
        AND "userId" = $5
        AND "sellerId" IS NOT DISTINCT FROM $6
        AND "sedeId" = $7
        AND "aliadoId" IS NOT DISTINCT FROM $8
      LIMIT 1
    `,
    match.assessmentId,
    match.documentHash,
    match.surnameHash,
    match.platform,
    match.userId,
    match.sellerId,
    match.sedeId,
    match.aliadoId
  );
  const row = rows[0];

  if (!row) return { status: "INVALID" };

  const creditId = Number(row.creditId);
  if (row.consumedAt && Number.isInteger(creditId) && creditId > 0) {
    return { status: "CONSUMED", creditId };
  }

  if (row.providerEnvironment !== match.providerEnvironment) {
    return { status: "INVALID" };
  }

  if (row.status !== "APROBADO") return { status: "INVALID" };

  const now = Date.now();
  const claimExpiresAt = row.claimExpiresAt
    ? new Date(row.claimExpiresAt).getTime()
    : Number.NaN;
  if (row.claimTokenHash && Number.isFinite(claimExpiresAt) && claimExpiresAt > now) {
    return { status: "IN_PROGRESS" };
  }

  const expiresAt = row.expiresAt ? new Date(row.expiresAt).getTime() : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return { status: "EXPIRED" };
  }

  return { status: "INVALID" };
}

export async function getApprovedDataCreditoAssessmentForCredit(
  input: DataCreditoAssessmentMatchInput
) {
  if (!isUuid(input.assessmentId)) return null;
  await ensureDataCreditoSchema();
  const match = assessmentMatchParams(input);
  const rows = await prisma.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      SELECT *
      FROM "DataCreditoAssessment"
      WHERE "id" = $1
        AND "documentHash" = $2
        AND "surnameHash" = $3
        AND "platform" = $4
        AND "providerEnvironment" = $5
        AND "userId" = $6
        AND "sellerId" IS NOT DISTINCT FROM $7
        AND "sedeId" = $8
        AND "aliadoId" IS NOT DISTINCT FROM $9
        AND "status" = 'APROBADO'
        AND "score" BETWEEN -1 AND 950
        AND "offer" IS NOT NULL
        AND "expiresAt" > CURRENT_TIMESTAMP
        AND "consumedAt" IS NULL
      LIMIT 1
    `,
    match.assessmentId,
    match.documentHash,
    match.surnameHash,
    match.platform,
    match.providerEnvironment,
    match.userId,
    match.sellerId,
    match.sedeId,
    match.aliadoId
  );
  return rows[0] || null;
}

export async function claimDataCreditoAssessment(input: DataCreditoAssessmentMatchInput) {
  if (!isUuid(input.assessmentId)) return null;
  await ensureDataCreditoSchema();
  const match = assessmentMatchParams(input);
  const claimToken = randomBytes(32).toString("base64url");
  const claimTokenHash = hmacDataCreditoValue("claim", claimToken);

  return prisma.$transaction(async (transaction) => {
    const roots = await transaction.$queryRawUnsafe<Array<{ rootId: string }>>(
      `
        SELECT COALESCE("reusedFromAssessmentId", "id") AS "rootId"
        FROM "DataCreditoAssessment"
        WHERE "id" = $1
          AND "documentHash" = $2 AND "surnameHash" = $3
          AND "platform" = $4 AND "providerEnvironment" = $5
          AND "userId" = $6 AND "sellerId" IS NOT DISTINCT FROM $7
          AND "sedeId" = $8 AND "aliadoId" IS NOT DISTINCT FROM $9
        LIMIT 1
      `,
      match.assessmentId,
      match.documentHash,
      match.surnameHash,
      match.platform,
      match.providerEnvironment,
      match.userId,
      match.sellerId,
      match.sedeId,
      match.aliadoId
    );
    const rootId = roots[0]?.rootId;
    if (!rootId) return null;
    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
      `datacredito-assessment-group:${rootId}`
    );
    const rows = await transaction.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
      `
        UPDATE "DataCreditoAssessment" target
        SET "claimedAt" = CURRENT_TIMESTAMP,
            "claimTokenHash" = $10,
            "claimExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE target."id" = $1
          AND target."documentHash" = $2 AND target."surnameHash" = $3
          AND target."platform" = $4 AND target."providerEnvironment" = $5
          AND target."userId" = $6 AND target."sellerId" IS NOT DISTINCT FROM $7
          AND target."sedeId" = $8 AND target."aliadoId" IS NOT DISTINCT FROM $9
          AND target."status" = 'APROBADO'
          AND target."score" BETWEEN -1 AND 950
          AND target."offer" IS NOT NULL
          AND target."expiresAt" > CURRENT_TIMESTAMP
          AND target."consumedAt" IS NULL
          AND (target."claimTokenHash" IS NULL OR target."claimExpiresAt" <= CURRENT_TIMESTAMP)
          AND NOT EXISTS (
            SELECT 1 FROM "DataCreditoAssessment" consumed
            WHERE COALESCE(consumed."reusedFromAssessmentId", consumed."id") = $11
              AND consumed."consumedAt" IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM "DataCreditoAssessment" claimed
            WHERE COALESCE(claimed."reusedFromAssessmentId", claimed."id") = $11
              AND claimed."claimTokenHash" IS NOT NULL
              AND claimed."claimExpiresAt" > CURRENT_TIMESTAMP
          )
        RETURNING target.*
      `,
      match.assessmentId,
      match.documentHash,
      match.surnameHash,
      match.platform,
      match.providerEnvironment,
      match.userId,
      match.sellerId,
      match.sedeId,
      match.aliadoId,
      claimTokenHash,
      rootId
    );
    return rows[0] ? { assessment: rows[0], claimToken } : null;
  });
}

async function consumeDataCreditoAssessmentInTransaction(
  input: { assessmentId: string; claimToken: string; creditId: number },
  database: Prisma.TransactionClient
) {
  const claimTokenHash = hmacDataCreditoValue("claim", input.claimToken);
  const roots = await database.$queryRawUnsafe<Array<{ rootId: string }>>(
    `
      SELECT COALESCE("reusedFromAssessmentId", "id") AS "rootId"
      FROM "DataCreditoAssessment"
      WHERE "id" = $1 AND "claimTokenHash" = $2
        AND "claimExpiresAt" > CURRENT_TIMESTAMP
      LIMIT 1
    `,
    input.assessmentId,
    claimTokenHash
  );
  const rootId = roots[0]?.rootId;
  if (!rootId) return null;
  await database.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
    `datacredito-assessment-group:${rootId}`
  );
  const claimedRows = await database.$queryRawUnsafe<Array<{ id: string }>>(
    `
      SELECT "id" FROM "DataCreditoAssessment"
      WHERE "id" = $1 AND "claimTokenHash" = $2
        AND "claimExpiresAt" > CURRENT_TIMESTAMP
        AND "status" = 'APROBADO' AND "expiresAt" > CURRENT_TIMESTAMP
        AND "consumedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "DataCreditoAssessment" consumed
          WHERE COALESCE(consumed."reusedFromAssessmentId", consumed."id") = $3
            AND consumed."consumedAt" IS NOT NULL
        )
      FOR UPDATE
    `,
    input.assessmentId,
    claimTokenHash,
    rootId
  );
  if (!claimedRows[0]) return null;
  const consumedRows = await database.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      UPDATE "DataCreditoAssessment"
      SET "consumedAt" = CURRENT_TIMESTAMP, "creditId" = $2,
          "claimTokenHash" = NULL, "claimExpiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE ("id" = $1 OR "reusedFromAssessmentId" = $1)
        AND "consumedAt" IS NULL
      RETURNING *
    `,
    rootId,
    input.creditId
  );
  return consumedRows.find((row) => row.id === input.assessmentId) || null;
}

export async function consumeDataCreditoAssessment(
  input: {
    assessmentId: string;
    claimToken: string;
    creditId: number;
  },
  database: Prisma.TransactionClient | typeof prisma = prisma
) {
  if (
    !isUuid(input.assessmentId) ||
    !String(input.claimToken || "") ||
    !Number.isInteger(input.creditId) ||
    input.creditId <= 0
  ) {
    return null;
  }
  await ensureDataCreditoSchema();
  if (database === prisma) {
    return prisma.$transaction((transaction) =>
      consumeDataCreditoAssessmentInTransaction(input, transaction)
    );
  }
  return consumeDataCreditoAssessmentInTransaction(
    input,
    database as Prisma.TransactionClient
  );
}

export async function releaseDataCreditoAssessment(input: {
  assessmentId: string;
  claimToken: string;
}) {
  if (!isUuid(input.assessmentId) || !String(input.claimToken || "")) return null;
  await ensureDataCreditoSchema();
  const claimTokenHash = hmacDataCreditoValue("claim", input.claimToken);
  const rows = await prisma.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      UPDATE "DataCreditoAssessment"
      SET "claimedAt" = NULL,
          "claimTokenHash" = NULL,
          "claimExpiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
        AND "claimTokenHash" = $2
        AND "consumedAt" IS NULL
      RETURNING *
    `,
    input.assessmentId,
    claimTokenHash
  );
  return rows[0] || null;
}
