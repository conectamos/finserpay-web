import "server-only";
import prisma from "@/lib/prisma";
import { analystMoraSchemaStatements } from "@/scripts/analyst-mora-schema.mjs";
let ready: Promise<void> | null = null;
export async function ensureAnalystMoraSchema() {
  ready ??= prisma.$transaction(async db => {
    for (const sql of analystMoraSchemaStatements() as string[]) await db.$executeRawUnsafe(sql);
  }).then(() => undefined).catch(error => { ready = null; throw error; });
  await ready;
}
