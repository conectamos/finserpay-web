import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import {
  IPHONE_ENROLLMENT_CHECKLIST_VERSION,
  createIphoneEnrollmentGrantSecret,
  getIphoneEnrollmentIdentityKeyVersion,
  hashIphoneEnrollmentGrantFingerprint,
  hashIphoneEnrollmentGrantToken,
  hashIphoneEnrollmentChecklist,
  hashIphoneEnrollmentDocument,
  hashIphoneEnrollmentImei,
  hashIphoneEnrollmentRateLimitKey,
  hashIphoneEnrollmentSessionId,
  hashIphoneEnrollmentSharedReviewFingerprint,
  IPHONE_ENROLLMENT_SHARED_ANALYST,
  isIphoneEnrollmentCaseTokenForSession,
  isSharedIphoneEnrollmentPortalSession,
  issueIphoneEnrollmentPortalSession,
  normalizeIphoneEnrollmentGrantSecret,
  type IphoneEnrollmentCaseTokenPayload,
  type IphoneEnrollmentChecklist,
  type IphoneEnrollmentPortalSessionPayload,
} from "@/lib/iphone-enrollment";
import prisma from "@/lib/prisma";
import { hmacDataCreditoValue } from "@/lib/datacredito/storage";
import {
  ensureFirmaSeguroSchema,
  FIRMASEGURO_DRAFT_LOCK_NAMESPACE,
} from "@/lib/firmaseguro-storage";
import {
  ensureSolicitudSchema,
  expireStaleSolicitudes,
} from "@/lib/solicitudes-storage";
import { compareStrictIdentityDocuments } from "@/lib/veriff-identity";
import {
  ensureVeriffSchema,
  serializeVeriffValidation,
  type VeriffValidationRow,
} from "@/lib/veriff-storage";

type Database = typeof prisma | Prisma.TransactionClient;

type EnrollmentCaseRow = {
  solicitudId: number;
  currentStep: number;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  aliadoId: number | null;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  imei: string | null;
  equipoMarca: string | null;
  equipoModelo: string | null;
  sedeNombre: string | null;
  aliadoNombre: string | null;
  reviewId: string | null;
  analystName: string | null;
  approvedAt: Date | string | null;
  checklistVersion: string | null;
  dataCreditoDocumentHash: string;
};

type ReviewRow = {
  id: string;
  solicitudId: number;
  decision: "APROBADO";
  checklistVersion: string;
  checklist: unknown;
  documentHash: string;
  imeiHash: string;
  checklistHash: string;
  analystName: string;
  analystExternalId: string;
  identityKeyVersion: string;
  grantId: string | null;
  grantIssuedByUserId: number | null;
  grantIssuedByName: string | null;
  accessFingerprint: string;
  correlationId: string;
  approvedAt: Date | string;
  createdAt: Date | string;
};

type ReviewWithDraftScopeRow = ReviewRow & {
  draftUsuarioId: number;
  draftVendedorId: number | null;
  draftSedeId: number;
  draftAliadoId: number | null;
};

type GrantRow = {
  id: string;
  tokenHash: string;
  analystName: string;
  analystExternalId: string;
  issuedByUserId: number;
  issuedByName: string;
  expiresAt: Date | string;
  consumedAt: Date | string | null;
  sessionIdHash: string | null;
  sessionExpiresAt: Date | string | null;
  revokedAt: Date | string | null;
  revokedByUserId: number | null;
  revokedByName: string | null;
  createdAt: Date | string;
};

export type IphoneEnrollmentGrantSession = {
  accessMode: "GRANT" | "SHARED";
  accessFingerprint: string;
  grantId: string;
  analyst: { name: string; externalId: string };
  issuedBy: { userId: number; name: string } | null;
  expiresAt: Date;
  sessionIdHash: string;
  session: IphoneEnrollmentPortalSessionPayload;
};

export class IphoneEnrollmentGrantError extends Error {
  readonly code:
    | "GRANT_NOT_AVAILABLE"
    | "GRANT_ALREADY_USED"
    | "GRANT_NOT_ACTIVE"
    | "GRANT_RATE_LIMITED";
  readonly retryAfterSeconds: number | null;

  constructor(
    code: IphoneEnrollmentGrantError["code"],
    message: string,
    retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "IphoneEnrollmentGrantError";
  }
}

export type IphoneEnrollmentReview = ReturnType<typeof serializeReview>;

export type IphoneEnrollmentCase = {
  solicitudId: number;
  solicitudNumero: string;
  currentStep: number;
  clienteNombre: string;
  documentoMasked: string;
  imeiMasked: string;
  equipo: string;
  sede: string;
  aliado: string;
  documentHash: string;
  imeiHash: string;
  review: IphoneEnrollmentReview | null;
};

export type IphoneEnrollmentLookupResult =
  | { kind: "FOUND"; item: IphoneEnrollmentCase }
  | { kind: "NOT_READY" }
  | { kind: "FINALIZED" }
  | { kind: "NOT_FOUND" }
  | { kind: "AMBIGUOUS" };

export class IphoneEnrollmentApprovalError extends Error {
  readonly code:
    | "CASE_NOT_AVAILABLE"
    | "CASE_IDENTITY_CHANGED"
    | "CASE_ALREADY_APPROVED_DIFFERENTLY"
    | "CASE_REVIEW_INCONSISTENT";

  constructor(code: IphoneEnrollmentApprovalError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "IphoneEnrollmentApprovalError";
  }
}

let schemaPromise: Promise<void> | null = null;
let attemptCleanupDueAt = 0;

function reserveIphoneEnrollmentAttemptCleanup(now = Date.now()) {
  if (now < attemptCleanupDueAt) return false;
  attemptCleanupDueAt = now + 60 * 60 * 1000;
  return true;
}

const reviewColumns = [
  "id",
  "solicitudId",
  "decision",
  "checklistVersion",
  "checklist",
  "documentHash",
  "imeiHash",
  "checklistHash",
  "analystName",
  "analystExternalId",
  "identityKeyVersion",
  "grantId",
  "grantIssuedByUserId",
  "grantIssuedByName",
  "accessFingerprint",
  "correlationId",
  "approvedAt",
  "createdAt",
] as const;

const grantColumns = [
  "id",
  "tokenHash",
  "analystName",
  "analystExternalId",
  "issuedByUserId",
  "issuedByName",
  "expiresAt",
  "consumedAt",
  "sessionIdHash",
  "sessionExpiresAt",
  "revokedAt",
  "revokedByUserId",
  "revokedByName",
  "createdAt",
] as const;

