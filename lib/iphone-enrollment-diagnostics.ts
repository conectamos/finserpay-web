import "server-only";

import prisma from "@/lib/prisma";
import {
  normalizeIphoneEnrollmentDocument,
  normalizeIphoneEnrollmentImei,
} from "@/lib/iphone-enrollment";

const CANDIDATE_LIMIT = 6;

export class IphoneEnrollmentDiagnosticError extends Error {
  readonly code: "INVALID_LOOKUP" | "FORBIDDEN";
  readonly status: number;

  constructor(code: IphoneEnrollmentDiagnosticError["code"], message: string) {
    super(message);
    this.name = "IphoneEnrollmentDiagnosticError";
    this.code = code;
    this.status = code === "FORBIDDEN" ? 403 : 400;
  }
}

export type IphoneEnrollmentDiagnosticCandidate = {
  source: "APPLICATION" | "CREDIT" | "DEVICE_REPLACEMENT";
  sourceId: string;
  solicitudId: number | null;
  solicitudNumero: string | null;
  creditoId: number | null;
  creditoFolio: string | null;
  clienteNombre: string;
  document: string;
  imei: string;
  currentStep: number | null;
  stepLabel: string;
  status: string;
  platform: string | null;
  matchedBy: "BOTH" | "DOCUMENT" | "IMEI";
  updatedAt: string | null;
  pendingReason: string | null;
};

export type IphoneEnrollmentDiagnostics = {
  kind: "EXACT_MATCH" | "MISMATCH" | "NOT_FOUND";
  candidates: IphoneEnrollmentDiagnosticCandidate[];
  hasMore: boolean;
};

type CandidateRow = Omit<IphoneEnrollmentDiagnosticCandidate, "solicitudNumero" | "stepLabel" | "updatedAt" | "pendingReason"> & {
  updatedAt: Date | string | null;
  closedReason: string | null;
  expired: boolean;
  dataCreditoStatus: string | null;
  firmaStatus: string | null;
  firmaCompleted: boolean;
  veriffStatus: string | null;
};

type DiagnosticTables = {
  applications: boolean;
  replacements: boolean;
  firma: boolean;
  veriff: boolean;
};

function applicationStepLabel(step: number | null) {
  switch (step) {
    case 1: return "Cliente";
    case 2: return "Equipo";
    case 3: return "Identidad y evidencias";
    case 4: return "Identidad y firma";
    case 5: return "Enrolamiento y entrega";
    default: return step === null ? "Sin etapa registrada" : `Etapa ${step}`;
  }
}

function pendingReason(row: CandidateRow) {
  if (row.source === "CREDIT") {
    return "El crédito ya fue creado; consulta su registro o el cambio por garantía correspondiente.";
  }
  if (row.source === "DEVICE_REPLACEMENT") {
    switch (row.status) {
      case "PENDING_ENROLLMENT": return "El cambio por garantía está pendiente de enrolamiento.";
      case "ENROLLMENT_APPROVED": return "El cambio por garantía ya tiene una aprobación de enrolamiento registrada.";
      case "COMPLETED": return "El cambio por garantía ya fue completado.";
      case "CANCELLED": return "El cambio por garantía fue cancelado.";
      default: return "Consulta el estado registrado del cambio por garantía.";
    }
  }
  if (row.status !== "ABIERTO") return "La solicitud ya no está abierta.";
  if (row.expired) return "La solicitud está vencida.";
  if (row.platform !== "IPHONE") return "La plataforma guardada no corresponde a iPhone.";
  if (row.dataCreditoStatus !== "APROBADO") return "La consulta de crédito todavía requiere verificación.";
  if (row.currentStep === null || row.currentStep < 5) {
    return `La solicitud está en ${applicationStepLabel(row.currentStep)}. Todavía no está en Enrolamiento y entrega.`;
  }
  if (!row.firmaCompleted) return "El proceso vigente de FirmaSeguro no registra un contrato firmado.";
  if (row.veriffStatus !== "APPROVED") return "La validación facial todavía requiere verificación.";
  // A stored status alone is not the scoped identity authorization used by the enrollment lookup.
  return "La etapa de entrega está registrada. Debe verificarse la autorización de identidad y firma antes de enrolar.";
}

function serializeCandidate(row: CandidateRow): IphoneEnrollmentDiagnosticCandidate {
  const updatedAt = row.updatedAt ? new Date(row.updatedAt) : null;
  return {
    source: row.source,
    sourceId: row.sourceId,
    solicitudId: row.solicitudId,
    solicitudNumero: row.solicitudId === null ? null : `SOL-${String(row.solicitudId).padStart(6, "0")}`,
    creditoId: row.creditoId,
    creditoFolio: row.creditoFolio,
    clienteNombre: row.clienteNombre || "Sin nombre registrado",
    document: row.document || "",
    imei: row.imei || "",
    currentStep: row.currentStep,
    stepLabel: row.source === "DEVICE_REPLACEMENT"
      ? "Enrolamiento por garantía"
      : row.source === "CREDIT" && row.currentStep === null
        ? "Crédito creado"
        : applicationStepLabel(row.currentStep),
    status: row.status,
    platform: row.platform,
    matchedBy: row.matchedBy,
    updatedAt: updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt.toISOString() : null,
    pendingReason: pendingReason(row),
  };
}

