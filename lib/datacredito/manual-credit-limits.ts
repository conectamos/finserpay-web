import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import {
  ensureDataCreditoSchema,
  hmacDataCreditoValue,
  normalizeDataCreditoDocument,
} from "@/lib/datacredito/storage";

export const DATACREDITO_MANUAL_CREDIT_LIMIT_MAX = 100_000_000;
export const DATACREDITO_MANUAL_CREDIT_LIMIT_LIST_MAX = 200;

export type DataCreditoManualCreditLimit = {
  id: string;
  documentLast4: string;
  maxFinancedAmount: number;
  reason: string;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type DataCreditoManualCreditLimitStatus =
  | "ALL"
  | "ACTIVE"
  | "INACTIVE";

type ManualCreditLimitRow = DataCreditoManualCreditLimit & {
  documentHash: string;
};

type MutationReplayRow = DataCreditoManualCreditLimit & {
  requestHash: string;
  action: "CREATED" | "UPDATED" | "DEACTIVATED" | "REACTIVATED";
};

type MutationResult = {
  item: DataCreditoManualCreditLimit;
  idempotent: boolean;
  created: boolean;
};

export class DataCreditoManualCreditLimitValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues[0] || "Los datos del cupo manual no son válidos.");
    this.name = "DataCreditoManualCreditLimitValidationError";
    this.issues = issues;
  }
}

export class DataCreditoManualCreditLimitNotFoundError extends Error {
  constructor() {
    super("El cupo manual seleccionado no existe.");
    this.name = "DataCreditoManualCreditLimitNotFoundError";
  }
}

export class DataCreditoManualCreditLimitConflictError extends Error {
  readonly currentVersion: number | null;

  constructor(currentVersion: number | null) {
    super("El cupo manual fue modificado por otro usuario. Recarga antes de guardar.");
    this.name = "DataCreditoManualCreditLimitConflictError";
    this.currentVersion = currentVersion;
  }
}

export class DataCreditoManualCreditLimitMutationConflictError extends Error {
  constructor() {
    super("El identificador de la operación ya fue utilizado con otros datos.");
    this.name = "DataCreditoManualCreditLimitMutationConflictError";
  }
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

export function parseDataCreditoManualCreditLimitDocument(value: unknown) {
  const raw = String(value ?? "").trim();
  const documentNumber = normalizeDataCreditoDocument(raw);
  if (!/^\d{3,13}$/.test(raw) || documentNumber !== raw) {
    throw new DataCreditoManualCreditLimitValidationError([
      "La cédula debe contener entre 3 y 13 dígitos.",
    ]);
  }
  return documentNumber;
}

export function parseDataCreditoManualCreditLimitAmount(value: unknown) {
  const amount = Number(value);
  if (
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > DATACREDITO_MANUAL_CREDIT_LIMIT_MAX
  ) {
    throw new DataCreditoManualCreditLimitValidationError([
      "El cupo máximo debe ser un entero entre $1 y $100.000.000.",
    ]);
  }
  return amount;
}

export function parseDataCreditoManualCreditLimitReason(value: unknown) {
  const reason = String(value ?? "").replace(/\s+/g, " ").trim();
  if (reason.length < 5 || reason.length > 240) {
    throw new DataCreditoManualCreditLimitValidationError([
      "La razón es obligatoria y debe tener entre 5 y 240 caracteres.",
    ]);
  }
  return reason;
}

export function parseDataCreditoManualCreditLimitMutationId(value: unknown) {
  const mutationId = String(value ?? "").trim();
  if (!isUuid(mutationId)) {
    throw new DataCreditoManualCreditLimitValidationError([
      "mutationId debe ser un UUID válido.",
    ]);
  }
  return mutationId.toLowerCase();
}

export function parseDataCreditoManualCreditLimitId(value: unknown) {
  const id = String(value ?? "").trim();
  if (!isUuid(id)) {
    throw new DataCreditoManualCreditLimitValidationError([
      "El identificador del cupo manual no es válido.",
    ]);
  }
  return id.toLowerCase();
}

function parseExpectedVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new DataCreditoManualCreditLimitValidationError([
      "expectedVersion debe ser una versión válida.",
    ]);
  }
  return version;
}