async function assertIphoneEnrollmentSchema() {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ tableName: string; columnName: string }>
  >(`
    SELECT table_name AS "tableName", column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'IphoneEnrollmentReview',
        'IphoneEnrollmentAccessGrant',
        'IphoneEnrollmentPortalAttempt'
      )
  `);
  const columns = new Map<string, Set<string>>();
  for (const row of rows) {
    const tableColumns = columns.get(row.tableName) || new Set<string>();
    tableColumns.add(row.columnName);
    columns.set(row.tableName, tableColumns);
  }
  const review = columns.get("IphoneEnrollmentReview");
  const grants = columns.get("IphoneEnrollmentAccessGrant");
  const attempts = columns.get("IphoneEnrollmentPortalAttempt");
  if (
    !review ||
    reviewColumns.some((column) => !review.has(column)) ||
    !grants ||
    grantColumns.some((column) => !grants.has(column)) ||
    !attempts ||
    ["id", "clientHash", "action", "createdAt"].some(
      (column) => !attempts.has(column)
    )
  ) {
    throw new Error("IPHONE_ENROLLMENT_SCHEMA_NOT_READY");
  }
}

export async function ensureIphoneEnrollmentSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureSolicitudSchema();
      if (process.env.NODE_ENV === "production") {
        await assertIphoneEnrollmentSchema();
        return;
      }
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "IphoneEnrollmentAccessGrant" (
          "id" UUID NOT NULL,
          "tokenHash" CHAR(64) NOT NULL,
          "analystName" TEXT NOT NULL,
          "analystExternalId" TEXT NOT NULL,
          "issuedByUserId" INTEGER NOT NULL,
          "issuedByName" TEXT NOT NULL,
          "expiresAt" TIMESTAMPTZ NOT NULL,
          "consumedAt" TIMESTAMPTZ,
          "sessionIdHash" CHAR(64),
          "sessionExpiresAt" TIMESTAMPTZ,
          "revokedAt" TIMESTAMPTZ,
          "revokedByUserId" INTEGER,
          "revokedByName" TEXT,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "IphoneEnrollmentAccessGrant_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "IphoneEnrollmentAccessGrant_tokenHash_key"
            UNIQUE ("tokenHash"),
          CONSTRAINT "IphoneEnrollmentAccessGrant_issuedBy_fkey"
            FOREIGN KEY ("issuedByUserId")
            REFERENCES "Usuario"("id") ON DELETE RESTRICT,
          CONSTRAINT "IphoneEnrollmentAccessGrant_revokedBy_fkey"
            FOREIGN KEY ("revokedByUserId")
            REFERENCES "Usuario"("id") ON DELETE SET NULL,
          CONSTRAINT "IphoneEnrollmentAccessGrant_expiry_check"
            CHECK (
              "expiresAt" > "createdAt"
              AND "expiresAt" <= "createdAt" + INTERVAL '8 hours'
            ),
          CONSTRAINT "IphoneEnrollmentAccessGrant_session_check"
            CHECK (
              ("consumedAt" IS NULL AND "sessionIdHash" IS NULL AND "sessionExpiresAt" IS NULL)
              OR
              ("consumedAt" IS NOT NULL AND "sessionIdHash" IS NOT NULL AND "sessionExpiresAt" IS NOT NULL)
            )
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "IphoneEnrollmentReview" (
          "id" UUID NOT NULL,
          "solicitudId" INTEGER NOT NULL,
          "decision" TEXT NOT NULL,
          "checklistVersion" TEXT NOT NULL,
          "checklist" JSONB NOT NULL,
          "documentHash" CHAR(64) NOT NULL,
          "imeiHash" CHAR(64) NOT NULL,
          "checklistHash" CHAR(64) NOT NULL,
          "analystName" TEXT NOT NULL,
          "analystExternalId" TEXT NOT NULL,
          "identityKeyVersion" TEXT NOT NULL,
          "grantId" UUID,
          "grantIssuedByUserId" INTEGER,
          "grantIssuedByName" TEXT,
          "accessFingerprint" CHAR(64) NOT NULL,
          "correlationId" UUID NOT NULL,
          "approvedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "IphoneEnrollmentReview_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "IphoneEnrollmentReview_solicitudId_key"
            UNIQUE ("solicitudId"),
          CONSTRAINT "IphoneEnrollmentReview_correlationId_key"
            UNIQUE ("correlationId"),
          CONSTRAINT "IphoneEnrollmentReview_decision_check"
            CHECK ("decision" = 'APROBADO'),
          CONSTRAINT "IphoneEnrollmentReview_solicitud_fkey"
            FOREIGN KEY ("solicitudId")
            REFERENCES "CreditoBorrador"("id") ON DELETE RESTRICT,
          CONSTRAINT "IphoneEnrollmentReview_grant_fkey"
            FOREIGN KEY ("grantId")
            REFERENCES "IphoneEnrollmentAccessGrant"("id") ON DELETE RESTRICT
        )
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "IphoneEnrollmentReview"
          ADD COLUMN IF NOT EXISTS "analystExternalId" TEXT,
          ADD COLUMN IF NOT EXISTS "identityKeyVersion" TEXT,
          ADD COLUMN IF NOT EXISTS "grantId" UUID,
          ADD COLUMN IF NOT EXISTS "grantIssuedByUserId" INTEGER,
          ADD COLUMN IF NOT EXISTS "grantIssuedByName" TEXT
      `);
      await prisma.$executeRawUnsafe(`
        UPDATE "IphoneEnrollmentReview"
        SET "analystExternalId" = COALESCE("analystExternalId", 'LEGACY'),
            "identityKeyVersion" = COALESCE("identityKeyVersion", 'legacy')
        WHERE "analystExternalId" IS NULL OR "identityKeyVersion" IS NULL
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "IphoneEnrollmentReview"
          ALTER COLUMN "analystExternalId" SET NOT NULL,
          ALTER COLUMN "identityKeyVersion" SET NOT NULL
      `);
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'IphoneEnrollmentReview_decision_check'
              AND conrelid = '"IphoneEnrollmentReview"'::regclass
          ) THEN
            ALTER TABLE "IphoneEnrollmentReview"
              ADD CONSTRAINT "IphoneEnrollmentReview_decision_check"
              CHECK ("decision" = 'APROBADO');
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'IphoneEnrollmentReview_solicitud_fkey'
              AND conrelid = '"IphoneEnrollmentReview"'::regclass
          ) THEN
            ALTER TABLE "IphoneEnrollmentReview"
              ADD CONSTRAINT "IphoneEnrollmentReview_solicitud_fkey"
              FOREIGN KEY ("solicitudId")
              REFERENCES "CreditoBorrador"("id")
              ON DELETE RESTRICT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'IphoneEnrollmentReview_grant_fkey'
              AND conrelid = '"IphoneEnrollmentReview"'::regclass
          ) THEN
            ALTER TABLE "IphoneEnrollmentReview"
              ADD CONSTRAINT "IphoneEnrollmentReview_grant_fkey"
              FOREIGN KEY ("grantId")
              REFERENCES "IphoneEnrollmentAccessGrant"("id")
              ON DELETE RESTRICT;
          END IF;
        END
        $$
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "IphoneEnrollmentAccessGrant_sessionIdHash_key"
        ON "IphoneEnrollmentAccessGrant" ("sessionIdHash")
        WHERE "sessionIdHash" IS NOT NULL
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "IphoneEnrollmentAccessGrant_active_idx"
        ON "IphoneEnrollmentAccessGrant" ("revokedAt", "expiresAt", "createdAt")
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "IphoneEnrollmentPortalAttempt" (
          "id" BIGSERIAL PRIMARY KEY,
          "clientHash" CHAR(64) NOT NULL,
          "action" TEXT NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "IphoneEnrollmentPortalAttempt_client_action_created_idx"
        ON "IphoneEnrollmentPortalAttempt" ("clientHash", "action", "createdAt")
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "IphoneEnrollmentPortalAttempt_created_idx"
        ON "IphoneEnrollmentPortalAttempt" ("createdAt")
      `);
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

