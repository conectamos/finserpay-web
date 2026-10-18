import "server-only";
import prisma from "@/lib/prisma";
import { normalizeMoraExemptionDocument } from "@/lib/mora-block-exemptions";
import { ensureMoraBlockProtectionTables, hasActiveMoraBlockProtection } from "@/lib/mora-block-protection";

export const ensureMoraMessageProtection = ensureMoraBlockProtectionTables;
export const hasActiveMoraMessageProtection = hasActiveMoraBlockProtection;

/** Read only, using the live database clock even when a campaign simulates another date.
 * Protection belongs to a credit; only the legacy document agreement covers all its credits.
 */
export async function getActiveMoraMessageProtectionIds(
  credits: ReadonlyArray<{ id: number; clienteDocumento: string | null }>,
  db: Pick<typeof prisma, "$queryRawUnsafe"> = prisma,
) {
  if (!credits.length) return new Set<number>();
  const rows = await db.$queryRawUnsafe<Array<{ id: number }>>(`
    SELECT candidate.id FROM jsonb_to_recordset($1::jsonb) AS candidate(id int, documento text)
    WHERE EXISTS (
      SELECT 1 FROM "CreditMoraExceptionRequest" request
      WHERE request."creditoId"=candidate.id AND request."status"='APPROVED'
        AND (request."expiresOn" IS NULL OR request."expiresOn">=(clock_timestamp() AT TIME ZONE 'America/Bogota')::date)
    ) OR EXISTS (
      SELECT 1 FROM "ExcepcionBloqueoMora" legacy
      WHERE legacy."documento"=candidate.documento AND legacy."activa"=TRUE
        AND (legacy."fechaFin" IS NULL OR legacy."fechaFin">=(clock_timestamp() AT TIME ZONE 'UTC'))
    )`, JSON.stringify(credits.map(credit => ({ id: credit.id, documento: normalizeMoraExemptionDocument(credit.clienteDocumento) }))));
  return new Set(rows.map(row => row.id));
}
