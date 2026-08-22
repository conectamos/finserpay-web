import "server-only";

import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { getCreditSettings } from "@/lib/credit-settings";
import {
  DEFAULT_DATACREDITO_POLICY_PROFILE_ID,
  ensureDataCreditoSchema,
  hmacDataCreditoValue,
  normalizeDataCreditoDocument,
  type DataCreditoAssessmentRow,
} from "@/lib/datacredito/storage";
import { isDataCreditoUniqueViolation } from "@/lib/datacredito/database-errors";
import {
  parseDataCreditoPolicyBands,
  parseDataCreditoPolicyFinancialSettings,
  type DataCreditoPolicyBand,
  type DataCreditoPolicyFinancialSettings,
} from "@/lib/datacredito/policy";
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
  reusedFromAssessmentId: string | null;
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
  secureAssessmentId: string | null;
  secureCorrelationId: string | null;
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
  'assessment."reusedFromAssessmentId"',
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
    financialSettings: parseDataCreditoPolicyFinancialSettings(
      value.financialSettings,
      { optional: true }
    ),
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
    reusedFromAssessmentId: row.reusedFromAssessmentId,
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
    "SELECT " + ADMIN_COLUMNS + ",\n" + secureColumns + ",",
    '  COALESCE(origin."id", assessment."id") AS "secureAssessmentId",',
    '  COALESCE(origin."correlationId", assessment."correlationId") AS "secureCorrelationId"',
    ADMIN_FROM,
    'LEFT JOIN "DataCreditoAssessment" origin',
    '  ON origin."id" = assessment."reusedFromAssessmentId"',
    'LEFT JOIN "DataCreditoAssessmentSecurePayload" secure',
    '  ON secure."assessmentId" = COALESCE(origin."id", assessment."id")',
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
      assessmentId: row.secureAssessmentId || row.id,
      correlationId: row.secureCorrelationId || row.correlationId,
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


type DataCreditoPolicyProfileCatalogRow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  revisionId: string | null;
  version: number | null;
  policy: unknown;
  revisionCreatedAt: Date | null;
  assignedAlliesCount: bigint;
};

type DataCreditoPolicyAllyCatalogRow = {
  id: number;
  name: string;
  code: string | null;
  active: boolean;
  policyId: string;
  policyName: string;
};

export class DataCreditoPolicyAssignmentConflictError extends Error {
  readonly currentPolicyId: string;

  constructor(currentPolicyId: string) {
    super("El aliado fue asignado a otra politica. Recarga antes de guardar.");
    this.name = "DataCreditoPolicyAssignmentConflictError";
    this.currentPolicyId = currentPolicyId;
  }
}

export class DataCreditoPolicyProfileNameConflictError extends Error {
  constructor() {
    super("Ya existe una politica con ese nombre.");
    this.name = "DataCreditoPolicyProfileNameConflictError";
  }
}

export class DataCreditoPolicyProfileNotFoundError extends Error {
  constructor() {
    super("La politica seleccionada no existe.");
    this.name = "DataCreditoPolicyProfileNotFoundError";
  }
}

function policyPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { bands: [], financialSettings: null };
  }
  const payload = value as Record<string, unknown>;
  return {
    bands: parseDataCreditoPolicyBands(payload.bands),
    financialSettings: parseDataCreditoPolicyFinancialSettings(
      payload.financialSettings,
      { optional: true }
    ),
  };
}

export async function listDataCreditoPolicyCatalog() {
  await ensureDataCreditoSchema();
  const [profileRows, allyRows, creditDefaults] = await Promise.all([
    prisma.$queryRawUnsafe<DataCreditoPolicyProfileCatalogRow[]>(`
      SELECT profile."id", profile."name", profile."description",
        profile."active", profile."createdAt", profile."updatedAt",
        revision."id" AS "revisionId", revision."version",
        revision."policy", revision."createdAt" AS "revisionCreatedAt",
        COUNT(ally."id")::bigint AS "assignedAlliesCount"
      FROM "DataCreditoPolicyProfile" profile
      LEFT JOIN LATERAL (
        SELECT candidate."id", candidate."version", candidate."policy",
          candidate."createdAt"
        FROM "DataCreditoPolicyRevision" candidate
        WHERE candidate."profileId" = profile."id"
        ORDER BY candidate."version" DESC
        LIMIT 1
      ) revision ON true
      LEFT JOIN "Aliado" ally ON ally."dataCreditoPolicyId" = profile."id"
      WHERE profile."active" = true
      GROUP BY profile."id", profile."name", profile."description",
        profile."active", profile."createdAt", profile."updatedAt",
        revision."id", revision."version", revision."policy", revision."createdAt"
      ORDER BY profile."name" ASC, profile."id" ASC
    `),
    prisma.$queryRawUnsafe<DataCreditoPolicyAllyCatalogRow[]>(`
      SELECT ally."id", ally."nombre" AS "name", ally."codigo" AS "code",
        ally."activo" AS "active", ally."dataCreditoPolicyId" AS "policyId",
        profile."name" AS "policyName"
      FROM "Aliado" ally
      INNER JOIN "DataCreditoPolicyProfile" profile
        ON profile."id" = ally."dataCreditoPolicyId"
      ORDER BY ally."nombre" ASC, ally."id" ASC
    `),
    getCreditSettings(),
  ]);

  return {
    defaultPolicyId: DEFAULT_DATACREDITO_POLICY_PROFILE_ID,
    financialDefaults: {
      calculoVersion: "ARES_FRANCES_V1" as const,
      tasaInteresEa: creditDefaults.tasaInteresEa,
      fianzaTotalPorcentaje: creditDefaults.fianzaTotalPorcentaje,
      seguroCuotaPorcentaje: creditDefaults.seguroCuotaPorcentaje,
      frecuenciaPago: creditDefaults.frecuenciaPago,
      tasaPeriodoDecimales: 6 as const,
      redondeoComercial: {
        modo: "PISO" as const,
        multiplo: 50 as const,
      },
    },
    profiles: profileRows.map((row) => {
      const payload = row.policy
        ? policyPayload(row.policy)
        : { bands: [], financialSettings: null };
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        active: row.active,
        version: row.version,
        bands: payload.bands,
        financialSettings: payload.financialSettings,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        revisionCreatedAt: iso(row.revisionCreatedAt),
        assignedAlliesCount: Number(row.assignedAlliesCount || 0),
      };
    }),
    allies: allyRows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code || "",
      active: row.active,
      policyId: row.policyId,
      policyName: row.policyName,
    })),
  };
}

