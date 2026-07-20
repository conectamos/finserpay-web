import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { buildCreditPaymentPlanPdf } from "@/lib/credit-payment-plan-pdf";
import { getPaymentFrequencyLabel } from "@/lib/credit-factory";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  buildCreditAccessWhere,
  buildCreditLookupWhere,
  parseCreditRouteLookup,
} from "@/lib/credit-route-lookup";
import { isFinserPayCentralAlly } from "@/lib/aliados";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EFECTY_CONVENIO_FINSER_PAY =
  process.env.EFECTY_CONVENIO_FINSER_PAY || "113950";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    await ensureCreditAbonoAuditColumns();

    const admin = isAdminRole(user.rolNombre);
    const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const sellerSession = admin ? null : await getSellerSessionUser(user);
    const supervisor = sellerSession?.tipoPerfil === "SUPERVISOR";

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    const params = await context.params;
    const creditLookup = parseCreditRouteLookup(params.id);

    if (!creditLookup.id && !creditLookup.folio) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    const credito = await prisma.credito.findFirst({
      where: {
        AND: [
          buildCreditLookupWhere(creditLookup),
          buildCreditAccessWhere({
            admin,
            adminCentral,
            aliadoId: user.aliadoAccesoId,
            sedeId: user.sedeId,
            sellerSedeId: sellerSession?.sedeId,
            supervisor,
          }),
        ],
      },
      include: {
        sede: { select: { nombre: true } },
      },
    });

    if (!credito) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    const abonos = await prisma.creditoAbono.findMany({
      where: {
        creditoId: credito.id,
        estado: { not: "ANULADO" },
      },
      select: { valor: true, fechaAbono: true },
      orderBy: { fechaAbono: "asc" },
    });
    const plan = buildCreditPaymentPlan({
      montoCredito: Number(credito.montoCredito || 0),
      valorCuota: Number(credito.valorCuota || 0),
      plazoMeses: Number(credito.plazoMeses || 1),
      frecuenciaPago: credito.frecuenciaPago,
      fechaPrimerPago: credito.fechaPrimerPago || credito.fechaProximoPago,
      abonos: abonos.map((item) => ({
        valor: Number(item.valor || 0),
        fechaAbono: item.fechaAbono,
      })),
    });
    const buffer = await buildCreditPaymentPlanPdf({
      folio: credito.folio,
      clienteNombre: credito.clienteNombre,
      clienteDocumento: credito.clienteDocumento || "-",
      sedeNombre: credito.sede.nombre,
      equipo: credito.referenciaEquipo || credito.imei || "-",
      fechaGeneracion: new Date(),
      valorCuota: Number(credito.valorCuota || 0),
      frecuencia: getPaymentFrequencyLabel(credito.frecuenciaPago),
      saldoContractual: Math.max(0, Number(credito.montoCredito || 0) - plan.totalPaid),
      referenciaEfecty: credito.clienteDocumento || credito.folio,
      convenioEfecty: EFECTY_CONVENIO_FINSER_PAY,
      plan,
    });

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="plan-pagos-${credito.folio}.pdf"`,
      },
    });
  } catch (error) {
    console.error("ERROR DESCARGANDO PLAN DE PAGOS:", error);
    return NextResponse.json(
      { error: "No se pudo descargar el plan de pagos" },
      { status: 500 }
    );
  }
}
