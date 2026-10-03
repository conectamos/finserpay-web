import { NextResponse } from "next/server";
import { buildClientPaymentReceiptPdf } from "@/lib/client-payment-receipt-pdf";
import { getCreditDisplayNumbers } from "@/lib/credit-display-number-server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { parseCapitalPlanSnapshot } from "@/lib/credit-principal-payment";
import { aresReceiptPlanView, readAresReconciledReceipt } from "@/lib/ares-reconciliation-receipt";
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
import { COLOMBIA_TIME_ZONE } from "@/lib/colombia-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function dateTimeLabel(value: Date | string | null | undefined) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("es-CO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: COLOMBIA_TIME_ZONE,
  });
}

function dateLabel(value: Date | string | null | undefined) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date
    ? value
    : new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00-05:00` : value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleDateString("es-CO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: COLOMBIA_TIME_ZONE,
  });
}

function cleanFilePart(value: string | null | undefined) {
  return String(value || "recibo")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function textValue(value: string | number | null | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized || "-";
}

function buildPlan(
  credito: {
    montoCredito: number | string;
    planCapitalVigente?: unknown;
    valorCuota: number | string;
    plazoMeses: number | null;
    frecuenciaPago: string | null;
    fechaPrimerPago: Date | null;
    fechaProximoPago: Date | null;
  },
  abonos: Array<{ valor: number | string; fechaAbono: Date }>,
  settled = false
) {
  return buildCreditPaymentPlan({
    planCapitalVigente: credito.planCapitalVigente,
    montoCredito: Number(credito.montoCredito || 0),
    valorCuota: Number(credito.valorCuota || 0),
    plazoMeses: Number(credito.plazoMeses || 1),
    frecuenciaPago: credito.frecuenciaPago,
    fechaPrimerPago: credito.fechaPrimerPago || credito.fechaProximoPago,
    fechaProximoPago: credito.fechaProximoPago,
    abonos: abonos.map((item) => ({
      valor: Number(item.valor || 0),
      fechaAbono: item.fechaAbono,
    })),
    settled,
  });
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string; abonoId: string }> }
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

    if (!admin && !supervisor) {
      return NextResponse.json(
        { error: "Solo supervisor o administrador puede imprimir recibos" },
        { status: 403 }
      );
    }

    const params = await context.params;
    const creditLookup = parseCreditRouteLookup(params.id);
    const abonoId = parseId(params.abonoId);

    if ((!creditLookup.id && !creditLookup.folio) || !abonoId) {
      return NextResponse.json({ error: "Recibo invalido" }, { status: 400 });
    }

    const lookupWhere = buildCreditLookupWhere(creditLookup);
    const accessWhere = buildCreditAccessWhere({
      admin,
      adminCentral,
      aliadoId: user.aliadoAccesoId,
      sedeId: user.sedeId,
      sellerSedeId: sellerSession?.sedeId,
      supervisor,
    });

    const abono = await prisma.creditoAbono.findFirst({
      where: {
        id: abonoId,
        credito: {
          AND: [lookupWhere, accessWhere],
        },
      },
      include: {
        credito: {
          include: {
            sede: {
              select: {
                nombre: true,
              },
            },
          },
        },
        usuario: {
          select: {
            nombre: true,
            usuario: true,
          },
        },
        vendedor: {
          select: {
            nombre: true,
            documento: true,
          },
        },
        sede: {
          select: {
            nombre: true,
          },
        },
      },
    });

    if (!abono) {
      return NextResponse.json({ error: "Abono no encontrado" }, { status: 404 });
    }

    const activeAbonos = await prisma.creditoAbono.findMany({
      where: {
        creditoId: abono.creditoId,
        estado: {
          not: "ANULADO",
        },
      },
      select: {
        id: true,
        valor: true,
        fechaAbono: true,
      },
      orderBy: [
        {
          fechaAbono: "asc",
        },
        {
          id: "asc",
        },
      ],
    });

    const abonoTime = abono.fechaAbono.getTime();
    const activeUntilThisPayment = activeAbonos.filter((item) => {
      const itemTime = item.fechaAbono.getTime();
      return itemTime < abonoTime || (itemTime === abonoTime && item.id <= abono.id);
    });
    const paymentTotalInCents = Math.round(
      activeUntilThisPayment.reduce(
        (sum, item) => sum + Number(item.valor || 0),
        0
      ) * 100
    );
    const closesCurrentCredit = Boolean(
      abono.credito.pazYSalvoEmitidoAt &&
        paymentTotalInCents >=
          Math.round(Number(abono.credito.montoCredito || 0) * 100)
    );
    const currentSnapshot = parseCapitalPlanSnapshot(abono.credito.planCapitalVigente);
    const aresReceipt = currentSnapshot
      ? await readAresReconciledReceipt(
          prisma, abono.creditoId, abono.id, Number(abono.valor)
        )
      : null;
    const aresPlanView = aresReceipt ? aresReceiptPlanView(aresReceipt) : null;
    const principalRevisions = currentSnapshot
      ? await prisma.$queryRaw<Array<{ abonoId: number; snapshotAfter: unknown; resultado: unknown }>>`
          SELECT "abonoId", "snapshotAfter", "resultado" FROM "CreditPrincipalPaymentRevision"
          WHERE "creditoId" = ${abono.creditoId} AND "abonoId" <= ${abono.id}
          ORDER BY "abonoId" DESC
          LIMIT 1
        `
      : [];
    const principalRevision = principalRevisions[0] || null;
    const receiptSnapshot = principalRevision
      ? parseCapitalPlanSnapshot(principalRevision.snapshotAfter)
      : aresPlanView?.snapshot || null;
    const result = principalRevision?.resultado as { quote?: {
      saldoCapitalAntes: number;
      saldoCapitalDespues: number;
      abonoCapital: number;
      cuotasEliminadas: number;
    } } | undefined;
    const isPrincipalPayment = principalRevision?.abonoId === abono.id;
    const principalQuote = isPrincipalPayment ? result?.quote || null : null;
    if (principalRevision && !receiptSnapshot) {
      throw new Error("La revision historica del recibo no contiene calendario.");
    }
    if (isPrincipalPayment && (!principalQuote ||
      ![principalQuote.saldoCapitalAntes, principalQuote.saldoCapitalDespues, principalQuote.abonoCapital, principalQuote.cuotasEliminadas]
        .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ||
      Math.round(principalQuote.abonoCapital * 100) !== Math.round(Number(abono.valor) * 100))) {
      throw new Error("El comprobante de capital no concilia con su revision.");
    }
    const isPriorToPrincipalCut = Boolean(
      currentSnapshot?.abonosAlCorte.some((item) => item.id === abono.id) &&
      !receiptSnapshot && !aresPlanView
    );
    // Never replay an earlier receipt against a later reamortization snapshot.
    const currentPlan = receiptSnapshot
      ? buildPlan({ ...abono.credito, planCapitalVigente: receiptSnapshot,
            // A later payment may have advanced the live due date; keep the ARES cut's dates.
            fechaProximoPago: aresReceipt ? null : abono.credito.fechaProximoPago },
          isPrincipalPayment || Boolean(aresPlanView?.snapshot)
            ? [{ valor: receiptSnapshot.totalAbonadoAlCorte, fechaAbono: abono.fechaAbono }]
            : activeAbonos.filter((item) => item.id <= abono.id))
      : aresPlanView || isPriorToPrincipalCut
        ? null
        : buildPlan(abono.credito, activeUntilThisPayment, closesCurrentCredit);
    const isAnnulled = String(abono.estado || "").toUpperCase() === "ANULADO";
    const reciboNumero = `RP-${abono.credito.folio}-${abono.id}`;
    const numeroCreditoVisible = (await getCreditDisplayNumbers([abono.creditoId])).get(abono.creditoId) || abono.credito.folio;
    const equipo =
      abono.credito.referenciaEquipo ||
      [abono.credito.equipoMarca, abono.credito.equipoModelo].filter(Boolean).join(" ") ||
      abono.credito.imei;
    const recibidoPor =
      abono.vendedor?.nombre ||
      abono.usuario.nombre ||
      abono.usuario.usuario;
    const totalInstallments = currentPlan
      ? currentPlan.installments.filter((item) => !item.eliminada).length
      : Math.max(1, Math.trunc(Number(abono.credito.plazoMeses || 1)));
    const nextInstallments = (currentPlan?.installments || [])
      .filter((item) => item.saldoPendiente > 0)
      .slice(0, 6);
    const buffer = await buildClientPaymentReceiptPdf({
      receiptNumber: reciboNumero,
      paymentDate: abono.fechaAbono,
      paymentMethod: abono.metodoPago,
      paymentAmount: Number(abono.valor || 0),
      clientName: abono.credito.clienteNombre,
      clientDocument: textValue(abono.credito.clienteDocumento),
      creditFolio: abono.credito.folio,
      numeroCreditoVisible,
      totalPaidThroughPayment: paymentTotalInCents / 100,
      paymentSequence: activeUntilThisPayment.length,
      paymentType: principalQuote ? "PRINCIPAL"
        : aresReceipt ? "ARES_RECONCILED"
        : /LIQUIDACI(?:O|Ó)N\s+ANTICIPADA/i.test(String(abono.observacion || "")) ? "EARLY_PAYOFF" : "PAYMENT",
      aresPayment: aresReceipt ? {
        document: aresReceipt.document,
        ordinaryInstallment: aresReceipt.ordinaryInstallment,
        extraordinaryPrincipal: aresReceipt.extraordinaryPrincipal,
        additionalInterest: aresReceipt.additionalInterest,
        lateFee: aresReceipt.lateFee,
      } : undefined,
      principalPayment: principalQuote ? {
        capitalBefore: principalQuote.saldoCapitalAntes,
        capitalApplied: principalQuote.abonoCapital,
        capitalAfter: principalQuote.saldoCapitalDespues,
        eliminatedInstallments: principalQuote.cuotasEliminadas,
      } : undefined,
      creditClosed: closesCurrentCredit,
      presentation: {
        format: "POS",
        showFullDocument: true,
        hidePaymentSequence: isAnnulled,
        status: textValue(abono.estado),
        operationalRows: [
          { label: "Fecha de impresión", value: dateTimeLabel(new Date()) },
          { label: "Sede", value: textValue(abono.sede.nombre) },
          { label: aresReceipt?.extraordinaryPrincipal ? "Conciliado por" : "Cajero", value: textValue(recibidoPor) },
          { label: "Teléfono", value: textValue(abono.credito.clienteTelefono) },
          { label: "Equipo", value: textValue(equipo) },
          { label: "IMEI", value: textValue(abono.credito.imei) },
          { label: "Frecuencia", value: getPaymentFrequencyLabel(abono.credito.frecuenciaPago) },
          ...(currentPlan ? [{ label: "Cuotas pagadas", value: `${currentPlan.paidCount} DE ${totalInstallments}` }] : []),
        ],
        upcomingInstallments: nextInstallments.map((item) => ({
          number: `${item.numero}/${totalInstallments}`,
          date: dateLabel(item.fechaVencimiento),
          amount: item.saldoPendiente,
        })),
        historicalPlanNotice: aresPlanView?.notice
          ? aresPlanView.notice
          : isPriorToPrincipalCut
            ? "Comprobante anterior al abono a capital. Consulta el plan vigente para los próximos pagos."
            : undefined,
        observation: abono.observacion,
        annulment: isAnnulled ? { date: abono.anuladoAt, reason: abono.anulacionMotivo } : undefined,
      },
    });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="recibo-pos-abono-${cleanFilePart(
          abono.credito.folio
        )}-${abono.id}.pdf"`,
      },
    });
  } catch (error) {
    console.error("ERROR DESCARGANDO RECIBO DE ABONO:", error);
    return NextResponse.json(
      { error: "No se pudo descargar el recibo" },
      { status: 500 }
    );
  }
}
