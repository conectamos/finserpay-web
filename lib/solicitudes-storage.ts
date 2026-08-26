import { createHash } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ensureDataCreditoSchema } from "@/lib/datacredito/storage";
import { ensureFirmaSeguroSchema } from "@/lib/firmaseguro-storage";
import { ensureVeriffSchema } from "@/lib/veriff-storage";
import {
  SOLICITUD_STATE_LABELS,
  SOLICITUD_STATES,
  canSeeSensitiveSolicitudData,
  getSolicitudActions,
  maskDocument,
  maskImei,
  resolveSolicitudDeliveryStage,
  resolveSolicitudStage,
  type SolicitudFilters,
  type SolicitudOwnership,
  type SolicitudState,
  type SolicitudViewer,
} from "@/lib/solicitudes";

type Database = typeof prisma | Prisma.TransactionClient;

type SolicitudRow = {
  source: "DRAFT" | "CREDIT";
  entityId: number;
  numero: string;
  rawState: string;
  closedReason: string | null;
  currentStep: number | null;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  aliadoId: number | null;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  imei: string | null;
  plataforma: string | null;
  createdAt: Date | string;
  finalizedAt: Date | string | null;
  updatedAt: Date | string;
  closedAt: Date | string | null;
  expiresAt: Date | string | null;
  usuarioNombre: string | null;
  vendedorNombre: string | null;
  sedeNombre: string | null;
  aliadoNombre: string | null;
  dataCreditoStatus: string | null;
  dataCreditoErrorCode: string | null;
  dataCreditoUpdatedAt: Date | string | null;
  veriffStatus: string | null;
  veriffUpdatedAt: Date | string | null;
  firmaStatus: string | null;
  firmaLastError: string | null;
  firmaUpdatedAt: Date | string | null;
  deliverableReady: boolean | null;
  hasDeliveryEvidence: boolean | null;
};

export type SaveSolicitudDraftInput = {
  id?: number | null;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  currentStep: number;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  imei: string | null;
  plataforma: string | null;
  dataCreditoAssessmentId?: string | null;
  payload: Record<string, unknown>;
};

export type SolicitudListItem = ReturnType<typeof serializeSolicitudRow>;

export class ActiveSolicitudConflictError extends Error {
  readonly code = "SOLICITUD_ACTIVA_EXISTENTE";
  readonly status = 409;

  constructor() {
    super(
      "Ya existe una solicitud en proceso. El asesor titular debe retomarla o desistirla antes de iniciar otra."
    );
    this.name = "ActiveSolicitudConflictError";
  }
}

let solicitudSchemaPromise: Promise<void> | null = null;

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function normalizeDigits(value: unknown) {
  return String(value || "").replace(/\D/g, "").slice(0, 40);
}

function normalizePlatform(value: unknown) {
  const platform = String(value || "").trim().toUpperCase();
  return platform === "ANDROID" || platform === "IPHONE" ? platform : null;
}

function lockDigest(kind: "document" | "imei", value: string) {
  return createHash("sha256").update(`${kind}:${value}`).digest("hex");
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function latestIso(...values: Array<Date | string | null | undefined>) {
  const dates = values
    .map((value) => (value ? new Date(value) : null))
    .filter((value): value is Date => Boolean(value && !Number.isNaN(value.getTime())));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((value) => value.getTime()))).toISOString();
}

