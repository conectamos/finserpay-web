import prisma from "@/lib/prisma";

let vendorProfileVisualColumnsReady = false;

export async function ensureVendorProfileVisualColumns() {
  if (vendorProfileVisualColumnsReady) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Vendedor"
    ADD COLUMN IF NOT EXISTS "tipoPerfil" TEXT NOT NULL DEFAULT 'VENDEDOR'
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Vendedor"
    ADD COLUMN IF NOT EXISTS "avatarKey" TEXT
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "Vendedor"
    SET "tipoPerfil" = 'SUPERVISOR'
    WHERE "tipoPerfil" = 'VENDEDOR'
      AND "avatarKey" IS NULL
      AND UPPER(nombre) LIKE '%SUPERVISOR%'
  `);

  vendorProfileVisualColumnsReady = true;
}
