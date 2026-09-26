import "server-only";

import { creditAllyPaymentExclusionSchemaStatements } from "../scripts/credit-ally-payment-exclusion-schema.mjs";
import prisma from "@/lib/prisma";

let schemaReady: Promise<void> | null = null;

export function ensureCreditAllyPaymentExclusionSchema() {
  if (!schemaReady) {
    schemaReady = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
      // Share the predeploy lock before touching exclusion or settlement tables.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('finserpay-ally-payments-schema'))");
      for (const statement of creditAllyPaymentExclusionSchemaStatements) {
        await tx.$executeRawUnsafe(statement);
      }
    }, { timeout: 30_000 }).catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}