export async function ensureSolicitudSchema() {
  if (!solicitudSchemaPromise) {
    solicitudSchemaPromise = (async () => {
      if (process.env.NODE_ENV === "production") {
        const rows = await prisma.$queryRawUnsafe<Array<{ columnName: string }>>(`
          SELECT column_name AS "columnName"
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'CreditoBorrador'
        `);
        const present = new Set(rows.map((row) => row.columnName));
        const required = [
          "id",
          "estado",
          "usuarioId",
          "vendedorId",
          "sedeId",
          "currentStep",
          "clienteNombre",
          "clienteDocumento",
          "clienteTelefono",
          "imei",
          "plataforma",
          "dataCreditoAssessmentId",
          "creditoId",
          "closedReason",
          "payload",
          "createdAt",
          "updatedAt",
          "closedAt",
          "expiresAt",
          "desistedByUserId",
          "desistedBySellerId",
        ];
        if (required.some((column) => !present.has(column))) {
          throw new Error("SOLICITUD_SCHEMA_NOT_READY");
        }
        return;
      }

      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "CreditoBorrador" (
          "id" SERIAL PRIMARY KEY,
          "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
          "usuarioId" INTEGER NOT NULL,
          "vendedorId" INTEGER,
          "sedeId" INTEGER NOT NULL,
          "currentStep" INTEGER NOT NULL DEFAULT 1,
          "clienteNombre" TEXT,
          "clienteDocumento" TEXT,
          "clienteTelefono" TEXT,
          "imei" TEXT,
          "plataforma" TEXT,
          "dataCreditoAssessmentId" UUID,
          "creditoId" INTEGER,
          "closedReason" TEXT,
          "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "closedAt" TIMESTAMPTZ,
          "expiresAt" TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 days'),
          "desistedByUserId" INTEGER,
          "desistedBySellerId" INTEGER
        )
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "CreditoBorrador"
          ADD COLUMN IF NOT EXISTS "plataforma" TEXT,
          ADD COLUMN IF NOT EXISTS "dataCreditoAssessmentId" UUID,
          ADD COLUMN IF NOT EXISTS "creditoId" INTEGER,
          ADD COLUMN IF NOT EXISTS "closedReason" TEXT,
          ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS "desistedByUserId" INTEGER,
          ADD COLUMN IF NOT EXISTS "desistedBySellerId" INTEGER
      `);
      await prisma.$executeRawUnsafe(`
        UPDATE "CreditoBorrador"
        SET "expiresAt" = "createdAt" + INTERVAL '15 days'
        WHERE "estado" = 'ABIERTO' AND "expiresAt" IS NULL
      `);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "CreditoBorrador_expiresAt_idx" ON "CreditoBorrador" ("expiresAt")`
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "CreditoBorrador_assessment_idx" ON "CreditoBorrador" ("dataCreditoAssessmentId")`
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "CreditoBorrador_credito_idx" ON "CreditoBorrador" ("creditoId")`
      );
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "CreditoBorrador_active_document_idx"
        ON "CreditoBorrador" ((regexp_replace(COALESCE("clienteDocumento", ''), '[^0-9]', '', 'g')))
        WHERE "estado" = 'ABIERTO'
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "CreditoBorrador_active_imei_idx"
        ON "CreditoBorrador" ((regexp_replace(COALESCE("imei", ''), '[^0-9]', '', 'g')))
        WHERE "estado" = 'ABIERTO'
      `);
    })().catch((error) => {
      solicitudSchemaPromise = null;
      throw error;
    });
  }
  await solicitudSchemaPromise;
}

async function expireStaleWith(database: Database) {
  await database.$executeRawUnsafe(`
    UPDATE "CreditoBorrador"
    SET "estado" = 'CERRADO',
        "closedReason" = COALESCE("closedReason", 'EXPIRADA_15_DIAS'),
        "closedAt" = COALESCE("closedAt", CURRENT_TIMESTAMP),
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "estado" = 'ABIERTO'
      AND COALESCE("expiresAt", "createdAt" + INTERVAL '15 days') <= CURRENT_TIMESTAMP
  `);
}

export async function expireStaleSolicitudes() {
  await ensureSolicitudSchema();
  await expireStaleWith(prisma);
}

export type ActiveSolicitudCreditContext = {
  id: number;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  aliadoId: number | null;
  clienteDocumento: string | null;
  dataCreditoAssessmentId: string | null;
};

export async function getActiveSolicitudCreditContext(
  solicitudId: number
) {
  await ensureSolicitudSchema();
  await expireStaleSolicitudes();
  const rows = await prisma.$queryRawUnsafe<ActiveSolicitudCreditContext[]>(
    `
      SELECT d."id", d."usuarioId", d."vendedorId", d."sedeId",
        s."aliadoId", d."clienteDocumento",
        COALESCE(
          d."dataCreditoAssessmentId"::text,
          NULLIF(d."payload"->>'dataCreditoAssessmentId', '')
        ) AS "dataCreditoAssessmentId"
      FROM "CreditoBorrador" d
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      WHERE d."id" = $1
        AND d."estado" = 'ABIERTO'
        AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
      LIMIT 1
    `,
    solicitudId
  );
  return rows[0] || null;
}

function sameOwner(
  row: { usuarioId: number; vendedorId: number | null; sedeId: number },
  input: { usuarioId: number; vendedorId: number | null; sedeId: number }
) {
  if (input.vendedorId) {
    return row.vendedorId === input.vendedorId && row.sedeId === input.sedeId;
  }
  return (
    row.vendedorId === null &&
    row.usuarioId === input.usuarioId &&
    row.sedeId === input.sedeId
  );
}

async function lockIdentity(database: Database, kind: "document" | "imei", value: string) {
  if (!value) return;
  await database.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`,
    `solicitud:${lockDigest(kind, value)}`
  );
}

type ActiveDraftOwnerRow = {
  id: number;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
};

async function findActiveByIdentity(
  database: Database,
  document: string,
  imei: string,
  excludedId?: number | null
) {
  const rows = await database.$queryRawUnsafe<ActiveDraftOwnerRow[]>(
    `
      SELECT "id", "usuarioId", "vendedorId", "sedeId"
      FROM "CreditoBorrador"
      WHERE "estado" = 'ABIERTO'
        AND COALESCE("expiresAt", "createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
        AND (
          "dataCreditoAssessmentId" IS NOT NULL
          OR UPPER(COALESCE("payload"->>'solicitudOrigen', '')) = 'DATACREDITO'
          OR NULLIF("payload"->>'dataCreditoStatus', '') IS NOT NULL
          OR NULLIF("payload"->>'dataCreditoAssessmentId', '') IS NOT NULL
        )
        AND ($3::integer IS NULL OR "id" <> $3)
        AND (
          ($1 <> '' AND regexp_replace(COALESCE("clienteDocumento", ''), '[^0-9]', '', 'g') = $1)
          OR ($2 <> '' AND regexp_replace(COALESCE("imei", ''), '[^0-9]', '', 'g') = $2)
        )
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE
    `,
    document,
    imei,
    excludedId || null
  );
  return rows[0] || null;
}

export async function reserveSolicitudForIdentity(input: {
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  clienteDocumento: string;
  plataforma?: string | null;
}) {
  await ensureSolicitudSchema();
  const document = normalizeDigits(input.clienteDocumento);
  if (document.length < 5) throw new Error("DOCUMENTO_SOLICITUD_INVALIDO");

  return prisma.$transaction(async (transaction) => {
    await lockIdentity(transaction, "document", document);
    await expireStaleWith(transaction);
    const active = await findActiveByIdentity(transaction, document, "");
    if (active) {
      if (!sameOwner(active, input)) throw new ActiveSolicitudConflictError();
      await transaction.$executeRawUnsafe(
        `
          UPDATE "CreditoBorrador"
          SET "plataforma" = COALESCE($2, "plataforma"),
              "payload" = COALESCE("payload", '{}'::jsonb) || jsonb_build_object(
                'solicitudOrigen', 'DATACREDITO',
                'dataCreditoStatus', 'PENDING',
                'dataCreditoErrorCode', NULL,
                'dataCreditoUpdatedAt', CURRENT_TIMESTAMP
              ),
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1 AND "estado" = 'ABIERTO'
        `,
        active.id,
        normalizePlatform(input.plataforma)
      );
      return { id: active.id, reused: true };
    }

    const rows = await transaction.$queryRawUnsafe<Array<{ id: number }>>(
      `
        INSERT INTO "CreditoBorrador" (
          "usuarioId", "vendedorId", "sedeId", "currentStep",
          "clienteDocumento", "plataforma", "payload", "expiresAt", "updatedAt"
        )
        VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, CURRENT_TIMESTAMP + INTERVAL '15 days', CURRENT_TIMESTAMP)
        RETURNING "id"
      `,
      input.usuarioId,
      input.vendedorId,
      input.sedeId,
      input.clienteDocumento.trim(),
      normalizePlatform(input.plataforma),
      JSON.stringify({
        clienteDocumento: input.clienteDocumento.trim(),
        plataformaDispositivo: normalizePlatform(input.plataforma),
        solicitudOrigen: "DATACREDITO",
        dataCreditoStatus: "PENDING",
        dataCreditoErrorCode: null,
        dataCreditoUpdatedAt: new Date().toISOString(),
      })
    );
    if (!rows[0]) throw new Error("SOLICITUD_RESERVATION_FAILED");
    return { id: rows[0].id, reused: false };
  });
}

export async function saveSolicitudDraft(input: SaveSolicitudDraftInput) {
  await ensureSolicitudSchema();
  const document = normalizeDigits(input.clienteDocumento);
  const imei = normalizeDigits(input.imei);
  const assessmentId = isUuid(input.dataCreditoAssessmentId)
    ? String(input.dataCreditoAssessmentId)
    : null;

  return prisma.$transaction(async (transaction) => {
    if (document) await lockIdentity(transaction, "document", document);
    if (imei) await lockIdentity(transaction, "imei", imei);
    await expireStaleWith(transaction);

    let targetId = input.id || null;
    if (targetId) {
      const rows = await transaction.$queryRawUnsafe<ActiveDraftOwnerRow[]>(
        `
          SELECT "id", "usuarioId", "vendedorId", "sedeId"
          FROM "CreditoBorrador"
          WHERE "id" = $1 AND "estado" = 'ABIERTO'
            AND COALESCE("expiresAt", "createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
          LIMIT 1 FOR UPDATE
        `,
        targetId
      );
      if (!rows[0] || !sameOwner(rows[0], input)) throw new Error("SOLICITUD_NO_AUTORIZADA");
    }

    if (document || imei) {
      const conflicting = await findActiveByIdentity(
        transaction,
        document,
        imei,
        targetId
      );
      if (conflicting) {
        if (!sameOwner(conflicting, input) || targetId) {
          throw new ActiveSolicitudConflictError();
        }
        targetId = conflicting.id;
      }
    }

    const payloadJson = JSON.stringify(input.payload);
    if (targetId) {
      const updated = await transaction.$queryRawUnsafe<Array<{ id: number }>>(
        `
          UPDATE "CreditoBorrador"
          SET "currentStep" = $2,
              "clienteNombre" = $3,
              "clienteDocumento" = $4,
              "clienteTelefono" = $5,
              "imei" = $6,
              "plataforma" = COALESCE($7, "plataforma"),
              "dataCreditoAssessmentId" = COALESCE($8::uuid, "dataCreditoAssessmentId"),
              "payload" = $9::jsonb,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1 AND "estado" = 'ABIERTO'
          RETURNING "id"
        `,
        targetId,
        input.currentStep,
        input.clienteNombre,
        input.clienteDocumento,
        input.clienteTelefono,
        input.imei,
        normalizePlatform(input.plataforma),
        assessmentId,
        payloadJson
      );
      if (!updated[0]) throw new Error("SOLICITUD_NO_DISPONIBLE");
      return { id: updated[0].id, created: false };
    }

    // A draft is materialized only when DataCredito reserves the identity.
    // Autosave may update that canonical row (by id or by the same document),
    // but it must never create anonymous/pre-consultation wall entries.
    throw new Error("SOLICITUD_REQUIERE_CONSULTA_DATACREDITO");
  });
}

export async function attachDataCreditoToSolicitud(input: {
  solicitudId: number;
  assessmentId: string;
  status: string;
  errorCode?: string | null;
  plataforma?: string | null;
}) {
  if (!isUuid(input.assessmentId)) return;
  await ensureSolicitudSchema();
  const status = String(input.status || "PENDING")
    .trim()
    .toUpperCase()
    .slice(0, 40);
  const errorCode = input.errorCode
    ? String(input.errorCode).trim().toUpperCase().slice(0, 80)
    : null;
  const rejected = status === "RECHAZADO";
  await prisma.$executeRawUnsafe(
    `
      UPDATE "CreditoBorrador"
      SET "dataCreditoAssessmentId" = $2::uuid,
          "plataforma" = COALESCE($3, "plataforma"),
          "payload" = COALESCE("payload", '{}'::jsonb) || jsonb_build_object(
            'solicitudOrigen', 'DATACREDITO',
            'dataCreditoAssessmentId', $2::text,
            'dataCreditoStatus', $5::text,
            'dataCreditoErrorCode', $6::text,
            'dataCreditoUpdatedAt', CURRENT_TIMESTAMP
          ),
          "estado" = CASE WHEN $4::boolean THEN 'CERRADO' ELSE "estado" END,
          "closedReason" = CASE WHEN $4::boolean THEN 'RECHAZADA' ELSE "closedReason" END,
          "closedAt" = CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP ELSE "closedAt" END,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1
    `,
    input.solicitudId,
    input.assessmentId,
    normalizePlatform(input.plataforma),
    rejected,
    status,
    errorCode
  );
}

export async function markSolicitudDataCreditoTechnicalError(input: {
  solicitudId: number;
  errorCode: string;
  plataforma?: string | null;
}) {
  await ensureSolicitudSchema();
  const errorCode = String(input.errorCode || "EVALUATION_ERROR")
    .trim()
    .toUpperCase()
    .slice(0, 80);
  await prisma.$executeRawUnsafe(
    `
      UPDATE "CreditoBorrador"
      SET "plataforma" = COALESCE($2, "plataforma"),
          "payload" = COALESCE("payload", '{}'::jsonb) || jsonb_build_object(
            'solicitudOrigen', 'DATACREDITO',
            'dataCreditoStatus', 'NO_EVALUADO',
            'dataCreditoErrorCode', $3::text,
            'dataCreditoUpdatedAt', CURRENT_TIMESTAMP
          ),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "estado" = 'ABIERTO'
    `,
    input.solicitudId,
    normalizePlatform(input.plataforma),
    errorCode
  );
}

export async function desistSolicitud(input: {
  solicitudId: number;
  userId: number;
  sellerId: number;
  sedeId: number;
}) {
  await ensureSolicitudSchema();
  await expireStaleSolicitudes();
  const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `
      UPDATE "CreditoBorrador"
      SET "estado" = 'CERRADO', "closedReason" = 'DESISTIDA',
          "closedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP,
          "desistedByUserId" = $2, "desistedBySellerId" = $3
      WHERE "id" = $1 AND "estado" = 'ABIERTO'
        AND "vendedorId" = $3 AND "sedeId" = $4
      RETURNING "id"
    `,
    input.solicitudId,
    input.userId,
    input.sellerId,
    input.sedeId
  );
  return Boolean(rows[0]);
}