function candidateSql(tables: DiagnosticTables, exact: boolean) {
  const sources: string[] = [];
  if (tables.applications) {
    sources.push(`
      SELECT 'APPLICATION'::text AS "source", d."id"::text AS "sourceId",
        d."id" AS "solicitudId", NULL::integer AS "creditoId", NULL::text AS "creditoFolio",
        d."clienteNombre", COALESCE(d."clienteDocumento", '') AS "document", COALESCE(d."imei", '') AS "imei",
        d."currentStep", d."estado" AS "status",
        NULLIF(UPPER(BTRIM(COALESCE(NULLIF(d."plataforma", ''), d."payload"->>'plataforma', ''))), '') AS "platform",
        d."updatedAt", d."closedReason",
        COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') <= CURRENT_TIMESTAMP AS "expired",
        UPPER(COALESCE(d."dataCreditoStatus", '')) AS "dataCreditoStatus",
        ${tables.firma ? 'signature."status"' : 'NULL::text'} AS "firmaStatus",
        ${tables.firma ? 'COALESCE(signature."completed", FALSE)' : 'FALSE'} AS "firmaCompleted",
        ${tables.veriff ? 'identity."status"' : 'NULL::text'} AS "veriffStatus"
      FROM "CreditoBorrador" d
      ${tables.firma ? `LEFT JOIN LATERAL (
        SELECT p."status", (p."completedAt" IS NOT NULL OR NULLIF(BTRIM(p."signedDocumentBase64"), '') IS NOT NULL) AS "completed"
        FROM "FirmaSeguroProcess" p WHERE p."draftId" = d."id" AND p."supersededAt" IS NULL
        ORDER BY p."createdAt" DESC, p."id" DESC LIMIT 1
      ) signature ON TRUE` : ''}
      ${tables.veriff ? `LEFT JOIN LATERAL (
        SELECT v."status" FROM "VeriffIdentityValidation" v WHERE v."draftId" = d."id"
        ORDER BY v."id" DESC LIMIT 1
      ) identity ON TRUE` : ''}
      WHERE d."creditoId" IS NULL OR NOT EXISTS (SELECT 1 FROM "Credito" c WHERE c."id" = d."creditoId")
    `);
  }
  const originJoin = tables.applications ? `LEFT JOIN LATERAL (
    SELECT d."id", d."currentStep", d."plataforma" FROM "CreditoBorrador" d
    WHERE d."creditoId" = c."id" ORDER BY d."updatedAt" DESC, d."id" DESC LIMIT 1
  ) origin ON TRUE` : '';
  sources.push(`
    SELECT 'CREDIT'::text AS "source", c."id"::text AS "sourceId",
      ${tables.applications ? 'origin."id"' : 'NULL::integer'} AS "solicitudId", c."id" AS "creditoId", c."folio" AS "creditoFolio",
      c."clienteNombre", COALESCE(c."clienteDocumento", '') AS "document", COALESCE(NULLIF(c."imei", ''), c."deviceUid", '') AS "imei",
      ${tables.applications ? 'origin."currentStep"' : 'NULL::integer'} AS "currentStep", c."estado" AS "status",
      NULLIF(UPPER(BTRIM(COALESCE(${tables.applications ? 'NULLIF(origin."plataforma", \'\'),' : ''} c."contratoSnapshot"->'equipo'->>'plataforma', ''))), '') AS "platform",
      c."updatedAt", NULL::text AS "closedReason", FALSE AS "expired", NULL::text AS "dataCreditoStatus",
      NULL::text AS "firmaStatus", FALSE AS "firmaCompleted", NULL::text AS "veriffStatus"
    FROM "Credito" c ${originJoin}
  `);
  if (tables.replacements) {
    sources.push(`
      SELECT 'DEVICE_REPLACEMENT'::text AS "source", replacement."id"::text AS "sourceId",
        replacement."solicitudId", c."id" AS "creditoId", c."folio" AS "creditoFolio",
        c."clienteNombre", COALESCE(c."clienteDocumento", '') AS "document", replacement."newImei" AS "imei",
        ${tables.applications ? 'origin."currentStep"' : 'NULL::integer'} AS "currentStep", replacement."status",
        NULLIF(UPPER(BTRIM(COALESCE(${tables.applications ? 'NULLIF(origin."plataforma", \'\'),' : ''} c."contratoSnapshot"->'equipo'->>'plataforma', ''))), '') AS "platform",
        replacement."updatedAt", NULL::text AS "closedReason", FALSE AS "expired", NULL::text AS "dataCreditoStatus",
        NULL::text AS "firmaStatus", FALSE AS "firmaCompleted", NULL::text AS "veriffStatus"
      FROM "CreditDeviceReplacement" replacement INNER JOIN "Credito" c ON c."id" = replacement."creditId"
      ${tables.applications ? 'LEFT JOIN "CreditoBorrador" origin ON origin."id" = replacement."solicitudId"' : ''}
    `);
  }
  return `WITH cases AS (${sources.join(" UNION ALL ")}), normalized AS (
    SELECT cases.*, regexp_replace("document", '[^0-9]', '', 'g') AS "documentDigits",
      regexp_replace("imei", '[^0-9]', '', 'g') AS "imeiDigits" FROM cases
  ) SELECT "source", "sourceId", "solicitudId", "creditoId", "creditoFolio", "clienteNombre", "document", "imei",
    "currentStep", "status", "platform", "updatedAt", "closedReason", "expired", "dataCreditoStatus", "firmaStatus", "firmaCompleted", "veriffStatus",
    CASE WHEN "documentDigits" = $1 AND "imeiDigits" = $2 THEN 'BOTH'
      WHEN "documentDigits" = $1 THEN 'DOCUMENT' ELSE 'IMEI' END AS "matchedBy"
    FROM normalized WHERE ${exact ? '"documentDigits" = $1 AND "imeiDigits" = $2' : '"documentDigits" = $1 OR "imeiDigits" = $2'}
    ORDER BY "updatedAt" DESC NULLS LAST, "source" ASC, "sourceId" ASC LIMIT ${CANDIDATE_LIMIT + 1}`;
}

