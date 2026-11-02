import prisma from "@/lib/prisma";
import { createDianaCreditHandler, readDianaExtensionProtections } from "@/lib/diana-credit-api";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createDianaCreditHandler({
  token: () => process.env.FINSERPAY_DIANA_API_TOKEN,
  lookup: async (documento) => {
    await ensureCreditAbonoAuditColumns();
    const credits = await prisma.credito.findMany({
      where: { clienteDocumento: documento, estado: { not: "ANULADO" } },
      select: {
        id: true, folio: true, estado: true, planCapitalVigente: true, montoCredito: true, valorCuota: true,
        contratoSnapshot: true, saldoBaseFinanciado: true, valorInteres: true, valorFianza: true,
        plazoMeses: true, frecuenciaPago: true, fechaPrimerPago: true,
        fechaProximoPago: true, pazYSalvoEmitidoAt: true,
        abonos: { where: { estado: { not: "ANULADO" } },
          select: { valor: true, fechaAbono: true, estado: true, anuladoAt: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const protections = await readDianaExtensionProtections(credits.map(credit => credit.id), ids =>
      prisma.$queryRawUnsafe(`SELECT id,"creditoId",type,status,"expiresOn" FROM "CreditMoraExceptionRequest"
        WHERE "creditoId"=ANY($1::int[]) AND status IN ('PENDING','APPROVED')`, ids));
    return credits.map(credit => ({ ...credit,
      montoCredito: Number(credit.montoCredito), valorCuota: Number(credit.valorCuota),
      saldoBaseFinanciado: Number(credit.saldoBaseFinanciado),
      valorInteres: Number(credit.valorInteres), valorFianza: Number(credit.valorFianza),
      abonos: credit.abonos.map(abono => ({ ...abono, valor: Number(abono.valor) })),
      extensionProtection: protections.get(credit.id) ?? { verified: false as const },
      extensionAbonos: credit.abonos.filter(abono => abono.estado.trim().toUpperCase() === "ACTIVO"
        && abono.anuladoAt === null && Number(abono.valor) > 0)
        .map(abono => ({ valor: Number(abono.valor), fechaAbono: abono.fechaAbono })),
    }));
  },
});