export async function completeSolicitudForCredit(
  input: {
    solicitudId?: number | null;
    assessmentId?: string | null;
    clienteDocumento?: string | null;
    usuarioId: number;
    vendedorId: number | null;
    sedeId: number;
    creditoId: number;
  },
  database: Database
) {
  const document = normalizeDigits(input.clienteDocumento);
  const assessmentId = isUuid(input.assessmentId) ? String(input.assessmentId) : null;
  const rows = await database.$queryRawUnsafe<Array<{ id: number }>>(
    `
      UPDATE "CreditoBorrador"
      SET "estado" = 'CERRADO', "closedReason" = 'FINALIZADA',
          "creditoId" = $7, "closedAt" = COALESCE("closedAt", CURRENT_TIMESTAMP),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "estado" = 'ABIERTO'
        AND "usuarioId" = $4
        AND "vendedorId" IS NOT DISTINCT FROM $5
        AND "sedeId" = $6
        AND (
          ($1::integer IS NOT NULL AND "id" = $1)
          OR ($2::uuid IS NOT NULL AND "dataCreditoAssessmentId" = $2::uuid)
          OR ($3 <> '' AND regexp_replace(COALESCE("clienteDocumento", ''), '[^0-9]', '', 'g') = $3)
        )
      RETURNING "id"
    `,
    input.solicitudId || null,
    assessmentId,
    document,
    input.usuarioId,
    input.vendedorId,
    input.sedeId,
    input.creditoId
  );
  return rows[0]?.id || null;
}