export async function createDataCreditoPolicyProfile(input: {
  name: string;
  description: string | null;
  bands: DataCreditoPolicyBand[];
  financialSettings: DataCreditoPolicyFinancialSettings;
  actorUserId: number;
}) {
  await ensureDataCreditoSchema();
  const bands = parseDataCreditoPolicyBands(input.bands);
  const financialSettings = parseDataCreditoPolicyFinancialSettings(
    input.financialSettings
  )!;
  const profileId = randomUUID();
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `
          INSERT INTO "DataCreditoPolicyProfile" (
            "id", "name", "description", "active", "createdByUserId"
          ) VALUES ($1, $2, $3, true, $4)
        `,
        profileId,
        input.name,
        input.description,
        input.actorUserId
      );
      await transaction.$executeRawUnsafe(
        `
          INSERT INTO "DataCreditoPolicyRevision" (
            "id", "profileId", "version", "policy", "createdByUserId"
          ) VALUES ($1, $2, 1, $3::jsonb, $4)
        `,
        randomUUID(),
        profileId,
        JSON.stringify({ bands, financialSettings }),
        input.actorUserId
      );
    });
  } catch (error) {
    if (isDataCreditoUniqueViolation(error)) {
      throw new DataCreditoPolicyProfileNameConflictError();
    }
    throw error;
  }
  return profileId;
}

export async function assignDataCreditoPolicyToAlly(input: {
  allyId: number;
  policyId: string;
  expectedPolicyId: string;
  actorUserId: number;
}) {
  await ensureDataCreditoSchema();
  await prisma.$transaction(async (transaction) => {
    // Lock the destination profile before the ally. This serializes assignment
    // with any future lifecycle operation and prevents assigning a profile
    // that became inactive between validation and UPDATE.
    const profiles = await transaction.$queryRawUnsafe<
      Array<{ active: boolean; hasRevision: boolean }>
    >(
      `
        SELECT profile."active",
          EXISTS (
            SELECT 1 FROM "DataCreditoPolicyRevision" revision
            WHERE revision."profileId" = profile."id"
          ) AS "hasRevision"
        FROM "DataCreditoPolicyProfile" profile
        WHERE profile."id" = $1
        FOR UPDATE
      `,
      input.policyId
    );
    const profile = profiles[0];
    if (!profile) throw new DataCreditoPolicyProfileNotFoundError();
    if (!profile.active || !profile.hasRevision) {
      throw new Error("DATACREDITO_POLICY_NOT_ASSIGNABLE");
    }

    const allies = await transaction.$queryRawUnsafe<Array<{ policyId: string }>>(
      `
        SELECT "dataCreditoPolicyId" AS "policyId" FROM "Aliado"
        WHERE "id" = $1 FOR UPDATE
      `,
      input.allyId
    );
    const currentPolicyId = allies[0]?.policyId;
    if (!currentPolicyId) throw new Error("DATACREDITO_ALLY_NOT_FOUND");
    if (currentPolicyId !== input.expectedPolicyId) {
      throw new DataCreditoPolicyAssignmentConflictError(currentPolicyId);
    }
    if (currentPolicyId === input.policyId) return;
    await transaction.$executeRawUnsafe(
      `
        UPDATE "Aliado" SET "dataCreditoPolicyId" = $2,
          "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1
      `,
      input.allyId,
      input.policyId
    );
    await transaction.$executeRawUnsafe(
      `
        INSERT INTO "DataCreditoPolicyAssignmentAudit" (
          "id", "allyId", "previousPolicyId", "policyId", "actorUserId"
        ) VALUES ($1, $2, $3, $4, $5)
      `,
      randomUUID(),
      input.allyId,
      currentPolicyId,
      input.policyId,
      input.actorUserId
    );
  });
}
