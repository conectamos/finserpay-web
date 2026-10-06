import prisma from "@/lib/prisma";
import { createDianaCreditHandler } from "@/lib/diana-credit-api";
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
        folio: true, estado: true, planCapitalVigente: true, montoCredito: true, valorCuota: true,
        plazoMeses: true, frecuenciaPago: true, fechaPrimerPago: true,
        fechaProximoPago: true, pazYSalvoEmitidoAt: true,
        abonos: { where: { estado: { not: "ANULADO" } },
          select: { valor: true, fechaAbono: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return credits.map(credit => ({ ...credit,
      montoCredito: Number(credit.montoCredito), valorCuota: Number(credit.valorCuota),
      abonos: credit.abonos.map(abono => ({ ...abono, valor: Number(abono.valor) })),
    }));
  },
});