/** Nominal staff only. Diagnostic matches never grant enrollment authorization. */
export async function lookupNominalIphoneEnrollmentDiagnostics(
  input: { document: string; imei: string },
  actor: { userId: number }
): Promise<IphoneEnrollmentDiagnostics> {
  const document = typeof input?.document === "string" && input.document.length <= 80
    ? normalizeIphoneEnrollmentDocument(input.document) : null;
  const imei = typeof input?.imei === "string" && input.imei.length <= 40
    ? normalizeIphoneEnrollmentImei(input.imei) : null;
  if (!document || !imei) {
    throw new IphoneEnrollmentDiagnosticError("INVALID_LOOKUP", "Ingresa una cédula y un IMEI válidos.");
  }
  if (!Number.isSafeInteger(actor?.userId) || actor.userId <= 0) {
    throw new IphoneEnrollmentDiagnosticError("FORBIDDEN", "Esta consulta requiere un usuario nominal autorizado.");
  }
  return prisma.$transaction(async (tx) => {
    const allowed = await tx.$queryRawUnsafe<{ id: number }[]>(`
      SELECT u."id" FROM "Usuario" u INNER JOIN "Rol" r ON r."id" = u."rolId"
      INNER JOIN "Sede" s ON s."id" = u."sedeId" INNER JOIN "Aliado" a ON a."id" = s."aliadoId"
      WHERE u."id" = $1 AND u."activo" = TRUE AND s."activa" = TRUE AND a."activo" = TRUE
        AND UPPER(BTRIM(a."codigo")) = 'FINSERPAY'
        AND UPPER(BTRIM(r."nombre")) IN ('ADMIN', 'ANALISTA_APROBACION')
      FOR SHARE OF u, r, s, a
    `, actor.userId);
    if (!allowed.length) {
      throw new IphoneEnrollmentDiagnosticError("FORBIDDEN", "Esta consulta requiere un usuario nominal autorizado.");
    }
    const [tables] = await tx.$queryRawUnsafe<DiagnosticTables[]>(`SELECT
      to_regclass('"CreditoBorrador"') IS NOT NULL AS "applications",
      to_regclass('"CreditDeviceReplacement"') IS NOT NULL AS "replacements",
      to_regclass('"FirmaSeguroProcess"') IS NOT NULL AS "firma",
      to_regclass('"VeriffIdentityValidation"') IS NOT NULL AS "veriff"`);
    const exactRows = await tx.$queryRawUnsafe<CandidateRow[]>(candidateSql(tables, true), document, imei);
    const rows = exactRows.length ? exactRows : await tx.$queryRawUnsafe<CandidateRow[]>(candidateSql(tables, false), document, imei);
    return {
      kind: exactRows.length ? "EXACT_MATCH" : rows.length ? "MISMATCH" : "NOT_FOUND",
      candidates: rows.slice(0, CANDIDATE_LIMIT).map(serializeCandidate),
      hasMore: rows.length > CANDIDATE_LIMIT,
    };
  }, { isolationLevel: "RepeatableRead", timeout: 15_000 });
}
