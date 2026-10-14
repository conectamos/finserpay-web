import "server-only";

import {
  creditAbonoAllyAttributionSchemaStatements,
  creditAbonoAllyAttributionValidationStatements,
} from "../scripts/credit-abono-ally-attribution-schema.mjs";
import { creditAllyPaymentExclusionSchemaStatements } from "../scripts/credit-ally-payment-exclusion-schema.mjs";
import {
  allyPaymentCentralCollectionAdjustmentSchemaStatements,
  allyPaymentCentralCollectionAdjustmentValidationStatements,
} from "../scripts/ally-payment-central-collection-adjustment-schema.mjs";
import prisma from "@/lib/prisma";

let schemaReady: Promise<void> | null = null;

export function ensureCreditAllyPaymentExclusionSchema() {
  if (!schemaReady) {
    schemaReady = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
      // Share the predeploy lock before touching exclusion or settlement tables.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('finserpay-ally-payments-schema'))");
      for (const statement of [
        ...creditAbonoAllyAttributionSchemaStatements,
        ...creditAllyPaymentExclusionSchemaStatements,
        ...allyPaymentCentralCollectionAdjustmentSchemaStatements,
        ...creditAbonoAllyAttributionValidationStatements,
        ...allyPaymentCentralCollectionAdjustmentValidationStatements,
      ]) {
        await tx.$executeRawUnsafe(statement);
      }
    }, { timeout: 30_000 }).catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}
