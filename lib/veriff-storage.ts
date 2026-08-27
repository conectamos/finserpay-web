import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import {
  areVeriffDecisionsTrusted,
  extractVeriffIdentityData,
  extractVeriffIdentityDocumentEvidence,
  extractVeriffSessionUrl,
  normalizeVeriffStatus,
  redactVeriffPayload,
  resolveVeriffStatusEvidence,
  shouldPreserveVeriffStatusTransition,
  summarizeVeriffDecision,
  summarizeVeriffRisk,
  type VeriffStatus,
} from "@/lib/veriff";
import { compareDataCreditoVeriffIdentityEvidence } from "@/lib/veriff-identity";

export type VeriffValidationRow = {
  id: number;
  creditoId: number | null;
  draftId: number | null;
  captureToken: string | null;
  veriffSessionId: string | null;
  attemptId: string | null;
  vendorData: string | null;
  endUserId: string | null;
  status: string;
  decision: string | null;
  code: string | null;
  reason: string | null;
  reasonCode: string | null;
  clienteDocumento: string | null;
  clienteNombre: string | null;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  aliadoId: number | null;
  requestPayload: unknown;
  createPayload: unknown;
  mediaPayload: unknown;
  submitPayload: unknown;
  decisionPayload: unknown;
  webhookPayload: unknown;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
  decidedAt: Date | null;
};

type CreateInput = {
  captureToken?: string | null;
  clienteDocumento?: string | null;
  clienteNombre?: string | null;
  draftId?: number | null;
  endUserId?: string | null;
  requestPayload?: unknown;
  usuarioId: number;
  vendedorId?: number | null;
  sedeId: number;
  aliadoId?: number | null;
  vendorData?: string | null;
};

type UpdateInput = {
  attemptId?: string | null;
  clearWebhookPayload?: boolean;
  code?: string | null;
  createPayload?: unknown;
  decision?: string | null;
  decisionPayload?: unknown;
  decidedAt?: Date | null;
  lastError?: string | null;
  mediaPayload?: unknown;
  reason?: string | null;
  reasonCode?: string | null;
  status?: string | null;
  submitPayload?: unknown;
  submittedAt?: Date | null;
  veriffSessionId?: string | null;
  webhookPayload?: unknown;
};

let veriffSchemaPromise: Promise<void> | null = null;
const VERIFF_DRAFT_ATTEMPT_LOCK_NAMESPACE = 620_917;
const VERIFF_POST_LINK_REVIEW_ERROR =
  "VERIFF_POST_LINK_DECISION_REVIEW_REQUIRED";
const VERIFF_DECISION_ORDER_REVIEW_ERROR =
  "VERIFF_DECISION_ORDER_REVIEW_REQUIRED";
type VeriffQueryDatabase = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;

function jsonValue(value: unknown) {
  return value === undefined ? null : JSON.stringify(redactVeriffPayload(value));
}

function stableAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableAuditValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableAuditValue(child)])
    );
  }
  return value ?? null;
}

function buildVeriffEventKey(
  validationId: number,
  source: "decisionPayload" | "webhookPayload",
  payload: unknown
) {
  const redactedPayload = redactVeriffPayload(payload);
  return createHash("sha256")
    .update(
      JSON.stringify({
        payload: stableAuditValue(redactedPayload),
        source,
        validationId,
      })
    )
    .digest("hex");
}

