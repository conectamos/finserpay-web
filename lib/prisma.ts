import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const GLOBAL_OMIT = {
  credito: {
    iphoneSelfieCedulaDataUrl: true,
    fotoEntregaDataUrl: true,
    fotoRemisionDataUrl: true,
  },
} as const;

export type AppPrismaClient = PrismaClient<never, typeof GLOBAL_OMIT>;

const globalForPrisma = globalThis as unknown as {
  prisma?: AppPrismaClient;
};

const REQUIRED_DELEGATES = [
  "rol",
  "aliado",
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

function hasRequiredDelegates(client: AppPrismaClient | undefined) {
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
    omit: GLOBAL_OMIT,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
