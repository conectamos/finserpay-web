import "server-only";
import prisma from "@/lib/prisma";
import { colombiaDateKey } from "@/lib/colombia-date";
import { ensureMoraExceptionRequestSchema } from "@/lib/mora-exception-schema";
import type { MoraActiveExtension } from "@/lib/analyst-mora-types";

type StoredExtension = Omit<MoraActiveExtension, "expiresOn" | "approvedAt" | "installmentDueDate"> & {
  creditoId: number;
  expiresOn: Date | string | null;
  approvedAt: Date | string | null;
  installmentDueDate: Date | string | null;
};
const dateKey = (value: Date | string | null) => value === null ? null
  : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

/** Read current extensions in one batch. A management result mentioning a
 * prórroga or a legacy general exemption is not an approved extension. */
export async function readActiveMoraExtensions(creditIds: number[], now = new Date()) {
  const ids = [...new Set(creditIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map<number, MoraActiveExtension>();
  await ensureMoraExceptionRequestSchema();
  const rows = await prisma.$queryRawUnsafe<StoredExtension[]>(`SELECT DISTINCT ON (request."creditoId")
    request."creditoId",request."id"::text,request."expiresOn",request."reason",
    request."decidedAt" AS "approvedAt",request."decidedByName" AS "approvedByName",
    request."installmentNumber",request."installmentDueDate"
    FROM "CreditMoraExceptionRequest" request
    WHERE request."creditoId"=ANY($1::integer[]) AND request."type"='PRORROGA' AND request."status"='APPROVED'
      AND (request."expiresOn" IS NULL OR request."expiresOn">=$2::date)
      AND (request."source"='CENTRAL_DIRECT' OR request."promiseAmount" IS NULL OR request."promiseDate" IS NULL
        OR request."promiseAmount">COALESCE((SELECT SUM(payment."valor") FROM "CreditoAbono" payment
          WHERE payment."creditoId"=request."creditoId" AND UPPER(BTRIM(payment."estado"))<>'ANULADO'
            AND request."decidedAt" IS NOT NULL AND payment."fechaAbono">=(request."decidedAt" AT TIME ZONE 'UTC')
            AND payment."fechaAbono"<((request."promiseDate"+1)::timestamp + interval '5 hours')
            AND payment."fechaAbono"<=($3::timestamptz AT TIME ZONE 'UTC')),0))
    ORDER BY request."creditoId",request."updatedAt" DESC,request."id" DESC`, ids, colombiaDateKey(now), now.toISOString());
  return new Map(rows.map(({ creditoId, ...row }) => [creditoId, {
    ...row, expiresOn: dateKey(row.expiresOn), installmentDueDate: dateKey(row.installmentDueDate),
    approvedAt: row.approvedAt === null ? null : new Date(row.approvedAt).toISOString(),
  }]));
}
