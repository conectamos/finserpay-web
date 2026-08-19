import "server-only";

import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import {
  ensureDataCreditoSchema,
  hmacDataCreditoValue,
  normalizeDataCreditoDocument,
  type DataCreditoAssessmentRow,
} from "@/lib/datacredito/storage";
import {
  decryptDataCreditoSecureRecord,
  type DecryptDataCreditoSecureRecordInput,
  type DataCreditoSecureRecordEnvelope,
} from "@/lib/datacredito/secure-record";

export const DATACREDITO_ADMIN_PAGE_SIZE = 25;
export const DATACREDITO_ADMIN_MAX_PAGE_SIZE = 50;

type AdminAssessmentRow = {
  id: string;
  documentLast4: string;
  platform: "ANDROID" | "IPHONE";
  providerEnvironment: string;
  status: string;
  score: number | null;
  decision: string | null;
  offer: Record<string, unknown> | null;
  policyVersion: number;
  consentAt: Date;
  userId: number;
  sellerId: number | null;
  sedeId: number;
  aliadoId: number | null;
  correlationId: string;
  transactionCode: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  durationMs: number | null;
  expiresAt: Date;
  consumedAt: Date | null;
  creditId: number | null;
  retainedUntil: Date;
  createdAt: Date;
  updatedAt: Date;
  userName: string | null;
  sellerName: string | null;
  sedeName: string | null;
  aliadoName: string | null;
};

type AdminAssessmentDetailRow = AdminAssessmentRow & {
  algorithm: string | null;
  keyId: string | null;
  aadVersion: number | null;
  plaintextVersion: number | null;
  nonce: Buffer | null;
  authTag: Buffer | null;
  ciphertext: Buffer | null;
  plaintextBytes: number | null;
};

export type DataCreditoAdminQueryFilters = {
  documentNumber?: string | null;
  status?: string | null;
  platform?: string | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  cursor?: string | null;
  limit?: number;
};

export type DataCreditoAdminAccessMetadata = {
  actorUserId: number;
  ipHash: string | null;
  userAgentHash: string | null;
  requestCorrelationId: string;
};

export type DataCreditoSecureRecordInput = {
  assessmentId: string;
  correlationId: string;
  envelope: DataCreditoSecureRecordEnvelope;
};

const ADMIN_COLUMNS = [
  'assessment."id"',
  'assessment."documentLast4"',
  'assessment."platform"',
  'assessment."providerEnvironment"',
  'assessment."status"',
  'assessment."score"',
  'assessment."decision"',
  'assessment."offer"',
  'assessment."policyVersion"',
  'assessment."consentAt"',
  'assessment."userId"',
  'assessment."sellerId"',
  'assessment."sedeId"',
  'assessment."aliadoId"',
  'assessment."correlationId"',
  'assessment."transactionCode"',
  'assessment."providerStatus"',
  'assessment."errorCode"',
  'assessment."durationMs"',
  'assessment."expiresAt"',
  'assessment."consumedAt"',
  'assessment."creditId"',
  'assessment."retainedUntil"',
  'assessment."createdAt"',
  'assessment."updatedAt"',
  'app_user."nombre" AS "userName"',
  'seller."nombre" AS "sellerName"',
  'site."nombre" AS "sedeName"',
  'ally."nombre" AS "aliadoName"',
].join(",\n");

const ADMIN_FROM = [
  'FROM "DataCreditoAssessment" assessment',
  'LEFT JOIN "Usuario" app_user ON app_user."id" = assessment."userId"',
  'LEFT JOIN "Vendedor" seller ON seller."id" = assessment."sellerId"',
  'LEFT JOIN "Sede" site ON site."id" = assessment."sedeId"',
  'LEFT JOIN "Aliado" ally ON ally."id" = assessment."aliadoId"',
].join("\n");

