import prisma from "@/lib/prisma";

let creditAbonoAuditColumnsReady = false;

export async function ensureCreditAbonoAuditColumns() {
  if (creditAbonoAuditColumnsReady) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoAbono"
    ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'ACTIVO'
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoAbono"
    ADD COLUMN IF NOT EXISTS "anuladoAt" TIMESTAMP(3)
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoAbono"
    ADD COLUMN IF NOT EXISTS "anulacionMotivo" TEXT
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "CreditoAbono"
    ADD COLUMN IF NOT EXISTS "anuladoPorUsuarioId" INTEGER
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "CreditoAbono_estado_creditoId_idx"
    ON "CreditoAbono" (estado, "creditoId")
  `);

  creditAbonoAuditColumnsReady = true;
}
