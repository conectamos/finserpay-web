import "server-only";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ensureMoraBlockExemptionTable, normalizeMoraExemptionDocument } from "@/lib/mora-block-exemptions";
import { ensureMoraExceptionRequestSchema } from "@/lib/mora-exception-schema";

export async function ensureMoraBlockProtectionTables() {
  await Promise.all([ensureMoraBlockExemptionTable(), ensureMoraExceptionRequestSchema()]);
}

/** Revalidate immediately before a device command, using the database clock.
 * A batch snapshot or a requested simulation date must never authorize a lock.
 * Callers changing a credit also hold its row lock, shared with approval actions.
 */
export async function hasActiveMoraBlockProtection(
  creditoId: number,
  documento: unknown,
  db: Pick<Prisma.TransactionClient, "$queryRawUnsafe"> = prisma,
) {
  const rows = await db.$queryRawUnsafe<Array<{ protected: boolean }>>(`
    SELECT (
      EXISTS (
        SELECT 1 FROM "CreditMoraExceptionRequest"
        WHERE "creditoId" = $1 AND "status" = 'APPROVED'
          AND ("expiresOn" IS NULL OR "expiresOn" >= (clock_timestamp() AT TIME ZONE 'America/Bogota')::date)
      ) OR EXISTS (
        SELECT 1 FROM "ExcepcionBloqueoMora"
        WHERE "documento" = $2 AND "activa" = TRUE
          AND ("fechaFin" IS NULL OR "fechaFin" >= (clock_timestamp() AT TIME ZONE 'UTC'))
      )
    ) AS "protected"
  `, creditoId, normalizeMoraExemptionDocument(documento));
  return Boolean(rows[0]?.protected);
}
