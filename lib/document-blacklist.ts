import "server-only";

import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { assertDocumentAllowed } from "@/lib/document-blacklist-store";

export async function assertDocumentNotBlacklisted(document: unknown, db?: Prisma.TransactionClient): Promise<void> {
  return assertDocumentAllowed(document, db ?? prisma, Boolean(db));
}