function toDate(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function runVeriffSchemaSetup() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "VeriffIdentityValidation" (
      "id" SERIAL PRIMARY KEY,
      "creditoId" INTEGER,
      "draftId" INTEGER,
      "captureToken" TEXT,
      "veriffSessionId" TEXT,
      "attemptId" TEXT,
      "vendorData" TEXT,
      "endUserId" TEXT,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "decision" TEXT,
      "code" TEXT,
      "reason" TEXT,
      "reasonCode" TEXT,
      "clienteDocumento" TEXT,
      "clienteNombre" TEXT,
      "usuarioId" INTEGER NOT NULL,
      "vendedorId" INTEGER,
      "sedeId" INTEGER NOT NULL,
      "aliadoId" INTEGER,
      "requestPayload" JSONB,
      "createPayload" JSONB,
      "mediaPayload" JSONB,
      "submitPayload" JSONB,
      "decisionPayload" JSONB,
      "webhookPayload" JSONB,
      "lastError" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "submittedAt" TIMESTAMP(3),
      "decidedAt" TIMESTAMP(3)
    )
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "VeriffIdentityValidation"
      ADD COLUMN IF NOT EXISTS "creditoId" INTEGER,
      ADD COLUMN IF NOT EXISTS "draftId" INTEGER,
      ADD COLUMN IF NOT EXISTS "captureToken" TEXT,
      ADD COLUMN IF NOT EXISTS "attemptId" TEXT,
      ADD COLUMN IF NOT EXISTS "vendorData" TEXT,
      ADD COLUMN IF NOT EXISTS "endUserId" TEXT,
      ADD COLUMN IF NOT EXISTS "decision" TEXT,
      ADD COLUMN IF NOT EXISTS "code" TEXT,
      ADD COLUMN IF NOT EXISTS "reason" TEXT,
      ADD COLUMN IF NOT EXISTS "reasonCode" TEXT,
      ADD COLUMN IF NOT EXISTS "aliadoId" INTEGER,
      ADD COLUMN IF NOT EXISTS "requestPayload" JSONB,
      ADD COLUMN IF NOT EXISTS "createPayload" JSONB,
      ADD COLUMN IF NOT EXISTS "mediaPayload" JSONB,
      ADD COLUMN IF NOT EXISTS "submitPayload" JSONB,
      ADD COLUMN IF NOT EXISTS "decisionPayload" JSONB,
      ADD COLUMN IF NOT EXISTS "webhookPayload" JSONB,
      ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "decidedAt" TIMESTAMP(3)
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'VeriffIdentityValidation_creditoId_fkey'
      ) THEN
        ALTER TABLE "VeriffIdentityValidation"
          ADD CONSTRAINT "VeriffIdentityValidation_creditoId_fkey"
          FOREIGN KEY ("creditoId") REFERENCES "Credito"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END
    $$
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "VeriffIdentityValidation_session_key"
      ON "VeriffIdentityValidation" ("veriffSessionId")
      WHERE "veriffSessionId" IS NOT NULL
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "VeriffIdentityValidationEvent" (
      "id" BIGSERIAL PRIMARY KEY,
      "validationId" INTEGER NOT NULL
        REFERENCES "VeriffIdentityValidation"("id") ON DELETE CASCADE,
      "eventKey" VARCHAR(64) NOT NULL UNIQUE,
      "source" TEXT NOT NULL,
      "status" TEXT,
      "payload" JSONB,
      "postLink" BOOLEAN NOT NULL DEFAULT FALSE,
      "reviewRequired" BOOLEAN NOT NULL DEFAULT FALSE,
      "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "VeriffIdentityValidationEvent_validation_idx"
      ON "VeriffIdentityValidationEvent" ("validationId", "receivedAt" DESC)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "VeriffIdentityValidation_documento_idx"
      ON "VeriffIdentityValidation" ("clienteDocumento", "createdAt" DESC)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "VeriffIdentityValidation_credito_idx"
      ON "VeriffIdentityValidation" ("creditoId", "createdAt" DESC)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "VeriffIdentityValidation_scope_idx"
      ON "VeriffIdentityValidation" ("sedeId", "status", "createdAt" DESC)
  `);
}

export async function ensureVeriffSchema() {
  if (!veriffSchemaPromise) {
    veriffSchemaPromise = runVeriffSchemaSetup().catch((error) => {
      veriffSchemaPromise = null;
      throw error;
    });
  }

  await veriffSchemaPromise;
}

export async function lockVeriffDraftAttempts(
  database: Pick<Prisma.TransactionClient, "$executeRawUnsafe">,
  draftId: number
) {
  await database.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock($1, $2)`,
    VERIFF_DRAFT_ATTEMPT_LOCK_NAMESPACE,
    draftId
  );
}

