import "server-only";
import prisma from "@/lib/prisma";
import { colombiaDateKey } from "@/lib/colombia-date";
import { normalizeMoraExemptionDocument } from "@/lib/mora-block-exemptions";
import { ensureMoraBlockProtectionTables } from "@/lib/mora-block-protection";

/** Reporting only: both approved exception types and existing document agreements
 * count as active extensions. Read at the export's cutoff without changing any
 * authorization, payment, collection rule or device policy.
 */
export async function readCarteraActiveExtensionIds(
  credits: ReadonlyArray<{ id: number; clienteDocumento: string | null }>,
  effectiveAt = new Date(),
  db: Pick<typeof prisma, "$queryRawUnsafe"> = prisma,
) {
  const candidates = [...new Map(credits
    .filter(credit => Number.isSafeInteger(credit.id) && credit.id > 0)
    .map(credit => [credit.id, {
      id: credit.id, documento: normalizeMoraExemptionDocument(credit.clienteDocumento),
    }])).values()];
  if (!candidates.length) return new Set<number>();
  await ensureMoraBlockProtectionTables();
  const rows = await db.$queryRawUnsafe<Array<{ id: number }>>(`SELECT candidate.id
    FROM jsonb_to_recordset($1::jsonb) AS candidate(id integer, documento text)
    WHERE EXISTS (
      SELECT 1 FROM "CreditMoraExceptionRequest" request
      WHERE request."creditoId"=candidate.id AND request."type" IN ('EXCEPCION','PRORROGA')
        AND request."status"='APPROVED'
        AND (request."expiresOn" IS NULL OR request."expiresOn">=$2::date)
    ) OR EXISTS (
      SELECT 1 FROM "ExcepcionBloqueoMora" legacy
      WHERE candidate.documento<>'' AND legacy."documento"=candidate.documento AND legacy."activa"=TRUE
        AND (legacy."fechaFin" IS NULL OR legacy."fechaFin">=($3::timestamptz AT TIME ZONE 'UTC'))
    )`, JSON.stringify(candidates), colombiaDateKey(effectiveAt), effectiveAt.toISOString());
  return new Set(rows.map(row => row.id));
}