function addWhere(
  conditions: string[],
  values: unknown[],
  expression: string,
  value: unknown
) {
  values.push(value);
  conditions.push(`${expression} $${values.length}`);
}

function bogotaBoundary(date: string, end: boolean) {
  if (!date) return null;
  const boundary = new Date(`${date}T05:00:00.000Z`);
  if (end) boundary.setUTCDate(boundary.getUTCDate() + 1);
  return boundary;
}

function parseCompositeId(value: string) {
  const match = /^(D|C)-(\d+)$/.exec(value.toUpperCase());
  if (!match) return null;
  return { source: match[1] === "D" ? "DRAFT" : "CREDIT", id: Number(match[2]) } as const;
}

function buildCommonWhere(input: {
  alias: "d" | "c";
  source: "DRAFT" | "CREDIT";
  viewer: SolicitudViewer;
  filters: SolicitudFilters;
  platformExpression: string;
  numberExpression: string;
  createdAtExpression: string;
}) {
  const { alias, viewer, filters } = input;
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (viewer.kind !== "CENTRAL_ADMIN") {
    if (!viewer.aliadoId) conditions.push("FALSE");
    else addWhere(conditions, values, `s."aliadoId" =`, viewer.aliadoId);
  }
  if (viewer.kind === "SUPERVISOR" || viewer.kind === "SELLER") {
    if (!viewer.sedeId) conditions.push("FALSE");
    else addWhere(conditions, values, `${alias}."sedeId" =`, viewer.sedeId);
  }
  if (viewer.kind === "SELLER") {
    if (!viewer.vendedorId) conditions.push("FALSE");
    else addWhere(conditions, values, `${alias}."vendedorId" =`, viewer.vendedorId);
  }

  if (filters.aliadoId) addWhere(conditions, values, `s."aliadoId" =`, filters.aliadoId);
  if (filters.sedeId) addWhere(conditions, values, `${alias}."sedeId" =`, filters.sedeId);
  if (filters.asesorId) addWhere(conditions, values, `${alias}."vendedorId" =`, filters.asesorId);
  if (filters.plataforma) {
    addWhere(conditions, values, `UPPER(COALESCE(${input.platformExpression}, '')) =`, filters.plataforma);
  }
  const start = bogotaBoundary(filters.desde, false);
  const end = bogotaBoundary(filters.hasta, true);
  if (start) addWhere(conditions, values, `${input.createdAtExpression} >=`, start);
  if (end) addWhere(conditions, values, `${input.createdAtExpression} <`, end);

  const compositeId = parseCompositeId(filters.id);
  if (filters.id) {
    if (!compositeId || compositeId.source !== input.source) conditions.push("FALSE");
    else addWhere(conditions, values, `${alias}."id" =`, compositeId.id);
  }

  if (filters.q) {
    values.push(`%${filters.q}%`);
    const index = values.length;
    conditions.push(`(
      COALESCE(${alias}."clienteNombre", '') ILIKE $${index}
      OR COALESCE(${alias}."clienteDocumento", '') ILIKE $${index}
      OR COALESCE(${alias}."imei", '') ILIKE $${index}
      OR COALESCE(${input.numberExpression}, '') ILIKE $${index}
    )`);
  }

  return { conditions, values };
}