function objectValue(value: unknown, key: string) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : null;
}

function statusFromDecisionPayload(payload: unknown): VeriffStatus | null {
  if (!payload) {
    return null;
  }

  const status = summarizeVeriffDecision(payload).status;

  if (status !== "PENDING") {
    return status;
  }

  const nestedDecisionPayload = objectValue(payload, "decisionPayload");
  if (nestedDecisionPayload) {
    return summarizeVeriffDecision(nestedDecisionPayload).status;
  }

  return status;
}

function resolveVeriffRowStatus(row: VeriffValidationRow | null | undefined) {
  if (!row) {
    return "PENDING" satisfies VeriffStatus;
  }

  return resolveVeriffStatusEvidence(
    [
      statusFromDecisionPayload(row.decisionPayload),
      statusFromDecisionPayload(row.webhookPayload),
    ],
    normalizeVeriffStatus(row.decision || row.status)
  ).status;
}

export function isVeriffApproved(row: VeriffValidationRow | null | undefined) {
  return areVeriffDecisionsTrusted() && resolveVeriffRowStatus(row) === "APPROVED";
}

export function serializeVeriffValidation(row: VeriffValidationRow | null) {
  if (!row) {
    return null;
  }

  const status = resolveVeriffRowStatus(row);
  const technicalApproved = status === "APPROVED";
  const trusted = areVeriffDecisionsTrusted();
  const risk = summarizeVeriffRisk(row.decisionPayload, row.webhookPayload);
  const approved = technicalApproved && trusted;
  const riskBlocked = !technicalApproved && risk.blocked;
  const decisionIdentity = extractVeriffIdentityData(row.decisionPayload);
  const webhookIdentity = extractVeriffIdentityData(row.webhookPayload);
  const identityData = decisionIdentity || webhookIdentity;
  const identityDocumentComparison = compareDataCreditoVeriffIdentityEvidence(
    [
      extractVeriffIdentityDocumentEvidence(row.decisionPayload),
      extractVeriffIdentityDocumentEvidence(row.webhookPayload),
    ],
    row.clienteDocumento
  );

  return {
    id: row.id,
    creditoId: row.creditoId,
    draftId: row.draftId,
    captureToken: row.captureToken,
    veriffSessionId: row.veriffSessionId,
    sessionUrl: extractVeriffSessionUrl(row.createPayload),
    identityData,
    identityDocumentNumber: identityDocumentComparison.ok
      ? identityDocumentComparison.documentNumber
      : null,
    identityDocumentStatus: identityDocumentComparison.status,
    attemptId: row.attemptId,
    vendorData: row.vendorData,
    status,
    decision: status,
    code: row.code,
    reason: row.reason,
    reasonCode: row.reasonCode,
    clienteDocumento: row.clienteDocumento,
    clienteNombre: row.clienteNombre,
    approved,
    technicalApproved,
    trusted,
    riskBlocked,
    riskSignals: risk,
    pending: status === "PENDING" || status === "REVIEW" || status === "RESUBMISSION",
    lastError: row.lastError,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    submittedAt:
      row.submittedAt instanceof Date ? row.submittedAt.toISOString() : row.submittedAt,
    decidedAt:
      row.decidedAt instanceof Date ? row.decidedAt.toISOString() : row.decidedAt,
  };
}

