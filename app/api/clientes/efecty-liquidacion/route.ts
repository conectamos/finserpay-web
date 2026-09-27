import { NextResponse } from "next/server";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  buildEarlyPayoffIntentMeta,
  calculateCreditEarlyPayoff,
} from "@/lib/credit-early-payoff";
import { sanitizeSearch, toNumber } from "@/lib/credit-factory";
import {
  createEfectyPayoffIntent,
  ensureEfectyPayoffIntentTable,
} from "@/lib/efecty-payoff-intents";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EFECTY_CONVENIO = "113950";

type RequestBody = {
  creditoId?: number | string;
  documento?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RequestBody;
    const creditoId = Math.trunc(toNumber(body.creditoId));
    const documento = sanitizeSearch(body.documento).replace(/\D/g, "");
    if (!creditoId || documento.length < 5) {
      return NextResponse.json(
        { error: "Datos de cliente o crédito inválidos" },
        { status: 400 }
      );
    }

    await ensureCreditAbonoAuditColumns();
    await ensureEfectyPayoffIntentTable();

    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id" FROM "Credito" WHERE "id" = ${creditoId} FOR UPDATE
      `;
      if (!locked.length) return { kind: "NOT_FOUND" as const };

      const credit = await tx.credito.findFirst({
        where: {
          id: creditoId,
          clienteDocumento: documento,
          estado: { not: "ANULADO" },
        },
        select: {
          id: true,
          clienteDocumento: true,
          contratoSnapshot: true,
          saldoBaseFinanciado: true,
          planCapitalVigente: true,
          montoCredito: true,
          valorInteres: true,
          valorFianza: true,
          valorCuota: true,
          plazoMeses: true,
          frecuenciaPago: true,
          fechaPrimerPago: true,
          fechaProximoPago: true,
          pazYSalvoEmitidoAt: true,
        },
      });
      if (!credit) return { kind: "NOT_FOUND" as const };
      if (credit.pazYSalvoEmitidoAt) return { kind: "CLOSED" as const };

      const abonos = await tx.creditoAbono.findMany({
        where: { creditoId, estado: { not: "ANULADO" } },
        select: { fechaAbono: true, valor: true },
        orderBy: { fechaAbono: "asc" },
      });
      const now = new Date();
      const payoff = calculateCreditEarlyPayoff({
        contratoSnapshot: credit.contratoSnapshot,
        planCapitalVigente: credit.planCapitalVigente,
        saldoBaseFinanciado: Number(credit.saldoBaseFinanciado || 0),
        montoCredito: Number(credit.montoCredito || 0),
        valorInteres: Number(credit.valorInteres || 0),
        valorFianza: Number(credit.valorFianza || 0),
        valorCuota: Number(credit.valorCuota || 0),
        plazoMeses: Number(credit.plazoMeses || 1),
        frecuenciaPago: credit.frecuenciaPago,
        fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
        fechaProximoPago: credit.fechaProximoPago,
        abonos: abonos.map((item) => ({
          valor: Number(item.valor || 0),
          fechaAbono: item.fechaAbono,
        })),
        today: now,
      });
      if (!payoff.eligible) {
        return { kind: "INELIGIBLE" as const, reason: payoff.reason };
      }

      const referencia = String(credit.clienteDocumento || "").replace(/\D/g, "");
      const amountInCents = Math.round(payoff.capitalPendiente * 100);
      const intent = await createEfectyPayoffIntent(tx, {
        creditoId: credit.id,
        referencia,
        amountInCents,
        quote: buildEarlyPayoffIntentMeta(payoff),
        now,
      });
      return {
        kind: "READY" as const,
        intent: {
          id: intent.id,
          convenio: EFECTY_CONVENIO,
          referencia: intent.referencia,
          amount: intent.amountInCents / 100,
          expiresAt: intent.expiresAt.toISOString(),
        },
      };
    });

    if (result.kind === "NOT_FOUND") {
      return NextResponse.json(
        { error: "Crédito no encontrado para ese documento" },
        { status: 404 }
      );
    }
    if (result.kind === "CLOSED") {
      return NextResponse.json(
        { error: "Este crédito ya está liquidado" },
        { status: 409 }
      );
    }
    if (result.kind === "INELIGIBLE") {
      return NextResponse.json(
        { error: result.reason || "La liquidación anticipada no está disponible hoy" },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, ...result.intent });
  } catch (error) {
    console.error("ERROR INTENCION EFECTY LIQUIDACION:", error);
    return NextResponse.json(
      { error: "No pudimos preparar la liquidación en Efecty. Intenta de nuevo." },
      { status: 500 }
    );
  }
}