async function readDraftRows(viewer: SolicitudViewer, filters: SolicitudFilters) {
  const platform = `COALESCE(NULLIF(d."plataforma", ''), NULLIF(d."payload"->>'plataformaDispositivo', ''), dc."platform")`;
  const where = buildCommonWhere({
    alias: "d",
    source: "DRAFT",
    viewer,
    filters,
    platformExpression: platform,
    numberExpression: `'SOL-' || LPAD(d."id"::text, 6, '0')`,
    createdAtExpression: `d."createdAt"`,
  });
  where.conditions.unshift(`
    d."creditoId" IS NULL
    AND COALESCE(dc."status", NULLIF(d."payload"->>'dataCreditoStatus', '')) IS NOT NULL
    AND (
      d."estado" = 'ABIERTO'
      OR d."closedReason" IN ('DESISTIDA', 'EXPIRADA_15_DIAS', 'RECHAZADA')
    )
  `);

  return prisma.$queryRawUnsafe<SolicitudRow[]>(
    `
      SELECT 'DRAFT'::text AS "source", d."id" AS "entityId",
        ('SOL-' || LPAD(d."id"::text, 6, '0')) AS "numero",
        d."estado" AS "rawState", d."closedReason", d."currentStep",
        d."usuarioId", d."vendedorId", d."sedeId", s."aliadoId",
        d."clienteNombre", d."clienteDocumento", d."imei", ${platform} AS "plataforma",
        d."createdAt", NULL::timestamptz AS "finalizedAt",
        d."updatedAt", d."closedAt", d."expiresAt",
        u."nombre" AS "usuarioNombre", v."nombre" AS "vendedorNombre",
        s."nombre" AS "sedeNombre", a."nombre" AS "aliadoNombre",
        COALESCE(dc."status", NULLIF(d."payload"->>'dataCreditoStatus', '')) AS "dataCreditoStatus",
        COALESCE(dc."errorCode", NULLIF(d."payload"->>'dataCreditoErrorCode', '')) AS "dataCreditoErrorCode",
        COALESCE(dc."updatedAt", d."updatedAt") AS "dataCreditoUpdatedAt",
        veriff."status" AS "veriffStatus", veriff."updatedAt" AS "veriffUpdatedAt",
        firma."status" AS "firmaStatus", firma."lastError" AS "firmaLastError",
        firma."updatedAt" AS "firmaUpdatedAt",
        NULL::boolean AS "deliverableReady", NULL::boolean AS "hasDeliveryEvidence"
      FROM "CreditoBorrador" d
      LEFT JOIN "Usuario" u ON u."id" = d."usuarioId"
      LEFT JOIN "Vendedor" v ON v."id" = d."vendedorId"
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      LEFT JOIN "Aliado" a ON a."id" = s."aliadoId"
      LEFT JOIN LATERAL (
        SELECT assessment."status", assessment."errorCode", assessment."platform", assessment."updatedAt"
        FROM "DataCreditoAssessment" assessment
        WHERE assessment."id"::text = COALESCE(
          d."dataCreditoAssessmentId"::text,
          NULLIF(d."payload"->>'dataCreditoAssessmentId', '')
        )
        ORDER BY assessment."updatedAt" DESC LIMIT 1
      ) dc ON TRUE
      LEFT JOIN LATERAL (
        SELECT validation."status", validation."updatedAt"
        FROM "VeriffIdentityValidation" validation
        WHERE validation."draftId" = d."id"
        ORDER BY validation."updatedAt" DESC LIMIT 1
      ) veriff ON TRUE
      LEFT JOIN LATERAL (
        SELECT process."status", process."lastError", process."updatedAt"
        FROM "FirmaSeguroProcess" process
        WHERE process."draftId" = d."id"
        ORDER BY process."updatedAt" DESC LIMIT 1
      ) firma ON TRUE
      WHERE ${where.conditions.join(" AND ")}
    `,
    ...where.values
  );
}

