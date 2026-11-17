import type { Prisma } from "@/app/generated/prisma/client";

export class DataCreditoBranchAllocationError extends Error {
  constructor(message: string) { super(message); this.name = "DataCreditoBranchAllocationError"; }
}

/** Guard reactivation and transfers with the same ally-first lock order as quotas. */
export async function assertDataCreditoBranchAllocation(input: {
  database: Prisma.TransactionClient;
  branchId: number;
  expectedAllyId: number | null;
  targetAllyId: number | null;
  activating?: boolean;
}) {
  const { database, branchId, expectedAllyId, targetAllyId } = input;
  const allies = await database.$queryRawUnsafe<Array<{
    id: number; enabled: boolean; dailyLimit: number | null;
  }>>(`
    SELECT "id", "dataCreditoBranchQuotaEnabled" AS "enabled",
      "dataCreditoDailyQueryLimit" AS "dailyLimit"
    FROM "Aliado" WHERE "id" IN ($1, $2) ORDER BY "id" FOR UPDATE
  `, expectedAllyId, targetAllyId);
  const branches = await database.$queryRawUnsafe<Array<{
    aliadoId: number | null; activa: boolean; dailyLimit: number | null;
  }>>(`
    SELECT "aliadoId", "activa", "dataCreditoDailyQueryLimit" AS "dailyLimit"
    FROM "Sede" WHERE "id" = $1 FOR UPDATE
  `, branchId);
  const branch = branches[0];
  if (!branch || branch.aliadoId !== expectedAllyId) {
    throw new DataCreditoBranchAllocationError("La sede cambió de aliado. Recarga antes de guardar.");
  }
  const target = allies.find((ally) => ally.id === targetAllyId);
  if (!target?.enabled || (!branch.activa && !input.activating)) return;
  const totals = await database.$queryRawUnsafe<Array<{ allocated: number }>>(`
    SELECT COALESCE(SUM(COALESCE("dataCreditoDailyQueryLimit", 0)), 0)::integer AS "allocated"
    FROM "Sede" WHERE "aliadoId" = $1 AND "activa" = true AND "id" <> $2
  `, targetAllyId, branchId);
  if (target.dailyLimit === null ||
      Number(totals[0]?.allocated || 0) + (branch.dailyLimit ?? 0) > target.dailyLimit) {
    throw new DataCreditoBranchAllocationError(
      "El cupo de esta sede excedería el total del aliado. Ajusta primero la distribución de consultas por sedes."
    );
  }
}