export async function createVeriffValidation(input: CreateInput) {
  await ensureVeriffSchema();

  return prisma.$transaction(async (transaction) => {
    if (input.draftId) {
      await lockVeriffDraftAttempts(transaction, input.draftId);
      const reusableRows =
        await transaction.$queryRawUnsafe<VeriffValidationRow[]>(
          `
            SELECT validation.*
            FROM "VeriffIdentityValidation" validation
            WHERE validation."draftId" = $1
              AND validation."sedeId" = $2
              AND validation."aliadoId" IS NOT DISTINCT FROM $3
              AND validation."id" = (
                SELECT MAX(latest."id")
                FROM "VeriffIdentityValidation" latest
                WHERE latest."draftId" = $1
              )
              AND validation."creditoId" IS NULL
              AND regexp_replace(
                COALESCE(validation."clienteDocumento", ''),
                '[^0-9]',
                '',
                'g'
              ) = $4
              AND validation."status" NOT IN (
                'APPROVED',
                'DECLINED',
                'ERROR',
                'EXPIRED',
                'ABANDONED'
              )
              AND (
                (
                  validation."veriffSessionId" IS NOT NULL
                  AND validation."createPayload" IS NOT NULL
                  AND validation."createdAt" >= NOW() - INTERVAL '24 hours'
                )
                OR (
                  (
                    validation."veriffSessionId" IS NULL
                    OR validation."createPayload" IS NULL
                  )
                  AND validation."createdAt" >= NOW() - INTERVAL '2 minutes'
                )
              )
            ORDER BY validation."id" DESC
            LIMIT 1
          `,
          input.draftId,
          input.sedeId,
          input.aliadoId || null,
          String(input.clienteDocumento || "").replace(/\D/g, "")
        );
      if (reusableRows[0]) {
        return { created: false, row: reusableRows[0] };
      }
    }

    const rows = await transaction.$queryRawUnsafe<VeriffValidationRow[]>(
      `
        INSERT INTO "VeriffIdentityValidation" (
          "draftId",
          "captureToken",
          "vendorData",
          "endUserId",
          "status",
          "clienteDocumento",
          "clienteNombre",
          "usuarioId",
          "vendedorId",
          "sedeId",
          "aliadoId",
          "requestPayload"
        )
        SELECT
          $1, $2, $3, $4, 'PENDING', $5, $6, $7, $8, $9, $10, $11::jsonb
        WHERE $1::integer IS NULL
          OR EXISTS (
            SELECT 1
            FROM "CreditoBorrador" draft
            WHERE draft."id" = $1
              AND draft."estado" = 'ABIERTO'
              AND draft."creditoId" IS NULL
          )
        RETURNING *
      `,
      input.draftId || null,
      input.captureToken || null,
      input.vendorData || null,
      input.endUserId || null,
      input.clienteDocumento || null,
      input.clienteNombre || null,
      input.usuarioId,
      input.vendedorId || null,
      input.sedeId,
      input.aliadoId || null,
      jsonValue(input.requestPayload)
    );

    return { created: true, row: rows[0] || null };
  });
}

export async function getReusableVeriffValidationForDraft(input: {
  aliadoId?: number | null;
  clienteDocumento?: string | null;
  draftId: number;
  sedeId: number;
}) {
  await ensureVeriffSchema();

  const rows = await prisma.$queryRawUnsafe<VeriffValidationRow[]>(
    `
      SELECT *
      FROM "VeriffIdentityValidation"
      WHERE "draftId" = $1
        AND "sedeId" = $2
        AND "aliadoId" IS NOT DISTINCT FROM $3
        AND "id" = (
          SELECT MAX(latest."id")
          FROM "VeriffIdentityValidation" latest
          WHERE latest."draftId" = $1
        )
        AND "creditoId" IS NULL
        AND "decidedAt" IS NULL
        AND "veriffSessionId" IS NOT NULL
        AND "createPayload" IS NOT NULL
        AND "status" NOT IN ('APPROVED', 'DECLINED', 'ERROR', 'EXPIRED', 'ABANDONED')
        AND "createdAt" >= NOW() - INTERVAL '24 hours'
      ORDER BY "id" DESC
      LIMIT 5
    `,
    input.draftId,
    input.sedeId,
    input.aliadoId || null
  );

  const requestedDocument = String(input.clienteDocumento || "").replace(/\D/g, "");

  return (
    rows.find((row) => {
      if (!extractVeriffSessionUrl(row.createPayload)) {
        return false;
      }

      const rowDocument = String(row.clienteDocumento || "").replace(/\D/g, "");
      return !requestedDocument || !rowDocument || rowDocument === requestedDocument;
    }) || null
  );
}

