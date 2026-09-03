import "server-only";

import { isFinserPayCentralAlly } from "@/lib/aliados";
import {
  aggregateDataCreditoQuerySalesReport,
  parseDataCreditoQuerySalesReportInput,
} from "@/lib/datacredito/admin-query-sales-report-core";
import prisma from "@/lib/prisma";
import { ensureDataCreditoSchema } from "@/lib/datacredito/storage";

export { DataCreditoQuerySalesReportInputError } from "@/lib/datacredito/admin-query-sales-report-core";

const QUERY_METRICS_SQL = `
  SELECT
    assessment."aliadoId" AS "allyId",
    COUNT(*) FILTER (
      WHERE assessment."reusedFromAssessmentId" IS NULL
        AND assessment."status" <> 'PENDING'
        AND (
          assessment."durationMs" IS NOT NULL
          OR NULLIF(BTRIM(assessment."transactionCode"), '') IS NOT NULL
          OR NULLIF(BTRIM(assessment."providerStatus"), '') IS NOT NULL
          OR assessment."status" IN ('APROBADO', 'RECHAZADO')
          OR assessment."errorCode" IN (
            'PROVIDER_OUTCOME_AMBIGUOUS',
            'NO_EVALUABLE_INFORMATION',
            'TELCO_RISK_METRIC_UNAVAILABLE',
            'TOTAL_DELINQUENCY_RISK_METRIC_UNAVAILABLE',
            'POLICY_NO_MATCH'
          )
        )
    ) AS "originalQueries",
    COUNT(*) FILTER (
      WHERE assessment."reusedFromAssessmentId" IS NOT NULL
    ) AS "reusedAssessments"
  FROM "DataCreditoAssessment" assessment
  WHERE assessment."createdAt" >= $1::timestamp
    AND assessment."createdAt" < $2::timestamp
    AND assessment."providerEnvironment" = $3
    AND assessment."retainedUntil" > CURRENT_TIMESTAMP
    AND ($4::integer IS NULL OR assessment."aliadoId" = $4::integer)
  GROUP BY assessment."aliadoId"
`;

const SALES_METRICS_SQL = `
  SELECT
    site."aliadoId" AS "allyId",
    COUNT(DISTINCT credit."id") AS "sales"
  FROM "Credito" credit
  INNER JOIN "Sede" site ON site."id" = credit."sedeId"
  WHERE credit."createdAt" >= $1::timestamp
    AND credit."createdAt" < $2::timestamp
    AND credit."estado" <> 'ANULADO'
    AND ($4::integer IS NULL OR site."aliadoId" = $4::integer)
    AND EXISTS (
      SELECT 1
      FROM "DataCreditoAssessment" assessment
      WHERE assessment."creditId" = credit."id"
        AND assessment."providerEnvironment" = $3
        AND assessment."retainedUntil" > CURRENT_TIMESTAMP
    )
  GROUP BY site."aliadoId"
`;

type QueryMetricDatabaseRow = {
  allyId: number | null;
  originalQueries: bigint | number | string;
  reusedAssessments: bigint | number | string;
};

type SalesMetricDatabaseRow = {
  allyId: number | null;
  sales: bigint | number | string;
};

function databaseUtcTimestamp(value: Date) {
  // Prisma DateTime uses TIMESTAMP(3) in this schema. An explicit UTC-naive
  // parameter keeps the comparison independent from the PostgreSQL session zone.
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function countValue(value: bigint | number | string) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("DATACREDITO_QUERY_SALES_COUNT_INVALID");
  }
  return count;
}

export async function getDataCreditoQuerySalesReport(
  input: Record<string, unknown>,
  providerEnvironment: string
) {
  const parsed = parseDataCreditoQuerySalesReportInput(input);
  const environment = String(providerEnvironment || "").trim().toLowerCase();
  if (!environment) {
    throw new Error("DATACREDITO_QUERY_SALES_ENVIRONMENT_INVALID");
  }

  await ensureDataCreditoSchema();

  const start = databaseUtcTimestamp(parsed.start);
  const endExclusive = databaseUtcTimestamp(parsed.endExclusive);
  const allyId = parsed.filters.allyId;
  const [queryRows, salesRows, allies] = await Promise.all([
    prisma.$queryRawUnsafe<QueryMetricDatabaseRow[]>(
      QUERY_METRICS_SQL,
      start,
      endExclusive,
      environment,
      allyId
    ),
    prisma.$queryRawUnsafe<SalesMetricDatabaseRow[]>(
      SALES_METRICS_SQL,
      start,
      endExclusive,
      environment,
      allyId
    ),
    prisma.aliado.findMany({
      where: allyId === null ? undefined : { id: allyId },
      select: {
        id: true,
        nombre: true,
        codigo: true,
        activo: true,
      },
    }),
  ]);

  const aggregate = aggregateDataCreditoQuerySalesReport({
    selectedAllyId: allyId,
    centralAllyIds: allies
      .filter((ally) => isFinserPayCentralAlly(ally.codigo))
      .map((ally) => ally.id),
    allies: allies.map((ally) => ({
      id: ally.id,
      name: ally.nombre,
      code: ally.codigo,
      active: ally.activo,
    })),
    queryMetrics: queryRows.map((row) => ({
      allyId: row.allyId,
      originalQueries: countValue(row.originalQueries),
      reusedAssessments: countValue(row.reusedAssessments),
    })),
    salesMetrics: salesRows.map((row) => ({
      allyId: row.allyId,
      sales: countValue(row.sales),
    })),
  });

  return {
    filters: parsed.filters,
    period: parsed.period,
    ...aggregate,
  };
}
