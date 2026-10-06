import "server-only";
import prisma from "@/lib/prisma";
import { moraExceptionRequestSchemaStatements } from "@/scripts/mora-exception-requests-schema.mjs";

let ready: Promise<void> | null = null;

export async function ensureMoraExceptionRequestSchema() {
  ready ??= prisma.$transaction(async db => {
    for (const sql of moraExceptionRequestSchemaStatements() as string[]) await db.$executeRawUnsafe(sql);
  }).then(() => undefined).catch(error => {
    ready = null;
    throw error;
  });
  await ready;
}