function toIso(value: Date | string) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function serializeReview(row: ReviewRow) {
  return {
    id: row.id,
    solicitudId: row.solicitudId,
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
        ? {
            userId: row.grantIssuedByUserId,
            name: row.grantIssuedByName,
          }
        : null,
    correlationId: row.correlationId,
    approvedAt: toIso(row.approvedAt),
    createdAt: toIso(row.createdAt),
  };
}

function serializeGrant(row: GrantRow, now = new Date()) {
  const expiresAt = new Date(row.expiresAt);
  const sessionExpiresAt = row.sessionExpiresAt
    ? new Date(row.sessionExpiresAt)
    : null;
  const revoked = Boolean(row.revokedAt);
  const expired =
    expiresAt.getTime() <= now.getTime() ||
    Boolean(sessionExpiresAt && sessionExpiresAt.getTime() <= now.getTime());
  return {
    id: row.id,
    analyst: {
      name: row.analystName,
      externalId: row.analystExternalId,
    },
    issuedBy: {
      userId: row.issuedByUserId,
      name: row.issuedByName,
    },
    status: revoked
      ? ("REVOKED" as const)
      : expired
        ? ("EXPIRED" as const)
        : row.consumedAt
          ? ("ACTIVE" as const)
          : ("PENDING" as const),
    expiresAt: toIso(row.expiresAt),
    consumedAt: row.consumedAt ? toIso(row.consumedAt) : null,
    sessionExpiresAt: row.sessionExpiresAt
      ? toIso(row.sessionExpiresAt)
      : null,
    revokedAt: row.revokedAt ? toIso(row.revokedAt) : null,
    revokedBy:
      row.revokedAt && row.revokedByName
        ? {
            userId: row.revokedByUserId,
            name: row.revokedByName,
          }
        : null,
    createdAt: toIso(row.createdAt),
  };
}

const GRANT_SELECT = `
  "id"::text, "tokenHash", "analystName", "analystExternalId",
  "issuedByUserId", "issuedByName", "expiresAt", "consumedAt",
  "sessionIdHash", "sessionExpiresAt", "revokedAt",
  "revokedByUserId", "revokedByName", "createdAt"
`;

const REVIEW_SELECT = `
  "id"::text, "solicitudId", "decision", "checklistVersion",
  "checklist", "documentHash", "imeiHash", "checklistHash",
  "analystName", "analystExternalId", "identityKeyVersion",
  "grantId"::text, "grantIssuedByUserId", "grantIssuedByName",
  "accessFingerprint", "correlationId"::text, "approvedAt", "createdAt"
`;

function hasValidReviewChecklistIntegrity(row: ReviewRow) {
  if (
    row.checklistVersion !== IPHONE_ENROLLMENT_CHECKLIST_VERSION ||
    !row.checklist ||
    typeof row.checklist !== "object" ||
    Array.isArray(row.checklist)
  ) {
    return false;
  }
  const checklist = row.checklist as Record<string, unknown>;
  const expectedKeys = [
    "documentMatched",
    "enrollmentApproved",
    "imeiMatched",
  ];
  const actualKeys = Object.keys(checklist).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    checklist.documentMatched !== true ||
    checklist.imeiMatched !== true ||
    checklist.enrollmentApproved !== true
  ) {
    return false;
  }
  const expectedChecklist: IphoneEnrollmentChecklist = {
    documentMatched: true,
    imeiMatched: true,
    enrollmentApproved: true,
  };
  return (
    row.checklistHash.trim() ===
    hashIphoneEnrollmentChecklist(expectedChecklist)
  );
}

function hasValidReviewAccessProvenance(row: ReviewRow) {
  const accessFingerprint = row.accessFingerprint.trim();
  if (!/^[a-f0-9]{64}$/.test(accessFingerprint)) {
    return false;
  }
  if (row.grantId) {
    return Boolean(
      accessFingerprint === hashIphoneEnrollmentGrantFingerprint(row.grantId) &&
        row.grantIssuedByUserId &&
        row.grantIssuedByName?.trim()
    );
  }
  return (
    row.analystName === IPHONE_ENROLLMENT_SHARED_ANALYST.name &&
    row.analystExternalId === IPHONE_ENROLLMENT_SHARED_ANALYST.externalId &&
    row.grantIssuedByUserId === null &&
    row.grantIssuedByName === null &&
    accessFingerprint === hashIphoneEnrollmentSharedReviewFingerprint()
  );
}

function maskDocument(value: string) {
  return value.length <= 4 ? value : `${"•".repeat(value.length - 4)}${value.slice(-4)}`;
}