async function readCreditRows(viewer: SolicitudViewer, filters: SolicitudFilters) {
  const platform = `COALESCE(NULLIF(c."contratoSnapshot"#>>'{equipo,plataforma}', ''), dc."platform")`;
  const createdAt = `COALESCE(solicitud."createdAt", c."createdAt")`;
  const where = buildCommonWhere({
    alias: "c",
    source: "CREDIT",
    viewer,
    filters,
    platformExpression: platform,
    numberExpression: `c."folio"`,
    createdAtExpression: createdAt,
  });
  where.conditions.unshift("TRUE");

  return prisma.$queryRawUnsafe<SolicitudRow[]>(
    `
      SELECT 'CREDIT'::text AS "source", c."id" AS "entityId", c."folio" AS "numero",
        c."estado" AS "rawState", NULL::text AS "closedReason", NULL::integer AS "currentStep",
        c."usuarioId", c."vendedorId", c."sedeId", s."aliadoId",
        c."clienteNombre", c."clienteDocumento", c."imei", ${platform} AS "plataforma",
        ${createdAt} AS "createdAt", c."createdAt" AS "finalizedAt",
        c."updatedAt", NULL::timestamptz AS "closedAt",
        NULL::timestamptz AS "expiresAt",
        u."nombre" AS "usuarioNombre", v."nombre" AS "vendedorNombre",
        s."nombre" AS "sedeNombre", a."nombre" AS "aliadoNombre",
        dc."status" AS "dataCreditoStatus", dc."errorCode" AS "dataCreditoErrorCode",
        dc."updatedAt" AS "dataCreditoUpdatedAt",
        veriff."status" AS "veriffStatus", veriff."updatedAt" AS "veriffUpdatedAt",
        firma."status" AS "firmaStatus", firma."lastError" AS "firmaLastError",
        firma."updatedAt" AS "firmaUpdatedAt", c."deliverableReady",
        (c."fotoEntregaDataUrl" IS NOT NULL OR c."fotoRemisionDataUrl" IS NOT NULL) AS "hasDeliveryEvidence"
      FROM "Credito" c
      LEFT JOIN "Usuario" u ON u."id" = c."usuarioId"
      LEFT JOIN "Vendedor" v ON v."id" = c."vendedorId"
      LEFT JOIN "Sede" s ON s."id" = c."sedeId"
      LEFT JOIN "Aliado" a ON a."id" = s."aliadoId"
      LEFT JOIN LATERAL (
        SELECT MIN(draft."createdAt") AS "createdAt"
        FROM "CreditoBorrador" draft
        WHERE draft."creditoId" = c."id"
      ) solicitud ON TRUE
      LEFT JOIN LATERAL (
        SELECT assessment."status", assessment."errorCode", assessment."platform", assessment."updatedAt"
        FROM "DataCreditoAssessment" assessment
        WHERE assessment."creditId" = c."id"
        ORDER BY assessment."updatedAt" DESC LIMIT 1
      ) dc ON TRUE
      LEFT JOIN LATERAL (
        SELECT validation."status", validation."updatedAt"
        FROM "VeriffIdentityValidation" validation
        WHERE validation."creditoId" = c."id"
        ORDER BY validation."updatedAt" DESC LIMIT 1
      ) veriff ON TRUE
      LEFT JOIN LATERAL (
        SELECT process."status", process."lastError", process."updatedAt"
        FROM "FirmaSeguroProcess" process
        WHERE process."creditoId" = c."id"
        ORDER BY process."updatedAt" DESC LIMIT 1
      ) firma ON TRUE
      WHERE ${where.conditions.join(" AND ")}
    `,
    ...where.values
  );
}

