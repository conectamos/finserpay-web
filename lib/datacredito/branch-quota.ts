export type DataCreditoBranchQuotaExecutor = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
};

/** Reconcile a single Colombia day while the caller holds the ally FOR UPDATE lock. */
export async function syncDataCreditoBranchDailyQuotaUsage(
  database: DataCreditoBranchQuotaExecutor,
  allyId: number,
  businessDate: string
): Promise<void> {
  if (!Number.isSafeInteger(allyId) || allyId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error("DATACREDITO_BRANCH_QUOTA_SYNC_SCOPE_INVALID");
  }
  // PENDING is an outstanding reservation. A terminal pre-dispatch failure has
  // no provider evidence; reuse is free. Exact reconciliation also repairs an
  // old runtime's ally-only compensation during a rolling deployment.
  await database.$queryRawUnsafe(`
    WITH branch_totals AS (
      SELECT assessment."sedeId" AS "branchId", COUNT(*)::integer AS "usedCount"
      FROM "DataCreditoAssessment" assessment
      INNER JOIN "Sede" branch ON branch."id" = assessment."sedeId"
      WHERE assessment."aliadoId" = $1
        AND assessment."reusedFromAssessmentId" IS NULL
        AND COALESCE(assessment."dailyQuotaBusinessDate",
          (assessment."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date) = $2::date
        AND (
          assessment."status" IN ('PENDING', 'APROBADO', 'RECHAZADO')
          OR (assessment."status" = 'NO_EVALUADO' AND (
            assessment."durationMs" IS NOT NULL
            OR BTRIM(COALESCE(assessment."providerStatus", '')) <> ''
            OR BTRIM(COALESCE(assessment."transactionCode", '')) <> ''
            OR assessment."errorCode" IN ('PROVIDER_OUTCOME_AMBIGUOUS', 'STALE_PENDING')
          ))
        )
      GROUP BY assessment."sedeId"
    ), branch_keys AS (
      SELECT "branchId" FROM branch_totals
      UNION
      SELECT "branchId" FROM "DataCreditoBranchDailyQuotaUsage"
      WHERE "allyId" = $1 AND "businessDate" = $2::date
    )
    INSERT INTO "DataCreditoBranchDailyQuotaUsage" AS usage (
      "allyId", "branchId", "businessDate", "usedCount", "createdAt", "updatedAt"
    )
    SELECT $1, branch_keys."branchId", $2::date, COALESCE(branch_totals."usedCount", 0),
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM branch_keys LEFT JOIN branch_totals USING ("branchId")
    ON CONFLICT ("allyId", "branchId", "businessDate") DO UPDATE
    SET "usedCount" = EXCLUDED."usedCount", "updatedAt" = CURRENT_TIMESTAMP
    WHERE usage."usedCount" IS DISTINCT FROM EXCLUDED."usedCount"
    RETURNING "branchId"
  `, allyId, businessDate);
}
