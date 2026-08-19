import "server-only";

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import {
  parseDataCreditoPolicyBands,
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

type DataCreditoQueryExecutor = Prisma.TransactionClient | typeof prisma;

type CreatePendingAssessmentInput = DataCreditoAssessmentScope & {
  platform: DataCreditoPlatform;
  providerEnvironment: string;
  documentHash: string;
  documentLast4: string;
  surnameHash: string;
  policyVersion: number;
  correlationId: string;
  consentAt: Date;
  ipHash: string | null;
  userAgentHash: string | null;
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
  return readBoundedInteger("DATACREDITO_ASSESSMENT_TTL_MINUTES", 120, 1, 1_440);
}

export function getDataCreditoRetentionDays() {
  const raw = String(process.env.DATACREDITO_RETENTION_DAYS || '').trim();
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 730) {
      throw new DataCreditoStorageConfigurationError(
        'DATACREDITO_RETENTION_DAYS debe ser un entero entre 1 y 730'
      );
    }
  }

  return readBoundedInteger("DATACREDITO_RETENTION_DAYS", 90, 1, 730);
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

async function setupDataCreditoSchema() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "DataCreditoPolicy" (
      "version" INTEGER PRIMARY KEY,
      "policy" JSONB NOT NULL,
      "createdByUserId" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "DataCreditoAssessment" (
      "id" UUID PRIMARY KEY,
      "documentHash" CHAR(64) NOT NULL,
      "documentLast4" VARCHAR(4) NOT NULL,
      "surnameHash" CHAR(64) NOT NULL,
      "platform" VARCHAR(16) NOT NULL,
      "providerEnvironment" VARCHAR(32) NOT NULL DEFAULT 'legacy',
      "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
      "score" INTEGER,
      "decision" VARCHAR(16),
      "offer" JSONB,
      "policyVersion" INTEGER NOT NULL,
      "consentVersion" VARCHAR(16) NOT NULL,
      "consentHash" CHAR(64) NOT NULL,
      "consentAt" TIMESTAMP(3) NOT NULL,
      "userId" INTEGER NOT NULL,
      "sellerId" INTEGER,
      "sedeId" INTEGER NOT NULL,
      "aliadoId" INTEGER,
      "ipHash" CHAR(64),
      "userAgentHash" CHAR(64),
      "correlationId" UUID NOT NULL,
      "transactionCode" VARCHAR(32),
      "providerStatus" VARCHAR(64),
      "errorCode" VARCHAR(64),
      "durationMs" INTEGER,
      "expiresAt" TIMESTAMP(3) NOT NULL,
      "claimedAt" TIMESTAMP(3),
      "claimTokenHash" CHAR(64),
      "claimExpiresAt" TIMESTAMP(3),
      "consumedAt" TIMESTAMP(3),
      "creditId" INTEGER,
      "retainedUntil" TIMESTAMP(3) NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "DataCreditoAssessment"
      ADD COLUMN IF NOT EXISTS "documentHash" CHAR(64),
      ADD COLUMN IF NOT EXISTS "documentLast4" VARCHAR(4),
      ADD COLUMN IF NOT EXISTS "surnameHash" CHAR(64),
      ADD COLUMN IF NOT EXISTS "platform" VARCHAR(16),
      ADD COLUMN IF NOT EXISTS "providerEnvironment" VARCHAR(32) DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS "status" VARCHAR(24) DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS "score" INTEGER,
      ADD COLUMN IF NOT EXISTS "decision" VARCHAR(16),
      ADD COLUMN IF NOT EXISTS "offer" JSONB,
      ADD COLUMN IF NOT EXISTS "policyVersion" INTEGER,
      ADD COLUMN IF NOT EXISTS "consentVersion" VARCHAR(16),
      ADD COLUMN IF NOT EXISTS "consentHash" CHAR(64),
      ADD COLUMN IF NOT EXISTS "consentAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "userId" INTEGER,
      ADD COLUMN IF NOT EXISTS "sellerId" INTEGER,
      ADD COLUMN IF NOT EXISTS "sedeId" INTEGER,
      ADD COLUMN IF NOT EXISTS "aliadoId" INTEGER,
      ADD COLUMN IF NOT EXISTS "ipHash" CHAR(64),
      ADD COLUMN IF NOT EXISTS "userAgentHash" CHAR(64),
      ADD COLUMN IF NOT EXISTS "correlationId" UUID,
      ADD COLUMN IF NOT EXISTS "transactionCode" VARCHAR(32),
      ADD COLUMN IF NOT EXISTS "providerStatus" VARCHAR(64),
      ADD COLUMN IF NOT EXISTS "errorCode" VARCHAR(64),
      ADD COLUMN IF NOT EXISTS "durationMs" INTEGER,
      ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "claimTokenHash" CHAR(64),
      ADD COLUMN IF NOT EXISTS "claimExpiresAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "creditId" INTEGER,
      ADD COLUMN IF NOT EXISTS "retainedUntil" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP
  `);

  await prisma.$executeRawUnsafe(`
    UPDATE "DataCreditoAssessment"
    SET
      "providerEnvironment" = COALESCE("providerEnvironment", 'legacy'),
      "status" = COALESCE("status", 'NO_EVALUADO'),
      "expiresAt" = COALESCE("expiresAt", CURRENT_TIMESTAMP),
      "retainedUntil" = COALESCE("retainedUntil", CURRENT_TIMESTAMP),
      "createdAt" = COALESCE("createdAt", CURRENT_TIMESTAMP),
      "updatedAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP)
    WHERE
      "providerEnvironment" IS NULL
      OR "status" IS NULL
      OR "expiresAt" IS NULL
      OR "retainedUntil" IS NULL
      OR "createdAt" IS NULL
      OR "updatedAt" IS NULL
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "DataCreditoAssessment"
      ALTER COLUMN "documentHash" SET NOT NULL,
      ALTER COLUMN "documentLast4" SET NOT NULL,
      ALTER COLUMN "surnameHash" SET NOT NULL,
      ALTER COLUMN "platform" SET NOT NULL,
      ALTER COLUMN "providerEnvironment" SET DEFAULT 'legacy',
      ALTER COLUMN "providerEnvironment" SET NOT NULL,
      ALTER COLUMN "status" SET NOT NULL,
      ALTER COLUMN "policyVersion" SET NOT NULL,
      ALTER COLUMN "consentVersion" SET NOT NULL,
      ALTER COLUMN "consentHash" SET NOT NULL,
      ALTER COLUMN "consentAt" SET NOT NULL,
      ALTER COLUMN "userId" SET NOT NULL,
      ALTER COLUMN "sedeId" SET NOT NULL,
      ALTER COLUMN "correlationId" SET NOT NULL,
      ALTER COLUMN "expiresAt" SET NOT NULL,
      ALTER COLUMN "retainedUntil" SET NOT NULL,
      ALTER COLUMN "createdAt" SET NOT NULL,
      ALTER COLUMN "updatedAt" SET NOT NULL
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "DataCreditoAssessmentSecurePayload" (
      "assessmentId" UUID PRIMARY KEY,
      "algorithm" VARCHAR(32) NOT NULL,
      "keyId" VARCHAR(32) NOT NULL,
      "aadVersion" INTEGER NOT NULL,
      "plaintextVersion" INTEGER NOT NULL,
      "nonce" BYTEA NOT NULL,
      "authTag" BYTEA NOT NULL,
      "ciphertext" BYTEA NOT NULL,
      "plaintextBytes" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "DataCreditoSecurePayload_assessment_fkey"
        FOREIGN KEY ("assessmentId")
        REFERENCES "DataCreditoAssessment" ("id")
        ON DELETE CASCADE,
      CONSTRAINT "DataCreditoSecurePayload_algorithm_check"
        CHECK ("algorithm" = 'AES-256-GCM'),
      CONSTRAINT "DataCreditoSecurePayload_key_id_check"
        CHECK ("keyId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
      CONSTRAINT "DataCreditoSecurePayload_aad_version_check"
        CHECK ("aadVersion" > 0),
      CONSTRAINT "DataCreditoSecurePayload_plaintext_version_check"
        CHECK ("plaintextVersion" > 0),
      CONSTRAINT "DataCreditoSecurePayload_nonce_check"
        CHECK (octet_length("nonce") = 12),
      CONSTRAINT "DataCreditoSecurePayload_auth_tag_check"
        CHECK (octet_length("authTag") = 16),
      CONSTRAINT "DataCreditoSecurePayload_plaintext_size_check"
        CHECK ("plaintextBytes" BETWEEN 1 AND 6291456),
      CONSTRAINT "DataCreditoSecurePayload_ciphertext_size_check"
        CHECK (octet_length("ciphertext") = "plaintextBytes")
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "DataCreditoAdminAccessAudit" (
      "id" UUID PRIMARY KEY,
      "assessmentId" UUID NOT NULL,
      "actorUserId" INTEGER NOT NULL,
      "action" VARCHAR(32) NOT NULL,
      "outcome" VARCHAR(32) NOT NULL,
      "requestCorrelationId" UUID NOT NULL,
      "ipHash" CHAR(64),
      "userAgentHash" CHAR(64),
      "retainedUntil" TIMESTAMP(3) NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "DataCreditoAdminAudit_assessment_fkey"
        FOREIGN KEY ("assessmentId")
        REFERENCES "DataCreditoAssessment" ("id")
        ON DELETE CASCADE,
      CONSTRAINT "DataCreditoAdminAudit_action_check"
        CHECK ("action" ~ '^[A-Z][A-Z0-9_]{0,31}$'),
      CONSTRAINT "DataCreditoAdminAudit_outcome_check"
        CHECK ("outcome" ~ '^[A-Z][A-Z0-9_]{0,31}$')
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoAssessment_correlation_key"
      ON "DataCreditoAssessment" ("correlationId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoAssessment_pending_key"
      ON "DataCreditoAssessment" (
        "documentHash", "surnameHash", "platform", "policyVersion", "userId",
        COALESCE("sellerId", 0), "sedeId", COALESCE("aliadoId", 0)
      )
      WHERE "status" = 'PENDING'
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoAssessment_pending_document_key"
      ON "DataCreditoAssessment" (
        "documentHash", "platform", "sedeId", COALESCE("aliadoId", 0)
      )
      WHERE "status" = 'PENDING'
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_reuse_idx"
      ON "DataCreditoAssessment" (
        "documentHash", "surnameHash", "platform", "policyVersion", "sedeId",
        "expiresAt" DESC
      )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_reuse_environment_idx"
      ON "DataCreditoAssessment" (
        "documentHash", "surnameHash", "platform", "providerEnvironment",
        "policyVersion", "sedeId", "expiresAt" DESC
      )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_rate_idx"
      ON "DataCreditoAssessment" ("userId", "sellerId", "sedeId", "createdAt" DESC)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_retention_idx"
      ON "DataCreditoAssessment" ("retainedUntil")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_admin_created_idx"
      ON "DataCreditoAssessment" ("createdAt" DESC, "id" DESC)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_admin_document_idx"
      ON "DataCreditoAssessment" ("documentHash", "createdAt" DESC, "id" DESC)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_admin_status_idx"
      ON "DataCreditoAssessment" ("status", "createdAt" DESC, "id" DESC)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoSecurePayload_key_nonce_key"
      ON "DataCreditoAssessmentSecurePayload" ("keyId", "nonce")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DataCreditoAdminAudit_retention_idx"
      ON "DataCreditoAdminAccessAudit" ("retainedUntil")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DataCreditoAdminAudit_assessment_created_idx"
      ON "DataCreditoAdminAccessAudit" ("assessmentId", "createdAt" DESC)
  `);
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

async function verifyDataCreditoSchema() {
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
        { column: "policyVersion" },
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
        { column: "platform" },
        { column: "sedeId" },
        { expression: 'COALESCE("aliadoId", 0)' },
      ],
      predicate: "PENDING_STATUS",
      unique: true,
    }) ||
    !matchesDataCreditoSchemaIndex(reuseEnvironmentIndex, {
      keys: [
        { column: "documentHash" },
        { column: "surnameHash" },
        { column: "platform" },
        { column: "providerEnvironment" },
        { column: "policyVersion" },
        { column: "sedeId" },
        { column: "expiresAt" },
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

export async function getCurrentDataCreditoPolicy() {
  await ensureDataCreditoSchema();
  const rows = await prisma.$queryRawUnsafe<DataCreditoPolicyRow[]>(`
    SELECT "version", "policy", "createdByUserId", "createdAt"
    FROM "DataCreditoPolicy"
    ORDER BY "version" DESC
    LIMIT 1
  `);
  return policyFromRow(rows[0] || null);
}

export async function createDataCreditoPolicyVersion(input: {
  bands: DataCreditoPolicyBand[];
  createdByUserId: number;
  expectedVersion?: number | null;
}) {
  await ensureDataCreditoSchema();
  const bands = parseDataCreditoPolicyBands(input.bands);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`LOCK TABLE "DataCreditoPolicy" IN EXCLUSIVE MODE`);
    const currentRows = await tx.$queryRawUnsafe<Array<{ version: number }>>(`
      SELECT "version"
      FROM "DataCreditoPolicy"
      ORDER BY "version" DESC
      LIMIT 1
    `);
    const currentVersion = currentRows[0]?.version ?? null;

    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== currentVersion
    ) {
      throw new DataCreditoPolicyConflictError(currentVersion);
    }

    const nextVersion = (currentVersion || 0) + 1;
    const rows = await tx.$queryRawUnsafe<DataCreditoPolicyRow[]>(
      `
        INSERT INTO "DataCreditoPolicy" (
          "version", "policy", "createdByUserId"
        )
        VALUES ($1, $2::jsonb, $3)
        RETURNING "version", "policy", "createdByUserId", "createdAt"
      `,
      nextVersion,
      JSON.stringify({ bands }),
      input.createdByUserId
    );

    return policyFromRow(rows[0] || null);
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
    policyVersion: number;
    scope: DataCreditoAssessmentScope;
  },
  database: DataCreditoQueryExecutor
) {
  const rows = await database.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      SELECT *
      FROM "DataCreditoAssessment"
      WHERE "documentHash" = $1
        AND "surnameHash" = $2
        AND "platform" = $3
        AND "providerEnvironment" = $4
        AND "policyVersion" = $5
        AND "userId" = $6
        AND "sellerId" IS NOT DISTINCT FROM $7
        AND "sedeId" = $8
        AND "aliadoId" IS NOT DISTINCT FROM $9
        AND "status" IN ('APROBADO', 'RECHAZADO')
        AND "expiresAt" > CURRENT_TIMESTAMP
        AND "consumedAt" IS NULL
        AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" <= CURRENT_TIMESTAMP)
      ORDER BY "createdAt" DESC
      LIMIT 1
    `,
    input.hashes.documentHash,
    input.hashes.surnameHash,
    input.platform,
    input.providerEnvironment,
    input.policyVersion,
    input.scope.userId,
    input.scope.sellerId,
    input.scope.sedeId,
    input.scope.aliadoId
  );
  return rows[0] || null;
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
        "providerEnvironment", "status", "policyVersion", "consentVersion",
        "consentHash", "consentAt",
        "userId", "sellerId", "sedeId", "aliadoId", "ipHash", "userAgentHash",
        "correlationId", "expiresAt", "retainedUntil"
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17,
        CURRENT_TIMESTAMP + ($18::integer * INTERVAL '1 minute'),
        CURRENT_TIMESTAMP + ($19::integer * INTERVAL '1 day')
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
  const documentLockKey = [
    "datacredito-document",
    input.aliadoId || 0,
    input.sedeId,
    input.documentHash,
  ].join(":");
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
            AND "platform" = $2
            AND "sedeId" = $3
            AND "aliadoId" IS NOT DISTINCT FROM $4
            AND "createdAt" < CURRENT_TIMESTAMP - ($5::integer * INTERVAL '1 minute')
        `,
        input.documentHash,
        input.platform,
        input.sedeId,
        input.aliadoId,
        staleMinutes
      );

      const reusable = await findReusableDataCreditoAssessment(
        {
          hashes: {
            documentHash: input.documentHash,
            documentLast4: input.documentLast4,
            surnameHash: input.surnameHash,
          },
          platform: input.platform,
          providerEnvironment: input.providerEnvironment,
          policyVersion: input.policyVersion,
          scope: input,
        },
        transaction
      );
      if (reusable) {
        return { kind: "REUSED", assessment: reusable };
      }

      const activeRows = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
        `
          SELECT "id"
          FROM "DataCreditoAssessment"
          WHERE "status" = 'PENDING'
            AND "documentHash" = $1
            AND "platform" = $2
            AND "sedeId" = $3
            AND "aliadoId" IS NOT DISTINCT FROM $4
          LIMIT 1
        `,
        input.documentHash,
        input.platform,
        input.sedeId,
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
  const rows = await prisma.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      UPDATE "DataCreditoAssessment"
      SET "claimedAt" = CURRENT_TIMESTAMP,
          "claimTokenHash" = $10,
          "claimExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
          "updatedAt" = CURRENT_TIMESTAMP
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
        AND ("claimTokenHash" IS NULL OR "claimExpiresAt" <= CURRENT_TIMESTAMP)
      RETURNING *
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
    claimTokenHash
  );

  return rows[0] ? { assessment: rows[0], claimToken } : null;
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
  const claimTokenHash = hmacDataCreditoValue("claim", input.claimToken);
  const rows = await database.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
    `
      UPDATE "DataCreditoAssessment"
      SET "consumedAt" = CURRENT_TIMESTAMP,
          "creditId" = $3,
          "claimTokenHash" = NULL,
          "claimExpiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
        AND "claimTokenHash" = $2
        AND "claimExpiresAt" > CURRENT_TIMESTAMP
        AND "status" = 'APROBADO'
        AND "expiresAt" > CURRENT_TIMESTAMP
        AND "consumedAt" IS NULL
      RETURNING *
    `,
    input.assessmentId,
    claimTokenHash,
    input.creditId
  );
  return rows[0] || null;
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