function serializeSolicitudRow(row: SolicitudRow, viewer: SolicitudViewer) {
  const ownership: SolicitudOwnership = {
    aliadoId: row.aliadoId,
    sedeId: row.sedeId,
    vendedorId: row.vendedorId,
    usuarioId: row.usuarioId,
  };
  const estado = resolveSolicitudStage({
    source: row.source,
    draftState: row.rawState,
    closedReason: row.closedReason,
    currentStep: row.currentStep,
    dataCreditoStatus: row.dataCreditoStatus,
    dataCreditoErrorCode: row.dataCreditoErrorCode,
    veriffStatus: row.veriffStatus,
    firmaStatus: row.firmaStatus,
    firmaLastError: row.firmaLastError,
    creditState: row.rawState,
  });
  const deliveryStage =
    row.source === "CREDIT"
      ? resolveSolicitudDeliveryStage({
          creditState: row.rawState,
          deliverableReady: row.deliverableReady,
          hasDeliveryEvidence: row.hasDeliveryEvidence,
        })
      : null;
  const sensitive = canSeeSensitiveSolicitudData(viewer);
  const id = `${row.source === "DRAFT" ? "D" : "C"}-${row.entityId}`;
  const actions = getSolicitudActions({
    viewer,
    ownership,
    source: row.source,
    state: estado,
    draftState: row.rawState,
  });

  const timeline = [
    { key: "CREADA", label: "Solicitud creada", status: "COMPLETADA", at: toIso(row.createdAt) },
    row.dataCreditoStatus
      ? {
          key: "DATACREDITO",
          label: "Consulta DataCrédito",
          status: row.dataCreditoStatus,
          at: toIso(row.dataCreditoUpdatedAt),
        }
      : null,
    row.veriffStatus
      ? {
          key: "VERIFF",
          label: "Validación facial",
          status: row.veriffStatus,
          at: toIso(row.veriffUpdatedAt),
        }
      : null,
    row.firmaStatus
      ? {
          key: "CONTRATOS",
          label: "Contratos",
          status: row.firmaStatus,
          at: toIso(row.firmaUpdatedAt),
        }
      : null,
    row.source === "CREDIT"
      ? {
          key: "CREDITO",
          label: "Venta finalizada",
          status: "APROBADA",
          at: toIso(row.finalizedAt || row.createdAt),
        }
      : null,
  ].filter(Boolean);

  return {
    id,
    source: row.source,
    entityId: row.entityId,
    numero: row.numero,
    clienteNombre: row.clienteNombre || "Cliente sin nombre",
    documento: sensitive ? row.clienteDocumento : maskDocument(row.clienteDocumento),
    imei: sensitive ? row.imei : maskImei(row.imei),
    plataforma: normalizePlatform(row.plataforma),
    estado,
    estadoLabel: SOLICITUD_STATE_LABELS[estado],
    deliveryStage,
    deliveryStageLabel: deliveryStage ? SOLICITUD_STATE_LABELS[deliveryStage] : null,
    rawState: row.rawState,
    currentStep: row.currentStep,
    creadoPor: row.vendedorNombre || row.usuarioNombre || "Usuario",
    usuario: { id: row.usuarioId, nombre: row.usuarioNombre || "Usuario" },
    asesor: row.vendedorId
      ? { id: row.vendedorId, nombre: row.vendedorNombre || "Asesor" }
      : null,
    sede: { id: row.sedeId, nombre: row.sedeNombre || "Sede" },
    aliado: row.aliadoId
      ? { id: row.aliadoId, nombre: row.aliadoNombre || "Aliado" }
      : null,
    createdAt: toIso(row.createdAt),
    updatedAt: latestIso(
      row.updatedAt,
      row.dataCreditoUpdatedAt,
      row.veriffUpdatedAt,
      row.firmaUpdatedAt
    ),
    closedAt: toIso(row.closedAt),
    expiresAt: toIso(row.expiresAt),
    technicalError: estado === "ERROR_TECNICO",
    technicalErrorCode: sensitive ? row.dataCreditoErrorCode : null,
    actions,
    retomarHref:
      row.source === "DRAFT"
        ? `/dashboard/creditos?draft=${row.entityId}&mode=create-client`
        : null,
    creditHref:
      row.source === "CREDIT"
        ? `/dashboard/creditos?mode=correction&selected=${row.entityId}`
        : null,
    timeline,
  };
}

