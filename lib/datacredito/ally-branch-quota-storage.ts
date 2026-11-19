import "server-only";

import prisma from "@/lib/prisma";
import { ensureDataCreditoSchema } from "@/lib/datacredito/storage";
import type { DataCreditoAllyBranchQuota } from "@/lib/datacredito/ally-branch-quota-types";

type QuotaRow = Omit<DataCreditoAllyBranchQuota, "dailyQueriesRemaining" | "dailyQuotaResetsAt" | "branches"> & {
  dailyQuotaResetsAt: Date | string | null;
  branches: Array<{
    id: number; name: string; active: boolean; dailyQueryLimit: number | null; usedToday: number;
  }>;
};

/** Query the authorized ally directly; do not load/filter the global policy catalog. */
export async function getDataCreditoAllyBranchQuota(allyId: number): Promise<DataCreditoAllyBranchQuota | null> {
  if (!Number.isSafeInteger(allyId) || allyId <= 0) throw new Error("DATACREDITO_ALLY_QUOTA_SCOPE_INVALID");
  await ensureDataCreditoSchema();
  const rows = await prisma.$queryRawUnsafe<QuotaRow[]>(`
    WITH quota_clock AS (
      SELECT (clock_timestamp() AT TIME ZONE 'America/Bogota')::date AS "businessDate"
    )
    SELECT ally."id", ally."nombre" AS "name",
      ally."dataCreditoDailyQueryLimit" AS "dailyQueryLimit",
      ally."dataCreditoBranchQuotaEnabled" AS "branchQuotaEnabled",
      COALESCE(usage."usedCount", 0)::integer AS "dailyQueriesUsed",
      ((quota_clock."businessDate" + 1)::timestamp AT TIME ZONE 'America/Bogota') AS "dailyQuotaResetsAt",
      branch_quotas."branches"
    FROM "Aliado" ally
    CROSS JOIN quota_clock
    LEFT JOIN "DataCreditoDailyQuotaUsage" usage
      ON usage."allyId" = ally."id" AND usage."businessDate" = quota_clock."businessDate"
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', branch."id", 'name', branch."nombre", 'active', branch."activa",
        'dailyQueryLimit', branch."dataCreditoDailyQueryLimit",
        'usedToday', COALESCE(branch_usage."usedCount", 0)::integer
      ) ORDER BY branch."nombre", branch."id"), '[]'::jsonb) AS "branches"
      FROM "Sede" branch
      LEFT JOIN "DataCreditoBranchDailyQuotaUsage" branch_usage
        ON branch_usage."allyId" = ally."id" AND branch_usage."branchId" = branch."id"
        AND branch_usage."businessDate" = quota_clock."businessDate"
      WHERE branch."aliadoId" = ally."id"
    ) branch_quotas ON true
    WHERE ally."id" = $1 AND ally."activo" = true
  `, allyId);
  const row = rows[0];
  if (!row) return null;
  const used = Number(row.dailyQueriesUsed || 0);
  const remaining = row.dailyQueryLimit === null ? null : Math.max(0, row.dailyQueryLimit - used);
  return {
    id: row.id,
    name: row.name,
    dailyQueryLimit: row.dailyQueryLimit,
    branchQuotaEnabled: row.branchQuotaEnabled === true,
    dailyQueriesUsed: used,
    dailyQueriesRemaining: remaining,
    dailyQuotaResetsAt: row.dailyQuotaResetsAt ? new Date(row.dailyQuotaResetsAt).toISOString() : null,
    branches: (row.branches || []).map(branch => ({
      id: branch.id, name: branch.name, active: branch.active,
      dailyQueryLimit: branch.dailyQueryLimit,
      usedToday: Number(branch.usedToday || 0),
      remainingToday: !branch.active ? 0 : Math.min(
        Math.max(0, (branch.dailyQueryLimit ?? 0) - Number(branch.usedToday || 0)),
        remaining ?? 10_000,
      ),
    })),
  };
}