function mapLimitRow(row: ManualCreditLimitRow): DataCreditoManualCreditLimit {
  return {
    id: row.id,
    documentLast4: row.documentLast4.trim(),
    maxFinancedAmount: row.maxFinancedAmount,
    reason: row.reason,
    active: row.active,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requestHash(parts: Array<string | number | boolean | null>) {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

async function lockMutation(
  transaction: Prisma.TransactionClient,
  mutationId: string
) {
  await transaction.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext($1)) AS "locked"`,
    `datacredito-manual-limit-mutation:${mutationId}`
  );
}

async function lockDocument(
  transaction: Prisma.TransactionClient,
  documentHash: string
) {
  await transaction.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext($1)) AS "locked"`,
    `datacredito-manual-limit-document:${documentHash}`
  );
}

async function findMutationReplay(
  transaction: Prisma.TransactionClient,
  mutationId: string,
  expectedRequestHash: string
) {
  const rows = await transaction.$queryRawUnsafe<MutationReplayRow[]>(
    `
      SELECT audit."manualLimitId" AS "id", audit."documentLast4",
        audit."maxFinancedAmount", audit."reason", audit."active",
        audit."version", manual_limit."createdAt",
        audit."createdAt" AS "updatedAt",
        audit."requestHash", audit."action"
      FROM "DataCreditoManualCreditLimitAudit" audit
      JOIN "DataCreditoManualCreditLimit" AS manual_limit
        ON manual_limit."id" = audit."manualLimitId"
      WHERE audit."mutationId" = $1
      LIMIT 1
    `,
    mutationId
  );
  const replay = rows[0];
  if (!replay) return null;
  if (replay.requestHash !== expectedRequestHash) {
    throw new DataCreditoManualCreditLimitMutationConflictError();
  }
  return {
    item: mapLimitRow({ ...replay, documentHash: "" }),
    created: replay.action === "CREATED",
  };
}

async function insertAudit(
  transaction: Prisma.TransactionClient,
  input: {
    mutationId: string;
    requestHash: string;
    action: "CREATED" | "UPDATED" | "DEACTIVATED" | "REACTIVATED";
    actorUserId: number;
    previous: ManualCreditLimitRow | null;
    current: ManualCreditLimitRow;
  }
) {
  await transaction.$executeRawUnsafe(
    `
      INSERT INTO "DataCreditoManualCreditLimitAudit" (
        "id", "manualLimitId", "mutationId", "requestHash", "action",
        "documentHash", "documentLast4", "previousMaxFinancedAmount",
        "maxFinancedAmount", "previousReason", "reason", "previousActive",
        "active", "previousVersion", "version", "actorUserId"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      )
    `,
    randomUUID(),
    input.current.id,
    input.mutationId,
    input.requestHash,
    input.action,
    input.current.documentHash,
    input.current.documentLast4,
    input.previous?.maxFinancedAmount ?? null,
    input.current.maxFinancedAmount,
    input.previous?.reason ?? null,
    input.current.reason,
    input.previous?.active ?? null,
    input.current.active,
    input.previous?.version ?? null,
    input.current.version,
    input.actorUserId
  );
}

export async function listDataCreditoManualCreditLimits(input: {
  documentNumber?: unknown;
  status?: DataCreditoManualCreditLimitStatus;
} = {}) {
  await ensureDataCreditoSchema();
  const documentNumber =
    input.documentNumber === undefined || input.documentNumber === null ||
    String(input.documentNumber).trim() === ""
      ? null
      : parseDataCreditoManualCreditLimitDocument(input.documentNumber);
  const documentHash = documentNumber
    ? hmacDataCreditoValue("document", documentNumber)
    : null;
  const status = input.status || "ALL";
  if (!(["ALL", "ACTIVE", "INACTIVE"] as const).includes(status)) {
    throw new DataCreditoManualCreditLimitValidationError([
      "El estado solicitado no es válido.",
    ]);
  }

  const rows = await prisma.$queryRawUnsafe<ManualCreditLimitRow[]>(
    `
      SELECT "id", "documentHash", "documentLast4", "maxFinancedAmount",
        "reason", "active", "version", "createdAt", "updatedAt"
      FROM "DataCreditoManualCreditLimit"
      WHERE ($1::text IS NULL OR "documentHash" = $1)
        AND ($2::text = 'ALL'
          OR ($2::text = 'ACTIVE' AND "active" = true)
          OR ($2::text = 'INACTIVE' AND "active" = false))
      ORDER BY "updatedAt" DESC, "id" DESC
      LIMIT ${DATACREDITO_MANUAL_CREDIT_LIMIT_LIST_MAX}
    `,
    documentHash,
    status
  );
  return rows.map(mapLimitRow);
}

export async function getActiveDataCreditoManualCreditLimit(
  documento: string
): Promise<DataCreditoManualCreditLimit | null> {
  const normalized = normalizeDataCreditoDocument(documento);
  if (!/^\d{3,13}$/.test(normalized)) return null;
  await ensureDataCreditoSchema();
  const documentHash = hmacDataCreditoValue("document", normalized);
  const rows = await prisma.$queryRawUnsafe<ManualCreditLimitRow[]>(
    `
      SELECT "id", "documentHash", "documentLast4", "maxFinancedAmount",
        "reason", "active", "version", "createdAt", "updatedAt"
      FROM "DataCreditoManualCreditLimit"
      WHERE "documentHash" = $1 AND "active" = true
      LIMIT 1
    `,
    documentHash
  );
  return rows[0] ? mapLimitRow(rows[0]) : null;
}

export async function resolveDataCreditoManualCreditLimit(input: {
  documento: string;
  policyMaxFinancedAmount: number;
}) {
  const policyMaxFinancedAmount = parseDataCreditoManualCreditLimitAmount(
    input.policyMaxFinancedAmount
  );
  const manualLimit = await getActiveDataCreditoManualCreditLimit(input.documento);
  return {
    source: manualLimit ? ("MANUAL_DOCUMENT" as const) : ("POLICY" as const),
    maxFinancedAmount:
      manualLimit?.maxFinancedAmount ?? policyMaxFinancedAmount,
    policyMaxFinancedAmount,
    manualLimit,
  };
}

export async function upsertDataCreditoManualCreditLimit(input: {
  documentNumber: unknown;
  maxFinancedAmount: unknown;
  reason: unknown;
  mutationId: unknown;
  actorUserId: number;
}): Promise<MutationResult> {
  await ensureDataCreditoSchema();
  const documentNumber = parseDataCreditoManualCreditLimitDocument(
    input.documentNumber
  );
  const documentHash = hmacDataCreditoValue("document", documentNumber);
  const documentLast4 = documentNumber.slice(-4);
  const maxFinancedAmount = parseDataCreditoManualCreditLimitAmount(
    input.maxFinancedAmount
  );
  const reason = parseDataCreditoManualCreditLimitReason(input.reason);
  const mutationId = parseDataCreditoManualCreditLimitMutationId(input.mutationId);
  const operationHash = requestHash([
    "UPSERT",
    documentHash,
    maxFinancedAmount,
    reason,
    true,
  ]);

  return prisma.$transaction(async (transaction) => {
    await lockMutation(transaction, mutationId);
    const replay = await findMutationReplay(
      transaction,
      mutationId,
      operationHash
    );
    if (replay) {
      return {
        item: replay.item,
        idempotent: true,
        created: replay.created,
      };
    }

    await lockDocument(transaction, documentHash);
    const existingRows = await transaction.$queryRawUnsafe<ManualCreditLimitRow[]>(
      `
        SELECT "id", "documentHash", "documentLast4", "maxFinancedAmount",
          "reason", "active", "version", "createdAt", "updatedAt"
        FROM "DataCreditoManualCreditLimit"
        WHERE "documentHash" = $1
        FOR UPDATE
      `,
      documentHash
    );
    const previous = existingRows[0] ?? null;
    let current: ManualCreditLimitRow;
    let action: "CREATED" | "UPDATED" | "REACTIVATED";

    if (!previous) {
      const id = randomUUID();
      const rows = await transaction.$queryRawUnsafe<ManualCreditLimitRow[]>(
        `
          INSERT INTO "DataCreditoManualCreditLimit" (
            "id", "documentHash", "documentLast4", "maxFinancedAmount",
            "reason", "active", "version", "createdByUserId", "updatedByUserId"
          ) VALUES ($1, $2, $3, $4, $5, true, 1, $6, $6)
          RETURNING "id", "documentHash", "documentLast4", "maxFinancedAmount",
            "reason", "active", "version", "createdAt", "updatedAt"
        `,
        id,
        documentHash,
        documentLast4,
        maxFinancedAmount,
        reason,
        input.actorUserId
      );
      current = rows[0];
      action = "CREATED";
    } else {
      const rows = await transaction.$queryRawUnsafe<ManualCreditLimitRow[]>(
        `
          UPDATE "DataCreditoManualCreditLimit"
          SET "maxFinancedAmount" = $2, "reason" = $3, "active" = true,
            "version" = "version" + 1, "updatedByUserId" = $4,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1
          RETURNING "id", "documentHash", "documentLast4", "maxFinancedAmount",
            "reason", "active", "version", "createdAt", "updatedAt"
        `,
        previous.id,
        maxFinancedAmount,
        reason,
        input.actorUserId
      );
      current = rows[0];
      action = previous.active ? "UPDATED" : "REACTIVATED";
    }

    await insertAudit(transaction, {
      mutationId,
      requestHash: operationHash,
      action,
      actorUserId: input.actorUserId,
      previous,
      current,
    });
    return {
      item: mapLimitRow(current),
      idempotent: false,
      created: !previous,
    };
  });
}

export async function updateDataCreditoManualCreditLimit(input: {
  id: unknown;
  maxFinancedAmount?: unknown;
  reason: unknown;
  active?: unknown;
  expectedVersion: unknown;
  mutationId: unknown;
  actorUserId: number;
}): Promise<MutationResult> {
  await ensureDataCreditoSchema();
  const id = parseDataCreditoManualCreditLimitId(input.id);
  const expectedVersion = parseExpectedVersion(input.expectedVersion);
  const maxFinancedAmount =
    input.maxFinancedAmount === undefined
      ? null
      : parseDataCreditoManualCreditLimitAmount(input.maxFinancedAmount);
  const reason = parseDataCreditoManualCreditLimitReason(input.reason);
  const active =
    input.active === undefined
      ? null
      : typeof input.active === "boolean"
        ? input.active
        : (() => {
            throw new DataCreditoManualCreditLimitValidationError([
              "active debe ser un valor booleano.",
            ]);
          })();
  const mutationId = parseDataCreditoManualCreditLimitMutationId(input.mutationId);
  const operationHash = requestHash([
    "PATCH",
    id,
    maxFinancedAmount,
    reason,
    active,
    expectedVersion,
  ]);

  return prisma.$transaction(async (transaction) => {
    await lockMutation(transaction, mutationId);
    const replay = await findMutationReplay(
      transaction,
      mutationId,
      operationHash
    );
    if (replay) {
      return {
        item: replay.item,
        idempotent: true,
        created: replay.created,
      };
    }

    const rows = await transaction.$queryRawUnsafe<ManualCreditLimitRow[]>(
      `
        SELECT "id", "documentHash", "documentLast4", "maxFinancedAmount",
          "reason", "active", "version", "createdAt", "updatedAt"
        FROM "DataCreditoManualCreditLimit"
        WHERE "id" = $1
        FOR UPDATE
      `,
      id
    );
    const previous = rows[0];
    if (!previous) throw new DataCreditoManualCreditLimitNotFoundError();
    if (previous.version !== expectedVersion) {
      throw new DataCreditoManualCreditLimitConflictError(previous.version);
    }

    const nextMaxFinancedAmount =
      maxFinancedAmount ?? previous.maxFinancedAmount;
    const nextActive = active ?? previous.active;
    const updated = await transaction.$queryRawUnsafe<ManualCreditLimitRow[]>(
      `
        UPDATE "DataCreditoManualCreditLimit"
        SET "maxFinancedAmount" = $2, "reason" = $3, "active" = $4,
          "version" = "version" + 1, "updatedByUserId" = $5,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "version" = $6
        RETURNING "id", "documentHash", "documentLast4", "maxFinancedAmount",
          "reason", "active", "version", "createdAt", "updatedAt"
      `,
      id,
      nextMaxFinancedAmount,
      reason,
      nextActive,
      input.actorUserId,
      expectedVersion
    );
    const current = updated[0];
    if (!current) {
      throw new DataCreditoManualCreditLimitConflictError(null);
    }
    const action =
      previous.active && !current.active
        ? ("DEACTIVATED" as const)
        : !previous.active && current.active
          ? ("REACTIVATED" as const)
          : ("UPDATED" as const);
    await insertAudit(transaction, {
      mutationId,
      requestHash: operationHash,
      action,
      actorUserId: input.actorUserId,
      previous,
      current,
    });
    return {
      item: mapLimitRow(current),
      idempotent: false,
      created: false,
    };
  });
}