function matchesState(
  item: ReturnType<typeof serializeSolicitudRow>,
  state: SolicitudState | ""
) {
  if (!state) return true;
  if (state === "ENTREGADA") return item.deliveryStage === "ENTREGADA";
  if (state === "LISTA_PARA_ENTREGA") {
    return item.estado === state || item.deliveryStage === state;
  }
  return item.estado === state;
}

async function getFilterOptions(viewer: SolicitudViewer) {
  const aliadoWhere =
    viewer.kind === "CENTRAL_ADMIN"
      ? { activo: true }
      : viewer.aliadoId
        ? { id: viewer.aliadoId, activo: true }
        : { id: -1 };
  const sedeWhere = {
    activa: true,
    ...(viewer.kind === "CENTRAL_ADMIN"
      ? {}
      : { aliadoId: viewer.aliadoId || -1 }),
    ...(viewer.kind === "SUPERVISOR" || viewer.kind === "SELLER"
      ? { id: viewer.sedeId || -1 }
      : {}),
  };
  const sellerWhere = {
    activo: true,
    ...(viewer.kind === "SELLER" ? { id: viewer.vendedorId || -1 } : {}),
    asignaciones: {
      some: {
        activo: true,
        sede: sedeWhere,
      },
    },
  };
  const [aliados, sedes, asesores] = await Promise.all([
    prisma.aliado.findMany({
      where: aliadoWhere,
      select: { id: true, nombre: true },
      orderBy: { nombre: "asc" },
    }),
    prisma.sede.findMany({
      where: sedeWhere,
      select: { id: true, nombre: true, aliadoId: true },
      orderBy: { nombre: "asc" },
    }),
    prisma.vendedor.findMany({
      where: sellerWhere,
      select: {
        id: true,
        nombre: true,
        asignaciones: {
          where: { activo: true },
          select: { sedeId: true },
        },
      },
      orderBy: { nombre: "asc" },
    }),
  ]);
  return {
    aliados,
    sedes,
    asesores: asesores.map((item) => ({
      id: item.id,
      nombre: item.nombre,
      sedeIds: item.asignaciones.map((assignment) => assignment.sedeId),
    })),
    plataformas: [
      { value: "ANDROID", label: "Android" },
      { value: "IPHONE", label: "iPhone" },
    ],
    estados: SOLICITUD_STATES.map((value) => ({
      value,
      label: SOLICITUD_STATE_LABELS[value],
    })),
  };
}

export async function listSolicitudes(input: {
  viewer: SolicitudViewer;
  filters: SolicitudFilters;
}) {
  await Promise.all([
    ensureSolicitudSchema(),
    ensureDataCreditoSchema(),
    ensureVeriffSchema(),
    ensureFirmaSeguroSchema(),
  ]);
  await expireStaleSolicitudes();
  const [drafts, credits, options] = await Promise.all([
    readDraftRows(input.viewer, input.filters),
    readCreditRows(input.viewer, input.filters),
    getFilterOptions(input.viewer),
  ]);
  const all = [...drafts, ...credits]
    .map((row) => serializeSolicitudRow(row, input.viewer))
    .filter((item) => matchesState(item, input.filters.estado))
    .sort(
      (left, right) =>
        String(right.createdAt || "").localeCompare(String(left.createdAt || "")) ||
        right.entityId - left.entityId ||
        right.source.localeCompare(left.source)
    );
  const total = all.length;
  const start = (input.filters.page - 1) * input.filters.pageSize;
  return {
    items: all.slice(start, start + input.filters.pageSize),
    total,
    page: input.filters.page,
    pageSize: input.filters.pageSize,
    filters: input.filters,
    options,
  };
}

export async function getSolicitudDetail(input: {
  viewer: SolicitudViewer;
  filters: SolicitudFilters;
}) {
  if (!parseCompositeId(input.filters.id)) return null;
  const result = await listSolicitudes({
    viewer: input.viewer,
    filters: { ...input.filters, page: 1, pageSize: 1, estado: "" },
  });
  return result.items[0] || null;
}