function maskImei(value: string) {
  return value.length <= 7
    ? value
    : `${value.slice(0, 3)}${"•".repeat(value.length - 7)}${value.slice(-4)}`;
}

function limitedClientName(value: string | null) {
  const parts = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (!parts.length) return "Cliente";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[1][0]}.`;
}

function equipmentLabel(row: EnrollmentCaseRow) {
  return [row.equipoMarca, row.equipoModelo]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ") || "iPhone";
}

async function hasAuthorizedVeriffApprovalForEnrollment(
  input: {
    solicitudId: number;
    usuarioId: number;
    vendedorId: number | null;
    sedeId: number;
    aliadoId: number | null;
    document: string;
  },
  database: Database = prisma,
  lock = false
) {
  const rows = await database.$queryRawUnsafe<VeriffValidationRow[]>(
    `
      SELECT validation.*
      FROM "VeriffIdentityValidation" validation
      WHERE validation."draftId" = $1
        AND validation."creditoId" IS NULL
        AND validation."usuarioId" = $2
        AND validation."vendedorId" IS NOT DISTINCT FROM $3
        AND validation."sedeId" = $4
        AND validation."aliadoId" IS NOT DISTINCT FROM $5
      ORDER BY validation."id" DESC
      LIMIT 1
      ${lock ? "FOR SHARE" : ""}
    `,
    input.solicitudId,
    input.usuarioId,
    input.vendedorId,
    input.sedeId,
    input.aliadoId
  );
  const validation = serializeVeriffValidation(rows[0] || null);
  return Boolean(
    validation?.approved &&
      validation.decidedAt &&
      validation.draftId === input.solicitudId &&
      validation.identityDocumentStatus === "match" &&
      compareStrictIdentityDocuments(
        validation.identityDocumentNumber,
        input.document
      ).ok
  );
}

function authoritativeFirmaSeguroWhere(draftAlias: "d" | "draft") {
  return `
    EXISTS (
      SELECT 1
      FROM "FirmaSeguroProcess" firma
      WHERE firma."id" = (
          SELECT latest_firma."id"
          FROM "FirmaSeguroProcess" latest_firma
          WHERE latest_firma."draftId" = ${draftAlias}."id"
            AND latest_firma."supersededAt" IS NULL
          ORDER BY latest_firma."createdAt" DESC, latest_firma."id" DESC
          LIMIT 1
        )
        AND firma."supersededAt" IS NULL
        AND (
          firma."completedAt" IS NOT NULL
          OR NULLIF(BTRIM(firma."signedDocumentBase64"), '') IS NOT NULL
        )
        AND regexp_replace(
          COALESCE(firma."draftPayload"->>'clienteDocumento', ''),
          '[^0-9]', '', 'g'
        ) = regexp_replace(
          COALESCE(${draftAlias}."clienteDocumento", ''),
          '[^0-9]', '', 'g'
        )
        AND regexp_replace(
          COALESCE(firma."draftPayload"->>'imei', ''),
          '[^0-9]', '', 'g'
        ) = regexp_replace(
          COALESCE(${draftAlias}."imei", ''),
          '[^0-9]', '', 'g'
        )
    )
  `;
}

function existingReviewApprovalResult(
  existing: ReviewRow | undefined,
  caseToken: IphoneEnrollmentCaseTokenPayload
) {
  if (!existing) return null;
  if (
    !hasValidReviewAccessProvenance(existing) ||
    existing.identityKeyVersion !== getIphoneEnrollmentIdentityKeyVersion()
  ) {
    throw new IphoneEnrollmentApprovalError(
      "CASE_ALREADY_APPROVED_DIFFERENTLY",
      "La solicitud tiene una revision anterior sin trazabilidad valida."
    );
  }
  if (!hasValidReviewChecklistIntegrity(existing)) {
    throw new IphoneEnrollmentApprovalError(
      "CASE_REVIEW_INCONSISTENT",
      "La revision existente no supera la validacion de integridad."
    );
  }
  if (
    existing.documentHash.trim() !== caseToken.documentHash ||
    existing.imeiHash.trim() !== caseToken.imeiHash
  ) {
    throw new IphoneEnrollmentApprovalError(
      "CASE_ALREADY_APPROVED_DIFFERENTLY",
      "La solicitud tiene una aprobacion asociada a otra identidad de equipo."
    );
  }
  return { review: serializeReview(existing), alreadyApproved: true };
}

const APPROVED_IPHONE_CASE_WHERE = `
  UPPER(COALESCE(d."plataforma", '')) = 'IPHONE'
  AND dc."status" = 'APROBADO'
  AND dc."decision" = 'APROBADO'
  AND dc."platform" = 'IPHONE'
  AND dc."userId" = d."usuarioId"
  AND dc."sedeId" = d."sedeId"
  AND dc."sellerId" IS NOT DISTINCT FROM d."vendedorId"
  AND dc."aliadoId" IS NOT DISTINCT FROM aliado."id"
`;

const ACTIVE_IPHONE_CASE_WHERE = `
  d."estado" = 'ABIERTO'
  AND d."creditoId" IS NULL
  AND d."currentStep" >= 5
  AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
  AND ${authoritativeFirmaSeguroWhere("d")}
  AND ${APPROVED_IPHONE_CASE_WHERE}
`;

const ACTIVE_IPHONE_CASE_JOINS = `
  INNER JOIN "DataCreditoAssessment" dc
    ON dc."id" = d."dataCreditoAssessmentId"
  LEFT JOIN "Sede" sede ON sede."id" = d."sedeId"
  LEFT JOIN "Aliado" aliado ON aliado."id" = sede."aliadoId"
