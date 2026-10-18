import { SOLICITUD_STATE_LABELS } from "./solicitudes";
import { assertExportViewer, ExportError, exportDateBounds, normalizeExportFilters, type ExportFilters, type ExportViewer } from "./solicitudes-export-core";
import type { SolicitudExportRow } from "./solicitudes-export-excel";

export type ExportDatabase = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};
export type ExportOptions = {
  aliados: Array<{ id: number; nombre: string }>;
  sedes: Array<{ id: number; nombre: string; aliadoId: number | null }>;
  vendedores: Array<{ id: number; nombre: string; sedeIds: number[] }>;
};
export type ExportDataRow = SolicitudExportRow & {
  source: "CREDIT" | "DRAFT";
  entityId: number;
  operationAt: Date | string;
  aliadoId: number | null;
  sedeId: number;
};
type QueryRow = ExportDataRow & { processStage: string | null; deliveryStage: string | null };
type Cursor = { source: "CREDIT" | "DRAFT"; entityId: number };

async function databaseOrDefault(database?: ExportDatabase): Promise<ExportDatabase> {
  return database ?? (await import("./prisma")).default;
}

async function hasSadminRegistration(database: ExportDatabase) {
  const columns = await database.$queryRawUnsafe<Array<{ column_name: string }>>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'CreditSadminRegistration'
      AND column_name IN ('creditoId','numeroCredito','numeroCreditoConfirmado')
  `);
  return columns.length === 3;
}

/** Include inactive entities with history, without granting any cross-ally scope. */
export async function getExportOptions(viewer: ExportViewer, database?: ExportDatabase): Promise<ExportOptions> {
  assertExportViewer(viewer);
  const db = await databaseOrDefault(database);
  const scope = viewer.kind === "ALLY_ADMIN" ? viewer.aliadoId : null;
  const aliados = await db.$queryRawUnsafe<ExportOptions["aliados"]>(
    `SELECT "id", "nombre" FROM "Aliado" WHERE ($1::integer IS NULL OR "id" = $1) ORDER BY "nombre", "id"`, scope,
  );
  const sedes = await db.$queryRawUnsafe<ExportOptions["sedes"]>(
    `SELECT "id", "nombre", "aliadoId" FROM "Sede" WHERE ($1::integer IS NULL OR "aliadoId" = $1) ORDER BY "nombre", "id"`, scope,
  );
  const vendedores = await db.$queryRawUnsafe<ExportOptions["vendedores"]>(`
    WITH associations AS (
      SELECT "vendedorId", "sedeId" FROM "SedeVendedor" WHERE "activo" = TRUE
      UNION SELECT "vendedorId", "sedeId" FROM "Credito" WHERE "vendedorId" IS NOT NULL
      UNION SELECT "vendedorId", "sedeId" FROM "CreditoBorrador" WHERE "vendedorId" IS NOT NULL
    )
    SELECT v."id", v."nombre", array_agg(DISTINCT s."id" ORDER BY s."id") AS "sedeIds"
    FROM associations x JOIN "Sede" s ON s."id" = x."sedeId"
    JOIN "Vendedor" v ON v."id" = x."vendedorId"
    WHERE ($1::integer IS NULL OR s."aliadoId" = $1)
    GROUP BY v."id", v."nombre" ORDER BY v."nombre", v."id"
  `, scope);
  return { aliados, sedes, vendedores };
}

export async function validateExportScope(viewer: ExportViewer, filters: ExportFilters, database?: ExportDatabase) {
  assertExportViewer(viewer);
  const normalized = normalizeExportFilters(filters);
  if (viewer.kind === "ALLY_ADMIN" && normalized.aliadoIds.some(id => id !== viewer.aliadoId)) {
    throw new ExportError(403, "El alcance solicitado no está autorizado.");
  }
  const options = await getExportOptions(viewer, database);
  for (const [selected, permitted] of [
    [normalized.aliadoIds, options.aliados], [normalized.sedeIds, options.sedes],
    [normalized.vendedorIds, options.vendedores],
  ] as const) {
    const authorized = new Set(permitted.map(item => item.id));
    if (selected.some(id => !authorized.has(id))) throw new ExportError(403, "El alcance solicitado no está autorizado.");
  }
  return normalized;
}

// Only named, non-sensitive JSON properties are read. Never return snapshots,
// provider responses, biometrics, documents, URLs, or authentication material.
function draftText(key: string) { return `NULLIF(d."payload"->>'${key}', '')`; }
function draftNumber(key: string) {
  const value = draftText(key);
  return `(CASE WHEN length(${value}) <= 30 AND ${value} ~ '^-?[0-9]+([.][0-9]+)?$' THEN (${value})::double precision ELSE NULL END)`;
}

// Retention can remove an assessment while leaving the authorized request and
// its outcome. to_jsonb also supports installations predating these columns.
const DRAFT_ASSESSMENT_STATUS = `COALESCE(dc."status", NULLIF(to_jsonb(d)->>'dataCreditoStatus', ''))`;
const DRAFT_ASSESSMENT_ERROR = `COALESCE(dc."errorCode", NULLIF(to_jsonb(d)->>'dataCreditoErrorCode', ''))`;
const DRAFT_STATE = `CASE
  WHEN (d."estado" = 'ABIERTO' AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') <= CURRENT_TIMESTAMP)
    OR (UPPER(d."estado") = 'CERRADO' AND UPPER(COALESCE(d."closedReason", '')) IN ('DESISTIDA','DESISTIDO','EXPIRADA_15_DIAS','EXPIRADA','DUPLICADA')) THEN 'CANCELADA'
  WHEN UPPER(${DRAFT_ASSESSMENT_STATUS}) = 'RECHAZADO' OR UPPER(COALESCE(d."closedReason", '')) = 'RECHAZADA' THEN 'RECHAZADA'
  WHEN (UPPER(${DRAFT_ASSESSMENT_STATUS}) = 'NO_EVALUADO' AND NULLIF(BTRIM(${DRAFT_ASSESSMENT_ERROR}), '') IS NOT NULL)
    OR UPPER(veriff."status") = 'ERROR' OR NULLIF(BTRIM(firma."lastError"), '') IS NOT NULL THEN 'ERROR_TECNICO'
  ELSE 'PROCESO' END`;
const DRAFT_PROCESS_STAGE = `CASE
  WHEN (${DRAFT_STATE}) <> 'PROCESO' THEN NULL
  WHEN UPPER(COALESCE(${DRAFT_ASSESSMENT_STATUS}, '')) <> 'APROBADO' THEN 'CONSULTA_PENDIENTE'
  WHEN UPPER(firma."status") IN ('SIGNED','COMPLETED','COMPLETADO','FIRMADO') OR d."currentStep" >= 5 THEN 'LISTA_PARA_ENTREGA'
  WHEN NULLIF(BTRIM(veriff."status"), '') IS NOT NULL AND UPPER(veriff."status") <> 'APPROVED' THEN 'VALIDACION_FACIAL'
  WHEN UPPER(veriff."status") = 'APPROVED' OR d."currentStep" >= 4 THEN 'CONTRATOS'
  WHEN d."currentStep" >= 3 THEN 'VALIDACION_FACIAL'
  ELSE NULL END`;

const EXPORT_CTE = `WITH requests AS (
  SELECT 'CREDIT'::text AS "source", c."id" AS "entityId", s."aliadoId", c."sedeId", c."vendedorId",
    COALESCE(('SOL-' || LPAD(origin."id"::text, GREATEST(6, LENGTH(origin."id"::text)), '0')), c."folio") AS "solicitudNumero",
    COALESCE(origin."createdAt", c."createdAt" AT TIME ZONE 'UTC') AS "createdAt",
    c."fechaCredito" AT TIME ZONE 'UTC' AS "operationAt",
    CASE WHEN UPPER(c."estado") IN ('ANULADO','ANULADA','CANCELADO','CANCELADA') THEN 'CANCELADA' ELSE 'APROBADA' END AS "estado",
    NULL::text AS "processStage",
    CASE WHEN c."fotoEntregaDataUrl" IS NOT NULL OR c."fotoRemisionDataUrl" IS NOT NULL OR UPPER(c."estado") IN ('ENTREGADO','ENTREGADA') THEN 'ENTREGADA'
      WHEN c."deliverableReady" OR UPPER(c."estado") = 'ENTREGABLE' THEN 'LISTA_PARA_ENTREGA' ELSE NULL END AS "deliveryStage",
    c."folio" AS "numeroCredito", NULL::text AS "numeroSadmin",
    NULLIF(c."clienteNombre", '') AS "nombreCompleto", c."clienteTipoDocumento" AS "tipoDocumento",
    c."clienteDocumento" AS "numeroDocumento", c."clienteTelefono" AS "celular", c."clienteCorreo" AS "correo",
    c."clienteDepartamento" AS "departamento", c."clienteCiudad" AS "ciudad", c."clienteDireccion" AS "direccion",
    a."nombre" AS "aliado", s."nombre" AS "sede", v."nombre" AS "vendedor",
    c."equipoMarca" AS "marcaEquipo", COALESCE(NULLIF(c."referenciaEquipo", ''), c."equipoModelo") AS "referenciaEquipo", c."imei",
    c."valorEquipoTotal"::double precision AS "valorEquipo", c."cuotaInicial"::double precision AS "inicial",
    c."saldoBaseFinanciado"::double precision AS "valorFinanciado", c."plazoMeses"::double precision AS "numeroCuotas",
    c."valorCuota"::double precision AS "valorCuota", c."frecuenciaPago" AS "frecuencia",
    c."fechaPrimerPago"::text AS "primerPago",
    COALESCE(NULLIF(c."contratoSnapshot"#>>'{equipo,plataforma}', ''), dc."platform") AS "plataforma"
  FROM "Credito" c
  LEFT JOIN "Sede" s ON s."id" = c."sedeId"
  LEFT JOIN "Aliado" a ON a."id" = s."aliadoId"
  LEFT JOIN "Vendedor" v ON v."id" = c."vendedorId"
  LEFT JOIN LATERAL (
    SELECT d."id", d."createdAt" FROM "CreditoBorrador" d
    WHERE d."creditoId" = c."id"
    ORDER BY d."createdAt", d."id" LIMIT 1
  ) origin ON TRUE
  LEFT JOIN LATERAL (
    SELECT assessment."platform" FROM "DataCreditoAssessment" assessment WHERE assessment."creditId" = c."id"
    ORDER BY assessment."updatedAt" DESC, assessment."id" DESC LIMIT 1
  ) dc ON TRUE
  UNION ALL
  SELECT 'DRAFT'::text, d."id", s."aliadoId", d."sedeId", d."vendedorId",
    'SOL-' || LPAD(d."id"::text, GREATEST(6, LENGTH(d."id"::text)), '0'), d."createdAt", d."createdAt", ${DRAFT_STATE}, ${DRAFT_PROCESS_STAGE}, NULL::text,
    NULL::text, NULL::text,
    COALESCE(NULLIF(d."clienteNombre", ''), ${draftText("clienteNombre")}, NULLIF(CONCAT_WS(' ', ${draftText("clientePrimerNombre")}, ${draftText("clientePrimerApellido")}, ${draftText("clienteSegundoApellido")}), '')),
    ${draftText("clienteTipoDocumento")}, d."clienteDocumento", d."clienteTelefono", ${draftText("clienteCorreo")},
    ${draftText("clienteDepartamento")}, ${draftText("clienteCiudad")}, ${draftText("clienteDireccion")},
    a."nombre", s."nombre", v."nombre", ${draftText("equipoMarca")},
    COALESCE(${draftText("referenciaEquipo")}, ${draftText("equipoModelo")}), d."imei",
    ${draftNumber("valorEquipoTotal")}, ${draftNumber("cuotaInicial")}, ${draftNumber("saldoBaseFinanciado")},
    ${draftNumber("plazoMeses")}, COALESCE(${draftNumber("valorCuota")}, ${draftNumber("cuotaComercial")}),
    ${draftText("frecuenciaPago")}, ${draftText("fechaPrimerPago")},
    COALESCE(NULLIF(d."plataforma", ''), ${draftText("plataformaDispositivo")}, dc."platform")
  FROM "CreditoBorrador" d
  LEFT JOIN "Sede" s ON s."id" = d."sedeId"
  LEFT JOIN "Aliado" a ON a."id" = s."aliadoId"
  LEFT JOIN "Vendedor" v ON v."id" = d."vendedorId"
  LEFT JOIN LATERAL (
    SELECT assessment."status", assessment."errorCode", assessment."platform" FROM "DataCreditoAssessment" assessment
    WHERE assessment."id"::text = COALESCE(d."dataCreditoAssessmentId"::text, NULLIF(d."payload"->>'dataCreditoAssessmentId', ''))
    ORDER BY assessment."updatedAt" DESC, assessment."id" DESC LIMIT 1
  ) dc ON TRUE
  LEFT JOIN LATERAL (
    SELECT validation."status" FROM "VeriffIdentityValidation" validation WHERE validation."draftId" = d."id"
    ORDER BY validation."id" DESC LIMIT 1
  ) veriff ON TRUE
  LEFT JOIN LATERAL (
    SELECT process."status", process."lastError" FROM "FirmaSeguroProcess" process WHERE process."draftId" = d."id"
      AND to_jsonb(process)->>'supersededAt' IS NULL
    ORDER BY process."updatedAt" DESC, process."id" DESC LIMIT 1
  ) firma ON TRUE
  WHERE d."creditoId" IS NULL
    AND COALESCE(d."dataCreditoAssessmentId"::text, NULLIF(d."payload"->>'dataCreditoAssessmentId', ''), NULLIF(to_jsonb(d)->>'dataCreditoStatus', '')) IS NOT NULL
)`;

/** Shared predicate for preview count and every generated row; all values are bound. */
export function buildExportQuery(viewer: ExportViewer, input: ExportFilters, options: { count?: boolean; after?: Cursor; limit?: number; hasSadmin?: boolean } = {}) {
  assertExportViewer(viewer);
  const filters = normalizeExportFilters(input);
  const values: unknown[] = [];
  const conditions = ["TRUE"];
  function param(value: unknown) { values.push(value); return `$${values.length}`; }
  if (viewer.kind === "ALLY_ADMIN") conditions.push(`"aliadoId" = ${param(viewer.aliadoId)}::integer`);
  for (const [column, selected] of [["aliadoId", filters.aliadoIds], ["sedeId", filters.sedeIds], ["vendedorId", filters.vendedorIds]] as const) {
    if (selected.length) conditions.push(`"${column}" = ANY(${param(selected)}::integer[])`);
  }
  const { start, endExclusive } = exportDateBounds(filters);
  if (start) conditions.push(`"operationAt" >= ${param(start.toISOString())}::timestamptz`);
  if (endExclusive) conditions.push(`"operationAt" < ${param(endExclusive.toISOString())}::timestamptz`);
  if (filters.plataforma) conditions.push(`UPPER(COALESCE("plataforma", '')) = ${param(filters.plataforma)}`);
  if (filters.estado) {
    const state = param(filters.estado);
    conditions.push(`("estado" = ${state} OR "processStage" = ${state} OR "deliveryStage" = ${state})`);
  }
  if (filters.q) {
    // The wall uses literal substring search, not user-provided SQL wildcards.
    const search = param(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`);
    const matches = ["nombreCompleto", "numeroDocumento", "imei", "solicitudNumero", "numeroCredito"]
      .map(column => `"${column}" ILIKE ${search}`);
    if (/^[\d\s.\-]+$/.test(filters.q)) {
      const digits = filters.q.replace(/\D/g, "");
      if (digits) {
        const numericSearch = param(`%${digits}%`);
        for (const column of ["numeroDocumento", "imei"]) {
          matches.push(`regexp_replace(COALESCE("${column}", ''), '[^0-9]', '', 'g') LIKE ${numericSearch}`);
        }
      }
    }
    if (options.hasSadmin) {
      matches.push(`("source" = 'CREDIT' AND EXISTS (
        SELECT 1 FROM "CreditSadminRegistration" registration
        WHERE registration."creditoId" = requests."entityId"
          AND registration."numeroCreditoConfirmado" = TRUE
          AND registration."numeroCredito" ILIKE ${search}
      ))`);
    }
    conditions.push(`(${matches.join(" OR ")})`);
  }
  if (options.after) {
    if (!["CREDIT", "DRAFT"].includes(options.after.source) || !Number.isSafeInteger(options.after.entityId) || options.after.entityId <= 0) throw new ExportError(400, "Cursor de descarga inválido.");
    conditions.push(`("source", "entityId") > (${param(options.after.source)}::text, ${param(options.after.entityId)}::integer)`);
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 5000)) throw new ExportError(400, "Tamaño de lote inválido.");
  const tail = options.count ? "" : ` ORDER BY "source", "entityId"${options.limit ? ` LIMIT ${param(options.limit)}::integer` : ""}`;
  return { sql: `${EXPORT_CTE}\nSELECT ${options.count ? 'COUNT(*)::text AS "count"' : '*'} FROM requests WHERE ${conditions.join(" AND ")}${tail}`, values };
}