async function updateVeriffValidationRecord(
  database: VeriffQueryDatabase,
  id: number,
  input: UpdateInput
) {
  const rows = await database.$queryRawUnsafe<VeriffValidationRow[]>(
    `
      UPDATE "VeriffIdentityValidation"
      SET
        "veriffSessionId" = COALESCE($2, "veriffSessionId"),
        "attemptId" = COALESCE($3, "attemptId"),
        "status" = COALESCE($4, "status"),
        "decision" = COALESCE($5, "decision"),
        "code" = COALESCE($6, "code"),
        "reason" = COALESCE($7, "reason"),
        "reasonCode" = COALESCE($8, "reasonCode"),
        "createPayload" = COALESCE($9::jsonb, "createPayload"),
        "mediaPayload" = COALESCE($10::jsonb, "mediaPayload"),
        "submitPayload" = COALESCE($11::jsonb, "submitPayload"),
        "decisionPayload" = COALESCE($12::jsonb, "decisionPayload"),
        "webhookPayload" = CASE
          WHEN $17::boolean THEN NULL
          ELSE COALESCE($13::jsonb, "webhookPayload")
        END,
        "lastError" = $14,
        "submittedAt" = COALESCE($15, "submittedAt"),
        "decidedAt" = COALESCE($16, "decidedAt"),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
        AND "creditoId" IS NULL
      RETURNING *
    `,
    id,
    input.veriffSessionId || null,
    input.attemptId || null,
    input.status || null,
    input.decision || null,
    input.code || null,
    input.reason || null,
    input.reasonCode || null,
    jsonValue(input.createPayload),
    jsonValue(input.mediaPayload),
    jsonValue(input.submitPayload),
    jsonValue(input.decisionPayload),
    jsonValue(input.webhookPayload),
    input.lastError ?? null,
    input.submittedAt || null,
    input.decidedAt || null,
    input.clearWebhookPayload ?? false
  );

  return rows[0] || null;
}

export async function updateVeriffValidation(id: number, input: UpdateInput) {
  await ensureVeriffSchema();
  return updateVeriffValidationRecord(prisma, id, input);
}

export async function updateVeriffValidationFromDecision(
  id: number,
  payload: unknown,
  source: "decisionPayload" | "webhookPayload"
) {
  await ensureVeriffSchema();
  const summary = summarizeVeriffDecision(payload);
  const finalDecision = ["APPROVED", "DECLINED", "ERROR", "EXPIRED", "ABANDONED"].includes(
    summary.status
  );

  return prisma.$transaction(async (transaction) => {
    const currentRows = await transaction.$queryRawUnsafe<VeriffValidationRow[]>(
      `
        SELECT *
        FROM "VeriffIdentityValidation"
        WHERE "id" = $1
        LIMIT 1
        FOR UPDATE
      `,
      id
    );
    const current = currentRows[0] || null;
    if (!current) {
      return null;
    }

    const currentStatus = resolveVeriffRowStatus(current);
    const statusEvidence = resolveVeriffStatusEvidence([
      currentStatus,
      summary.status,
    ]);
    const preserveCanonicalStatus = shouldPreserveVeriffStatusTransition(
      currentStatus,
      summary.status,
      source
    );
    const resolvesActiveBlockWithCurrentDecision = Boolean(
      source === "decisionPayload" &&
        (currentStatus === "REVIEW" || currentStatus === "RESUBMISSION") &&
        summary.status === "APPROVED"
    );
    const incomingIdentity = compareDataCreditoVeriffIdentityEvidence(
      extractVeriffIdentityDocumentEvidence(payload),
      current.clienteDocumento
    );
    const incomingRisk = summarizeVeriffRisk(payload);
    const reviewRequired = Boolean(
      preserveCanonicalStatus ||
        (current.creditoId &&
          (statusEvidence.conflict ||
          (!incomingIdentity.ok && incomingIdentity.status !== "missing") ||
          incomingRisk.blocked))
    );
    const eventKey = buildVeriffEventKey(id, source, payload);
    const eventRows = await transaction.$queryRawUnsafe<Array<{ id: bigint }>>(
      `
        INSERT INTO "VeriffIdentityValidationEvent" (
          "validationId",
          "eventKey",
          "source",
          "status",
          "payload",
          "postLink",
          "reviewRequired"
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        ON CONFLICT ("eventKey") DO NOTHING
        RETURNING "id"
      `,
      id,
      eventKey,
      source,
      summary.status,
      jsonValue(payload),
      Boolean(current.creditoId),
      reviewRequired
    );

    if (!eventRows[0]) {
      return current;
    }

    if (current.creditoId || preserveCanonicalStatus) {
      if (!reviewRequired) {
        return current;
      }

      const reviewRows = await transaction.$queryRawUnsafe<VeriffValidationRow[]>(
        `
          UPDATE "VeriffIdentityValidation"
          SET "lastError" = $2,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1
          RETURNING *
        `,
        id,
        current.creditoId
          ? VERIFF_POST_LINK_REVIEW_ERROR
          : VERIFF_DECISION_ORDER_REVIEW_ERROR
      );
      return reviewRows[0] || current;
    }

    return updateVeriffValidationRecord(transaction, id, {
      attemptId: summary.attemptId,
      clearWebhookPayload: resolvesActiveBlockWithCurrentDecision,
      code: summary.code,
      decision: summary.decision,
      decidedAt: finalDecision ? toDate(summary.decidedAt) || new Date() : null,
      reason: summary.reason,
      reasonCode: summary.reasonCode,
      status: summary.status,
      [source]: payload,
    });
  });
}