function iso(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function serializeOffer(value: Record<string, unknown> | null) {
  if (!value) return null;
  const initialPaymentPercentage = Number(value.initialPaymentPercentage);
  const suretyPercentage = Number(value.suretyPercentage);
  const maxFinancedAmount = Number(value.maxFinancedAmount);
  if (
    !Number.isFinite(initialPaymentPercentage) ||
    !Number.isFinite(suretyPercentage) ||
    !Number.isSafeInteger(maxFinancedAmount) ||
    maxFinancedAmount <= 0
  ) {
    return null;
  }
  return {
    initialPaymentPercentage,
    suretyPercentage,
    maxFinancedAmount,
  };
}

function serializeAdminAssessment(row: AdminAssessmentRow) {
  const score = finiteInteger(row.score);
  return {
    id: row.id,
    documentLabel:
      "•••• " + String(row.documentLast4 || "").padStart(4, "•"),
    platform: row.platform,
    providerEnvironment: row.providerEnvironment,
    status: row.status,
    score: score !== null && score >= -1 && score <= 950 ? score : null,
    decision: row.decision,
    offer: serializeOffer(row.offer),
    policyVersion: row.policyVersion,
    consentAt: iso(row.consentAt),
    actor: {
      userId: row.userId,
      userName: row.userName || "Usuario #" + row.userId,
      sellerId: row.sellerId,
      sellerName: row.sellerName,
      sedeId: row.sedeId,
      sedeName: row.sedeName || "Sede #" + row.sedeId,
      aliadoId: row.aliadoId,
      aliadoName: row.aliadoName,
    },
    correlationId: row.correlationId,
    transactionCode: row.transactionCode,
    providerStatus: row.providerStatus,
    errorCode: row.errorCode,
    durationMs: finiteInteger(row.durationMs),
    expiresAt: iso(row.expiresAt),
    consumedAt: iso(row.consumedAt),
    creditId: finiteInteger(row.creditId),
    retainedUntil: iso(row.retainedUntil),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function encodeCursor(row: Pick<AdminAssessmentRow, "createdAt" | "id">) {
  return Buffer.from(
    JSON.stringify({ createdAt: iso(row.createdAt), id: row.id }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(value: string | null | undefined) {
  if (!value) return { createdAt: null, id: null };
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as { createdAt?: unknown; id?: unknown };
    const createdAt = new Date(String(parsed.createdAt || ""));
    const id = String(parsed.id || "");
    if (
      Number.isNaN(createdAt.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id
      )
    ) {
      throw new Error("invalid-cursor");
    }
    return { createdAt, id };
  } catch {
    throw new Error("DATACREDITO_ADMIN_CURSOR_INVALID");
  }
}

function normalizedFilter(
  value: string | null | undefined,
  allowed: readonly string[]
) {
  const normalized = String(value || "").trim().toUpperCase();
  return allowed.includes(normalized) ? normalized : null;
}

export async function listDataCreditoAssessmentsForAdmin(
  filters: DataCreditoAdminQueryFilters
) {
  await ensureDataCreditoSchema();
  const normalizedDocument = normalizeDataCreditoDocument(
    filters.documentNumber
  );
  if (
    filters.documentNumber &&
    (normalizedDocument !== String(filters.documentNumber).trim() ||
      !/^\d{3,13}$/.test(normalizedDocument))
  ) {
    throw new Error("DATACREDITO_ADMIN_DOCUMENT_INVALID");
  }
  const documentHash = normalizedDocument
    ? hmacDataCreditoValue("document", normalizedDocument)
    : null;
  const status = normalizedFilter(filters.status, [
    "APROBADO",
    "RECHAZADO",
    "NO_EVALUADO",
    "PENDING",
  ]);
  const platform = normalizedFilter(filters.platform, ["ANDROID", "IPHONE"]);
  const cursor = decodeCursor(filters.cursor);
  const limit = Math.min(
    DATACREDITO_ADMIN_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(filters.limit) || DATACREDITO_ADMIN_PAGE_SIZE))
  );
  const sql = [
    "SELECT " + ADMIN_COLUMNS,
    ADMIN_FROM,
    'WHERE assessment."retainedUntil" > CURRENT_TIMESTAMP',
    'AND ($1::text IS NULL OR assessment."documentHash" = $1)',
    'AND ($2::text IS NULL OR assessment."status" = $2)',
    'AND ($3::text IS NULL OR assessment."platform" = $3)',
    'AND ($4::timestamp IS NULL OR assessment."createdAt" >= $4)',
    'AND ($5::timestamp IS NULL OR assessment."createdAt" < $5)',
    "AND ($6::timestamp IS NULL",
    '  OR assessment."createdAt" < $6',
    '  OR (assessment."createdAt" = $6 AND assessment."id" < $7::uuid))',
    'ORDER BY assessment."createdAt" DESC, assessment."id" DESC',
    "LIMIT $8",
  ].join("\n");
  const rows = await prisma.$queryRawUnsafe<AdminAssessmentRow[]>(
    sql,
    documentHash,
    status,
    platform,
    filters.dateFrom || null,
    filters.dateTo || null,
    cursor.createdAt,
    cursor.id,
    limit + 1
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(serializeAdminAssessment),
    nextCursor: hasMore && page.length ? encodeCursor(page.at(-1)!) : null,
  };
}

function secureEnvelopeFromRow(
  row: AdminAssessmentDetailRow
): Omit<
  DecryptDataCreditoSecureRecordInput,
  "assessmentId" | "correlationId"
> | null {
  if (
    !row.algorithm ||
    !row.keyId ||
    row.aadVersion === null ||
    row.plaintextVersion === null ||
    !row.nonce ||
    !row.authTag ||
    !row.ciphertext ||
    row.plaintextBytes === null
  ) {
    return null;
  }
  return {
    algorithm: row.algorithm,
    keyId: row.keyId,
    aadVersion: row.aadVersion,
    plaintextVersion: row.plaintextVersion,
    nonce: row.nonce,
    authTag: row.authTag,
    ciphertext: row.ciphertext,
    plaintextBytes: row.plaintextBytes,
  };
}

async function writeAdminAccessAudit(input: {
  detail: AdminAssessmentRow;
  metadata: DataCreditoAdminAccessMetadata;
  outcome: "GRANTED" | "HISTORIC_NO_PAYLOAD" | "DECRYPT_FAILED";
}) {
  const sql = [
    'INSERT INTO "DataCreditoAdminAccessAudit" (',
    '  "id", "assessmentId", "actorUserId", "action", "outcome",',
    '  "requestCorrelationId", "ipHash", "userAgentHash", "retainedUntil"',
    ") VALUES ($1, $2, $3, 'VIEW_DOSSIER', $4, $5, $6, $7, $8)",
  ].join("\n");
  await prisma.$executeRawUnsafe(
    sql,
    randomUUID(),
    input.detail.id,
    input.metadata.actorUserId,
    input.outcome,
    input.metadata.requestCorrelationId,
    input.metadata.ipHash,
    input.metadata.userAgentHash,
    input.detail.retainedUntil
  );
}

export async function getDataCreditoAssessmentDossierForAdmin(
  id: string,
  metadata: DataCreditoAdminAccessMetadata
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id
    )
  ) {
    return null;
  }
  await ensureDataCreditoSchema();
  const secureColumns = [
    'secure."algorithm"',
    'secure."keyId"',
    'secure."aadVersion"',
    'secure."plaintextVersion"',
    'secure."nonce"',
    'secure."authTag"',
    'secure."ciphertext"',
    'secure."plaintextBytes"',
  ].join(",\n");
  const sql = [
    "SELECT " + ADMIN_COLUMNS + ",\n" + secureColumns,
    ADMIN_FROM,
    'LEFT JOIN "DataCreditoAssessmentSecurePayload" secure',
    '  ON secure."assessmentId" = assessment."id"',
    'WHERE assessment."id" = $1',
    '  AND assessment."retainedUntil" > CURRENT_TIMESTAMP',
    "LIMIT 1",
  ].join("\n");
  const rows = await prisma.$queryRawUnsafe<AdminAssessmentDetailRow[]>(sql, id);
  const row = rows[0];
  if (!row) return null;
  const envelope = secureEnvelopeFromRow(row);
  if (!envelope) {
    await writeAdminAccessAudit({
      detail: row,
      metadata,
      outcome: "HISTORIC_NO_PAYLOAD",
    });
    return { assessment: serializeAdminAssessment(row), secureRecord: null };
  }
  try {
    const secureRecord = decryptDataCreditoSecureRecord({
      assessmentId: row.id,
      correlationId: row.correlationId,
      ...envelope,
    });
    await writeAdminAccessAudit({
      detail: row,
      metadata,
      outcome: "GRANTED",
    });
    return { assessment: serializeAdminAssessment(row), secureRecord };
  } catch {
    await writeAdminAccessAudit({
      detail: row,
      metadata,
      outcome: "DECRYPT_FAILED",
    });
    throw new Error("DATACREDITO_ADMIN_DOSSIER_UNAVAILABLE");
  }
}

async function upsertSecureRecord(
  database: Pick<typeof prisma, "$executeRawUnsafe">,
  input: DataCreditoSecureRecordInput
) {
  const value = input.envelope;
  const sql = [
    'INSERT INTO "DataCreditoAssessmentSecurePayload" (',
    '  "assessmentId", "algorithm", "keyId", "aadVersion",',
    '  "plaintextVersion", "nonce", "authTag", "ciphertext", "plaintextBytes"',
    ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    'ON CONFLICT ("assessmentId") DO UPDATE SET',
    '  "algorithm" = EXCLUDED."algorithm",',
    '  "keyId" = EXCLUDED."keyId",',
    '  "aadVersion" = EXCLUDED."aadVersion",',
    '  "plaintextVersion" = EXCLUDED."plaintextVersion",',
    '  "nonce" = EXCLUDED."nonce",',
    '  "authTag" = EXCLUDED."authTag",',
    '  "ciphertext" = EXCLUDED."ciphertext",',
    '  "plaintextBytes" = EXCLUDED."plaintextBytes"',
  ].join("\n");
  await database.$executeRawUnsafe(
    sql,
    input.assessmentId,
    value.algorithm,
    value.keyId,
    value.aadVersion,
    value.plaintextVersion,
    value.nonce,
    value.authTag,
    value.ciphertext,
    value.plaintextBytes
  );
}

export async function storePendingDataCreditoSecureRecord(
  input: DataCreditoSecureRecordInput
) {
  await ensureDataCreditoSchema();
  await upsertSecureRecord(prisma, input);
}

export async function completeDataCreditoAssessmentWithSecureRecord(input: {
  id: string;
  score: number;
  decision: "APROBADO" | "RECHAZADO";
  offer: Record<string, unknown>;
  transactionCode: string | null;
  providerStatus: string | null;
  durationMs: number | null;
  secure: DataCreditoSecureRecordInput;
}) {
  await ensureDataCreditoSchema();
  return prisma.$transaction(async (transaction) => {
    await upsertSecureRecord(transaction, input.secure);
    const sql = [
      'UPDATE "DataCreditoAssessment"',
      'SET "status" = $2, "score" = $3, "decision" = $2,',
      '    "offer" = $4::jsonb, "transactionCode" = $5,',
      '    "providerStatus" = $6, "durationMs" = $7,',
      '    "errorCode" = NULL, "updatedAt" = CURRENT_TIMESTAMP',
      'WHERE "id" = $1 AND "status" = \'PENDING\'',
      "RETURNING *",
    ].join("\n");
    const rows = await transaction.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
      sql,
      input.id,
      input.decision,
      input.score,
      JSON.stringify(input.offer),
      input.transactionCode,
      input.providerStatus,
      input.durationMs
    );
    if (!rows[0]) throw new Error("DATACREDITO_ASSESSMENT_COMPLETION_FAILED");
    return rows[0];
  });
}

export async function failDataCreditoAssessmentWithSecureRecord(input: {
  id: string;
  errorCode: string;
  transactionCode: string | null;
  providerStatus: string | null;
  durationMs: number | null;
  secure: DataCreditoSecureRecordInput;
}) {
  await ensureDataCreditoSchema();
  return prisma.$transaction(async (transaction) => {
    await upsertSecureRecord(transaction, input.secure);
    const sql = [
      'UPDATE "DataCreditoAssessment"',
      "SET \"status\" = 'NO_EVALUADO', \"errorCode\" = $2,",
      '    "transactionCode" = $3, "providerStatus" = $4,',
      '    "durationMs" = $5, "updatedAt" = CURRENT_TIMESTAMP',
      'WHERE "id" = $1 AND "status" = \'PENDING\'',
      "RETURNING *",
    ].join("\n");
    const rows = await transaction.$queryRawUnsafe<DataCreditoAssessmentRow[]>(
      sql,
      input.id,
      input.errorCode,
      input.transactionCode,
      input.providerStatus,
      input.durationMs
    );
    return rows[0] || null;
  });
}