export async function countExportRows(viewer: ExportViewer, input: ExportFilters, database?: ExportDatabase) {
  const db = await databaseOrDefault(database);
  const filters = await validateExportScope(viewer, input, db);
  const hasSadmin = filters.q ? await hasSadminRegistration(db) : false;
  const query = buildExportQuery(viewer, filters, { count: true, hasSadmin });
  const result = await db.$queryRawUnsafe<Array<{ count: string | number }>>(query.sql, ...query.values);
  const count = Number(result[0]?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new ExportError(500, "No se pudo calcular el total de registros.");
  return count;
}

/** No result cap: keyset batches continue until exhausted inside the caller's snapshot. */
export async function* iterateExportRows(viewer: ExportViewer, input: ExportFilters, database?: ExportDatabase, batchSize = 1000): AsyncGenerator<ExportDataRow> {
  const db = await databaseOrDefault(database);
  const filters = await validateExportScope(viewer, input, db);
  const hasSadmin = await hasSadminRegistration(db);
  let after: Cursor | undefined;
  while (true) {
    const query = buildExportQuery(viewer, filters, { after, limit: batchSize, hasSadmin });
    const rows = await db.$queryRawUnsafe<QueryRow[]>(query.sql, ...query.values);
    if (!rows.length) return;
    const creditIds = rows.filter(row => row.source === "CREDIT").map(row => row.entityId);
    const numbers = new Map<number, string>();
    if (hasSadmin && creditIds.length) {
      const registrations = await db.$queryRawUnsafe<Array<{ creditoId: number; numeroCredito: string }>>(`
        SELECT "creditoId", "numeroCredito" FROM "CreditSadminRegistration"
        WHERE "creditoId" = ANY($1::integer[]) AND "numeroCreditoConfirmado" = TRUE AND NULLIF(BTRIM("numeroCredito"), '') IS NOT NULL
        ORDER BY "creditoId", "numeroCredito"
      `, creditIds);
      for (const item of registrations) if (!numbers.has(item.creditoId)) numbers.set(item.creditoId, item.numeroCredito);
    }
    for (const row of rows) {
      type LabelKey = keyof typeof SOLICITUD_STATE_LABELS;
      const labels = [row.estado, row.processStage, row.deliveryStage]
        .filter((value): value is string => Boolean(value))
        .map(value => SOLICITUD_STATE_LABELS[value as LabelKey] ?? value);
      yield {
        ...row,
        estado: [...new Set(labels)].join(" · "),
        numeroSadmin: row.source === "CREDIT" ? numbers.get(row.entityId) ?? null : null,
      };
    }
    const last = rows[rows.length - 1];
    after = { source: last.source, entityId: last.entityId };
    if (rows.length < batchSize) return;
  }
}
