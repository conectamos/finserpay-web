import prisma from "@/lib/prisma";

let userProfileVisualColumnsReady = false;

export async function ensureUserProfileVisualColumns() {
  if (userProfileVisualColumnsReady) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Usuario"
    ADD COLUMN IF NOT EXISTS "avatarKey" TEXT
  `);

  userProfileVisualColumnsReady = true;
}