`;

function grantSessionFromRow(
  row: GrantRow,
  session: IphoneEnrollmentPortalSessionPayload
): IphoneEnrollmentGrantSession {
  return {
    accessMode: "GRANT",
    accessFingerprint: hashIphoneEnrollmentGrantFingerprint(row.id),
    grantId: row.id,
    analyst: {
      name: row.analystName,
      externalId: row.analystExternalId,
    },
    issuedBy: {
      userId: row.issuedByUserId,
      name: row.issuedByName,
    },
    expiresAt: new Date(row.sessionExpiresAt || row.expiresAt),
    sessionIdHash: hashIphoneEnrollmentSessionId(session.sessionId),
    session,
  };
}

function sharedSessionFromPayload(
  session: IphoneEnrollmentPortalSessionPayload
): IphoneEnrollmentGrantSession | null {
  if (!isSharedIphoneEnrollmentPortalSession(session)) {
    return null;
  }
  return {
    accessMode: "SHARED",
    accessFingerprint: session.accessFingerprint,
    grantId: session.grantId,
    analyst: {
      name: session.analystName,
      externalId: session.analystExternalId,
    },
    issuedBy: null,
    expiresAt: new Date(session.expiresAt * 1000),
    sessionIdHash: hashIphoneEnrollmentSessionId(session.sessionId),
    session,
  };
}

export async function createIphoneEnrollmentAccessGrant(input: {
  analystName: string;
  analystExternalId: string;
  expiresInMinutes: number;
  issuedByUserId: number;
  issuedByName: string;
}) {
  await ensureIphoneEnrollmentSchema();
  const expiresInMinutes = Math.max(
    5,
    Math.min(8 * 60, Math.trunc(input.expiresInMinutes))
  );
  const token = createIphoneEnrollmentGrantSecret();
  const tokenHash = hashIphoneEnrollmentGrantToken(token);
  const id = randomUUID();
  const rows = await prisma.$queryRawUnsafe<GrantRow[]>(
    `
      INSERT INTO "IphoneEnrollmentAccessGrant" (
        "id", "tokenHash", "analystName", "analystExternalId",
        "issuedByUserId", "issuedByName", "expiresAt", "createdAt"
      )
      VALUES (
        $1::uuid, $2, $3, $4, $5, $6,
        CURRENT_TIMESTAMP + ($7::integer * INTERVAL '1 minute'),
        CURRENT_TIMESTAMP
      )
      RETURNING ${GRANT_SELECT}
    `,
    id,
    tokenHash,
    input.analystName,
    input.analystExternalId,
    input.issuedByUserId,
    input.issuedByName,
    expiresInMinutes
  );
  return {
    token,
    item: serializeGrant(rows[0]),
  };
}

export async function listIphoneEnrollmentAccessGrants(limit = 100) {
  await ensureIphoneEnrollmentSchema();
  const take = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = await prisma.$queryRawUnsafe<GrantRow[]>(
    `
      SELECT ${GRANT_SELECT}
      FROM "IphoneEnrollmentAccessGrant"
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT $1
    `,
    take
  );
  return rows.map((row) => serializeGrant(row));
}

export async function revokeIphoneEnrollmentAccessGrant(input: {
  id: string;
  revokedByUserId: number;
  revokedByName: string;
}) {
  await ensureIphoneEnrollmentSchema();
  const rows = await prisma.$queryRawUnsafe<GrantRow[]>(
    `
      UPDATE "IphoneEnrollmentAccessGrant"
      SET "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP),
          "revokedByUserId" = COALESCE("revokedByUserId", $2),
          "revokedByName" = COALESCE("revokedByName", $3)
      WHERE "id" = $1::uuid
      RETURNING ${GRANT_SELECT}
    `,
    input.id,
    input.revokedByUserId,
    input.revokedByName
  );
  return rows[0] ? serializeGrant(rows[0]) : null;
}

async function persistIphoneEnrollmentAccessAttempt(tokenHash: string) {
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
      `iphone-enrollment-grant-rate:${tokenHash}`
    );
    const grants = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
      `
        SELECT "id"
        FROM "IphoneEnrollmentAccessGrant"
        WHERE "tokenHash" = $1
        LIMIT 1
      `,
      tokenHash
    );
    const grant = grants[0];
    if (!grant) {
      // Un token inexistente termina antes de limpiar o escribir intentos.
      throw new IphoneEnrollmentGrantError(
        "GRANT_NOT_AVAILABLE",
        "El enlace de acceso no es valido o ya vencio."
      );
    }

    const accessSubjectHash = hashIphoneEnrollmentRateLimitKey(
      "grant",
      grant.id
    );
    const accessCounts = await transaction.$queryRawUnsafe<
      Array<{ count: bigint }>
    >(
      `
        SELECT COUNT(*)::bigint AS "count"
        FROM "IphoneEnrollmentPortalAttempt"
        WHERE "clientHash" = $1
          AND "action" = 'ACCESS'
          AND "createdAt" > CURRENT_TIMESTAMP - INTERVAL '15 minutes'
      `,
      accessSubjectHash
    );
    if (Number(accessCounts[0]?.count || 0) >= 8) {
      throw new IphoneEnrollmentGrantError(
        "GRANT_RATE_LIMITED",
        "Demasiados intentos para este enlace.",
        15 * 60
      );
    }
    if (reserveIphoneEnrollmentAttemptCleanup()) {
      await transaction.$executeRawUnsafe(`
        DELETE FROM "IphoneEnrollmentPortalAttempt"
        WHERE "createdAt" < CURRENT_TIMESTAMP - INTERVAL '24 hours'
      `);
    }
    // Debe ser la última operación del callback: al completarse, esta transacción
    // confirma el intento antes de que el canje valide estado en otra transacción.
    await transaction.$executeRawUnsafe(
      `
        INSERT INTO "IphoneEnrollmentPortalAttempt" ("clientHash", "action")
        VALUES ($1, 'ACCESS')
      `,
      accessSubjectHash
    );
  });
}

export async function exchangeIphoneEnrollmentAccessGrant(token: string) {
  const normalizedToken = normalizeIphoneEnrollmentGrantSecret(token);
  if (!normalizedToken) {
    throw new IphoneEnrollmentGrantError(
      "GRANT_NOT_AVAILABLE",
      "El enlace de acceso no es valido o ya vencio."
    );
  }
  await ensureIphoneEnrollmentSchema();
  const tokenHash = hashIphoneEnrollmentGrantToken(normalizedToken);
  // Esta transacción se confirma por separado. Los rechazos por grant usado,
  // revocado o vencido que ocurran durante el canje no revierten el intento.
  await persistIphoneEnrollmentAccessAttempt(tokenHash);
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
      `iphone-enrollment-grant:${tokenHash}`
    );
    const rows = await transaction.$queryRawUnsafe<GrantRow[]>(
      `
        SELECT ${GRANT_SELECT}
        FROM "IphoneEnrollmentAccessGrant"
        WHERE "tokenHash" = $1
        LIMIT 1
        FOR UPDATE
      `,
      tokenHash
    );
    const row = rows[0];
    if (!row) {
      throw new IphoneEnrollmentGrantError(
        "GRANT_NOT_AVAILABLE",
        "El enlace de acceso no es valido o ya vencio."
      );
    }

    if (
      row.revokedAt ||
      new Date(row.expiresAt).getTime() <= Date.now()
    ) {
      throw new IphoneEnrollmentGrantError(
        "GRANT_NOT_AVAILABLE",
        "El enlace de acceso no es valido o ya vencio."
      );
    }
    if (row.consumedAt) {
      throw new IphoneEnrollmentGrantError(
        "GRANT_ALREADY_USED",
        "El enlace de acceso ya fue utilizado."
      );
    }

    const session = issueIphoneEnrollmentPortalSession({
      grantId: row.id,
      analyst: {
        name: row.analystName,
        externalId: row.analystExternalId,
      },
      grantExpiresAt: new Date(row.expiresAt),
    });
    const sessionIdHash = hashIphoneEnrollmentSessionId(
      session.payload.sessionId
    );
    const updatedRows = await transaction.$queryRawUnsafe<GrantRow[]>(
      `
        UPDATE "IphoneEnrollmentAccessGrant"
        SET "consumedAt" = CURRENT_TIMESTAMP,
            "sessionIdHash" = $2,
            "sessionExpiresAt" = $3
        WHERE "id" = $1::uuid
          AND "consumedAt" IS NULL
          AND "revokedAt" IS NULL
          AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING ${GRANT_SELECT}
      `,
      row.id,
      sessionIdHash,
      session.expiresAt
    );
    if (!updatedRows[0]) {
      throw new IphoneEnrollmentGrantError(
        "GRANT_NOT_ACTIVE",
        "El enlace de acceso ya no esta activo."
      );
    }
    return {
      session,
      grant: grantSessionFromRow(updatedRows[0], session.payload),
      item: serializeGrant(updatedRows[0]),
    };
  });
}

async function readActiveGrantForSession(
  session: IphoneEnrollmentPortalSessionPayload,
  database: Database = prisma,
  lock = false
) {
  const sessionIdHash = hashIphoneEnrollmentSessionId(session.sessionId);
  const rows = await database.$queryRawUnsafe<GrantRow[]>(
    `
      SELECT ${GRANT_SELECT}
      FROM "IphoneEnrollmentAccessGrant"
      WHERE "id" = $1::uuid
        AND "consumedAt" IS NOT NULL
        AND "sessionIdHash" = $2
        AND "sessionExpiresAt" > CURRENT_TIMESTAMP
        AND "expiresAt" > CURRENT_TIMESTAMP
        AND "revokedAt" IS NULL
      LIMIT 1
      ${lock ? "FOR UPDATE" : ""}
    `,
    session.grantId,
    sessionIdHash
  );
  const row = rows[0];
  if (
    !row ||
    row.analystName !== session.analystName ||
    row.analystExternalId !== session.analystExternalId ||
    Math.abs(
      new Date(row.sessionExpiresAt || 0).getTime() -
        session.expiresAt * 1000
    ) > 1_000
  ) {
    return null;
  }
  return grantSessionFromRow(row, session);
}

async function readActivePortalAccessForSession(
  session: IphoneEnrollmentPortalSessionPayload,
  database: Database = prisma,
  lock = false
) {
  if (session.accessMode === "SHARED") {
    return sharedSessionFromPayload(session);
  }
  return readActiveGrantForSession(session, database, lock);
}

export async function validateIphoneEnrollmentPortalSession(
  session: IphoneEnrollmentPortalSessionPayload
) {
  await ensureIphoneEnrollmentSchema();
  return readActivePortalAccessForSession(session);
}

export async function findIphoneEnrollmentCase(input: {
  document: string;
  imei: string;
}): Promise<IphoneEnrollmentLookupResult> {
  await Promise.all([
    ensureIphoneEnrollmentSchema(),
    ensureFirmaSeguroSchema(),
    ensureVeriffSchema(),
    expireStaleSolicitudes(),
  ]);
  const rows = await prisma.$queryRawUnsafe<EnrollmentCaseRow[]>(
    `
      SELECT d."id" AS "solicitudId", d."currentStep", d."usuarioId",
        d."vendedorId", d."sedeId", aliado."id" AS "aliadoId", d."clienteNombre",
        d."clienteDocumento", d."imei",
        NULLIF(d."payload"->>'equipoMarca', '') AS "equipoMarca",
        NULLIF(d."payload"->>'equipoModelo', '') AS "equipoModelo",
        sede."nombre" AS "sedeNombre", aliado."nombre" AS "aliadoNombre",
        dc."documentHash" AS "dataCreditoDocumentHash",
        review."id"::text AS "reviewId", review."analystName",
        review."approvedAt", review."checklistVersion"
      FROM "CreditoBorrador" d
      ${ACTIVE_IPHONE_CASE_JOINS}
      LEFT JOIN "IphoneEnrollmentReview" review
        ON review."solicitudId" = d."id"
      WHERE ${ACTIVE_IPHONE_CASE_WHERE}
        AND regexp_replace(COALESCE(d."clienteDocumento", ''), '[^0-9]', '', 'g') = $1
        AND regexp_replace(COALESCE(d."imei", ''), '[^0-9]', '', 'g') = $2
        AND dc."documentHash" = $3
      ORDER BY d."createdAt" DESC, d."id" DESC
      LIMIT 2
    `,
    input.document,
    input.imei,
    hmacDataCreditoValue("document", input.document)
  );
  if (rows.length > 1) return { kind: "AMBIGUOUS" };
  const eligibleRows: EnrollmentCaseRow[] = [];
  for (const candidate of rows) {
    const veriffApproved = await hasAuthorizedVeriffApprovalForEnrollment({
      solicitudId: candidate.solicitudId,
      usuarioId: candidate.usuarioId,
      vendedorId: candidate.vendedorId,
      sedeId: candidate.sedeId,
      aliadoId: candidate.aliadoId,
      document: input.document,
    });
    if (veriffApproved) eligibleRows.push(candidate);
  }
  if (rows.length > 0 && eligibleRows.length === 0) {
    return { kind: "NOT_READY" };
  }
  if (!rows.length) {
    const availability = await prisma.$queryRawUnsafe<
      Array<{ finalized: boolean; waitingForStepFour: boolean }>
    >(
      `
        SELECT
          (
            d."creditoId" IS NOT NULL
            OR (d."estado" = 'CERRADO' AND d."closedReason" = 'FINALIZADA')
          ) AS "finalized",
          (
            d."estado" = 'ABIERTO'
            AND d."creditoId" IS NULL
            AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
          ) AS "waitingForStepFour"
        FROM "CreditoBorrador" d
        ${ACTIVE_IPHONE_CASE_JOINS}
        WHERE ${APPROVED_IPHONE_CASE_WHERE}
          AND regexp_replace(COALESCE(d."clienteDocumento", ''), '[^0-9]', '', 'g') = $1
          AND regexp_replace(COALESCE(d."imei", ''), '[^0-9]', '', 'g') = $2
          AND dc."documentHash" = $3
        ORDER BY d."createdAt" DESC, d."id" DESC
        LIMIT 1
      `,
      input.document,
      input.imei,
      hmacDataCreditoValue("document", input.document)
    );
    if (availability[0]?.waitingForStepFour) {
      return { kind: "NOT_READY" };
    }
    if (availability[0]?.finalized) {
      return { kind: "FINALIZED" };
    }
    return { kind: "NOT_FOUND" };
  }
  if (eligibleRows.length !== 1) return { kind: "AMBIGUOUS" };

  const row = eligibleRows[0];
  const documentHash = hashIphoneEnrollmentDocument(input.document);
  const imeiHash = hashIphoneEnrollmentImei(input.imei);
  const review = row.reviewId
    ? await getIphoneEnrollmentReviewForSolicitud({
        solicitudId: row.solicitudId,
        document: input.document,
        imei: input.imei,
      })
    : null;
  return {
    kind: "FOUND",
    item: {
      solicitudId: row.solicitudId,
      solicitudNumero: `SOL-${String(row.solicitudId).padStart(6, "0")}`,
      currentStep: row.currentStep,
      clienteNombre: limitedClientName(row.clienteNombre),
      documentoMasked: maskDocument(input.document),
      imeiMasked: maskImei(input.imei),
      equipo: equipmentLabel(row),
      sede: String(row.sedeNombre || "Sede").trim(),
      aliado: String(row.aliadoNombre || "Aliado").trim(),
      documentHash,
      imeiHash,
      review,
    },
  };
}

export async function getIphoneEnrollmentReviewForSolicitud(
  input: { solicitudId: number; document: string; imei: string },
  database: Database = prisma
) {
  await Promise.all([
    ensureIphoneEnrollmentSchema(),
    ensureFirmaSeguroSchema(),
    ensureVeriffSchema(),
  ]);
  const rows = await database.$queryRawUnsafe<ReviewWithDraftScopeRow[]>(
    `
      SELECT review."id"::text, review."solicitudId", review."decision",
        review."checklistVersion", review."checklist", review."documentHash",
        review."imeiHash", review."checklistHash", review."analystName",
        review."analystExternalId", review."identityKeyVersion",
        review."grantId"::text, review."grantIssuedByUserId",
        review."grantIssuedByName", review."accessFingerprint",
        review."correlationId"::text, review."approvedAt", review."createdAt",
        draft."usuarioId" AS "draftUsuarioId",
        draft."vendedorId" AS "draftVendedorId",
        draft."sedeId" AS "draftSedeId",
        aliado."id" AS "draftAliadoId"
      FROM "IphoneEnrollmentReview" review
      INNER JOIN "CreditoBorrador" draft ON draft."id" = review."solicitudId"
      LEFT JOIN "Sede" sede ON sede."id" = draft."sedeId"
      LEFT JOIN "Aliado" aliado ON aliado."id" = sede."aliadoId"
      WHERE review."solicitudId" = $1
        AND review."decision" = 'APROBADO'
        AND review."identityKeyVersion" = $4
        AND regexp_replace(COALESCE(draft."clienteDocumento", ''), '[^0-9]', '', 'g') = $2
        AND regexp_replace(COALESCE(draft."imei", ''), '[^0-9]', '', 'g') = $3
        AND UPPER(COALESCE(draft."plataforma", '')) = 'IPHONE'
        AND ${authoritativeFirmaSeguroWhere("draft")}
      LIMIT 1
    `,
    input.solicitudId,
    input.document,
    input.imei,
    getIphoneEnrollmentIdentityKeyVersion()
  );
  const row = rows[0];
  if (!row) return null;
  const veriffApproved = await hasAuthorizedVeriffApprovalForEnrollment(
    {
      solicitudId: row.solicitudId,
      usuarioId: row.draftUsuarioId,
      vendedorId: row.draftVendedorId,
      sedeId: row.draftSedeId,
      aliadoId: row.draftAliadoId,
      document: input.document,
    },
    database
  );
  if (
    !veriffApproved ||
    !hasValidReviewAccessProvenance(row) ||
    !hasValidReviewChecklistIntegrity(row) ||
    row.documentHash.trim() !== hashIphoneEnrollmentDocument(input.document) ||
    row.imeiHash.trim() !== hashIphoneEnrollmentImei(input.imei)
  ) {
    return null;
  }
  return serializeReview(row);
}

export async function approveIphoneEnrollmentCase(input: {
  caseToken: IphoneEnrollmentCaseTokenPayload;
  grant: IphoneEnrollmentGrantSession;
  checklist: IphoneEnrollmentChecklist;
}) {
  await Promise.all([
    ensureIphoneEnrollmentSchema(),
    ensureFirmaSeguroSchema(),
    ensureVeriffSchema(),
    expireStaleSolicitudes(),
  ]);
  return prisma.$transaction(async (transaction) => {
    const activeGrant = await readActivePortalAccessForSession(
      input.grant.session,
      transaction,
      true
    );
    if (
      !activeGrant ||
      activeGrant.grantId !== input.grant.grantId ||
      input.caseToken.grantId !== activeGrant.grantId ||
      !isIphoneEnrollmentCaseTokenForSession(
        input.caseToken,
        activeGrant.session
      )
    ) {
      throw new IphoneEnrollmentGrantError(
        "GRANT_NOT_ACTIVE",
        "La sesion del analista ya no esta activa."
      );
    }
    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
      `iphone-enrollment:${input.caseToken.solicitudId}`
    );
    const existingRows = await transaction.$queryRawUnsafe<ReviewRow[]>(
      `
        SELECT ${REVIEW_SELECT}
        FROM "IphoneEnrollmentReview"
        WHERE "solicitudId" = $1
        LIMIT 1
      `,
      input.caseToken.solicitudId
    );
    const existingResult = existingReviewApprovalResult(
      existingRows[0],
      input.caseToken
    );
    if (existingResult) return existingResult;

    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock($1::integer, $2::integer)`,
      FIRMASEGURO_DRAFT_LOCK_NAMESPACE,
      input.caseToken.solicitudId
    );
    const rows = await transaction.$queryRawUnsafe<EnrollmentCaseRow[]>(
      `
        SELECT d."id" AS "solicitudId", d."currentStep", d."usuarioId",
          d."vendedorId", d."sedeId", aliado."id" AS "aliadoId", d."clienteNombre",
          d."clienteDocumento", d."imei",
          NULLIF(d."payload"->>'equipoMarca', '') AS "equipoMarca",
          NULLIF(d."payload"->>'equipoModelo', '') AS "equipoModelo",
          sede."nombre" AS "sedeNombre", aliado."nombre" AS "aliadoNombre",
          dc."documentHash" AS "dataCreditoDocumentHash",
          review."id"::text AS "reviewId", review."analystName",
          review."approvedAt", review."checklistVersion"
        FROM "CreditoBorrador" d
        ${ACTIVE_IPHONE_CASE_JOINS}
        LEFT JOIN "IphoneEnrollmentReview" review
          ON review."solicitudId" = d."id"
        WHERE ${ACTIVE_IPHONE_CASE_WHERE}
          AND d."id" = $1
        LIMIT 1
        FOR UPDATE OF d
      `,
      input.caseToken.solicitudId
    );
    const row = rows[0];
    if (!row) {
      throw new IphoneEnrollmentApprovalError(
        "CASE_NOT_AVAILABLE",
        "La solicitud ya no esta disponible para aprobar el enrolamiento."
      );
    }
    const document = String(row.clienteDocumento || "").replace(/\D/g, "");
    const imei = String(row.imei || "").replace(/\D/g, "");
    const veriffApproved = await hasAuthorizedVeriffApprovalForEnrollment(
      {
        solicitudId: row.solicitudId,
        usuarioId: row.usuarioId,
        vendedorId: row.vendedorId,
        sedeId: row.sedeId,
        aliadoId: row.aliadoId,
        document,
      },
      transaction,
      true
    );
    if (!veriffApproved) {
      throw new IphoneEnrollmentApprovalError(
        "CASE_NOT_AVAILABLE",
        "La validacion facial ya no autoriza esta solicitud para enrolamiento."
      );
    }
    if (
      hashIphoneEnrollmentDocument(document) !== input.caseToken.documentHash ||
      hashIphoneEnrollmentImei(imei) !== input.caseToken.imeiHash ||
      row.dataCreditoDocumentHash.trim() !==
        hmacDataCreditoValue("document", document)
    ) {
      throw new IphoneEnrollmentApprovalError(
        "CASE_IDENTITY_CHANGED",
        "La cedula o el IMEI cambiaron. Consulta nuevamente la solicitud."
      );
    }

    const checklistHash = hashIphoneEnrollmentChecklist(input.checklist);
    const inserted = await transaction.$queryRawUnsafe<ReviewRow[]>(
      `
        INSERT INTO "IphoneEnrollmentReview" (
          "id", "solicitudId", "decision", "checklistVersion", "checklist",
          "documentHash", "imeiHash", "checklistHash", "analystName",
          "analystExternalId", "identityKeyVersion", "grantId",
          "grantIssuedByUserId", "grantIssuedByName", "accessFingerprint",
          "correlationId", "approvedAt", "createdAt"
        )
        VALUES (
          $1::uuid, $2, 'APROBADO', $3, $4::jsonb,
          $5, $6, $7, $8, $9, $10, $11::uuid,
          $12, $13, $14, $15::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING ${REVIEW_SELECT}
      `,
      randomUUID(),
      row.solicitudId,
      IPHONE_ENROLLMENT_CHECKLIST_VERSION,
      JSON.stringify(input.checklist),
      input.caseToken.documentHash,
      input.caseToken.imeiHash,
      checklistHash,
      activeGrant.analyst.name,
      activeGrant.analyst.externalId,
      getIphoneEnrollmentIdentityKeyVersion(),
      activeGrant.accessMode === "GRANT" ? activeGrant.grantId : null,
      activeGrant.issuedBy?.userId || null,
      activeGrant.issuedBy?.name || null,
      activeGrant.accessMode === "SHARED"
        ? hashIphoneEnrollmentSharedReviewFingerprint()
        : activeGrant.accessFingerprint,
      input.caseToken.correlationId
    );
    return { review: serializeReview(inserted[0]), alreadyApproved: false };
  });
}

