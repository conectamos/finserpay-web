import "server-only";
import prisma from "@/lib/prisma";
import { ensureFirmaSeguroSchema } from "@/lib/firmaseguro-storage";
import { creditApprovalDocumentRefreshSchemaStatements } from "@/scripts/credit-approval-document-refresh-schema.mjs";

let setup: Promise<void> | null = null;
export function ensureCreditApprovalDocumentRefreshSchema() {
  if (!setup) setup = (async () => {
    await ensureFirmaSeguroSchema();
    await prisma.$transaction(async db => {
      for (const sql of creditApprovalDocumentRefreshSchemaStatements()) await db.$executeRawUnsafe(sql);
    });
  })().catch(error => { setup = null; throw error; });
  return setup;
}