export async function getVeriffValidationById(id: number) {
  await ensureVeriffSchema();

  const rows = await prisma.$queryRawUnsafe<VeriffValidationRow[]>(
    `SELECT * FROM "VeriffIdentityValidation" WHERE "id" = $1 LIMIT 1`,
    id
  );

  return rows[0] || null;
}

export async function getVeriffValidationBySessionId(sessionId: string) {
  await ensureVeriffSchema();

  const rows = await prisma.$queryRawUnsafe<VeriffValidationRow[]>(
    `SELECT * FROM "VeriffIdentityValidation" WHERE "veriffSessionId" = $1 LIMIT 1`,
    sessionId
  );

  return rows[0] || null;
}

export async function linkVeriffValidationToCredit(
  validationId: number,
  creditoId: number,
  database: Pick<Prisma.TransactionClient, "$queryRawUnsafe"> = prisma
) {
  await ensureVeriffSchema();

  const rows = await database.$queryRawUnsafe<VeriffValidationRow[]>(
    `
      UPDATE "VeriffIdentityValidation"
      SET "creditoId" = $2,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
        AND "creditoId" IS NULL
      RETURNING *
    `,
    validationId,
    creditoId
  );

  return rows[0] || null;
}

export function buildVeriffSnapshot(row: VeriffValidationRow | null) {
  if (!row) {
    return null;
  }

  const serialized = serializeVeriffValidation(row);

  return {
    proveedor: "Veriff",
    id: serialized?.id || row.id,
    sessionId: row.veriffSessionId,
    attemptId: row.attemptId,
    sessionUrl: extractVeriffSessionUrl(row.createPayload) || null,
    estado: serialized?.status || resolveVeriffRowStatus(row),
    decision: serialized?.decision || resolveVeriffRowStatus(row),
    code: row.code,
    reason: row.reason,
    reasonCode: row.reasonCode,
    identityData: serialized?.identityData || null,
    identityDocumentNumber: serialized?.identityDocumentNumber || null,
    identityDocumentStatus: serialized?.identityDocumentStatus || "missing",
    riskSignals: serialized?.riskSignals || null,
    riskBlocked: Boolean(serialized?.riskBlocked),
    checkedAt: row.decidedAt?.toISOString() || row.updatedAt?.toISOString() || null,
  };
}

export function veriffRowToJson(row: VeriffValidationRow | null) {
  return buildVeriffSnapshot(row) as Prisma.InputJsonValue | null;
}
