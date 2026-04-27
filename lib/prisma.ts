import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const REQUIRED_DELEGATES = [
  "rol",
  "sede",
  "usuario",
  "vendedor",
  "sedeVendedor",
  "credito",
  "creditoAbono",
  "wompiPaymentIntent",
  "capturaCreditoSession",
  "cajaMovimiento",
] as const;

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

function hasRequiredDelegates(client: PrismaClient | undefined) {
  if (!client) {
    return false;
  }

  return REQUIRED_DELEGATES.every((key) => key in client);
}

const cachedPrisma = hasRequiredDelegates(globalForPrisma.prisma)
  ? globalForPrisma.prisma
  : undefined;

if (globalForPrisma.prisma && !cachedPrisma) {
  void globalForPrisma.prisma.$disconnect().catch(() => undefined);
}

const prisma =
  cachedPrisma ??
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