export async function consumeIphoneEnrollmentRateLimit(input: {
  subjectHash: string;
  action: "ACCESS" | "LOOKUP" | "APPROVE";
  maximum: number;
  windowMinutes?: number;
}) {
  await ensureIphoneEnrollmentSchema();
  const windowMinutes = Math.max(1, Math.min(60, input.windowMinutes || 15));
  const maximum = Math.max(1, Math.min(1_000, input.maximum));
  const cleanupExpiredAttempts = reserveIphoneEnrollmentAttemptCleanup();
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
      `iphone-enrollment-rate:${input.subjectHash}:${input.action}`
    );
    if (cleanupExpiredAttempts) {
      await transaction.$executeRawUnsafe(`
        DELETE FROM "IphoneEnrollmentPortalAttempt"
        WHERE "createdAt" < CURRENT_TIMESTAMP - INTERVAL '24 hours'
      `);
    }
    const counts = await transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
      `
        SELECT COUNT(*)::bigint AS "count"
        FROM "IphoneEnrollmentPortalAttempt"
        WHERE "clientHash" = $1 AND "action" = $2
          AND "createdAt" > CURRENT_TIMESTAMP - ($3::integer * INTERVAL '1 minute')
      `,
      input.subjectHash,
      input.action,
      windowMinutes
    );
    const count = Number(counts[0]?.count || 0);
    if (count >= maximum) {
      return { allowed: false, retryAfterSeconds: windowMinutes * 60 };
    }
    await transaction.$executeRawUnsafe(
      `
        INSERT INTO "IphoneEnrollmentPortalAttempt" ("clientHash", "action")
        VALUES ($1, $2)
      `,
      input.subjectHash,
      input.action
    );
    return {
      allowed: true,
      remaining: Math.max(0, maximum - count - 1),
      retryAfterSeconds: windowMinutes * 60,
    };
  });
}
