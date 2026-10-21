import { getCreditDisplayNumbers } from "@/lib/credit-display-number-server";
import { buildAllyPaymentSettlementPdf } from "@/lib/ally-payment-settlement-pdf";
import type { getAllyPaymentDetail } from "@/lib/ally-payments";

// One mapper for downloads and delivery; the existing PDF layout and calculations stay intact.
export async function buildSavedSettlementPdf(settlement: Awaited<ReturnType<typeof getAllyPaymentDetail>>) {
const paidAt = new Date(settlement.pagadoAt);
if (Number.isNaN(paidAt.getTime())) {
  throw new Error("La liquidacion no tiene una fecha de pago valida.");
}

const annulmentAdjustments = Array.isArray(settlement.ajustesAnulacion)
  ? settlement.ajustesAnulacion
  : [];
const centralCollectionAdjustments = Array.isArray(settlement.ajustesRecaudoCentral)
  ? settlement.ajustesRecaudoCentral
  : [];
const visibleNumbers = await getCreditDisplayNumbers([
  ...settlement.recaudos.map(item => item.creditoId),
  ...annulmentAdjustments.map(item => item.creditoId),
  ...centralCollectionAdjustments.map(item => item.creditoId),
]);
const pdf = await buildAllyPaymentSettlementPdf({
  settlementId: settlement.id,
  allyName: settlement.aliado.nombre,
  periodStart: settlement.periodoInicio,
  periodEnd: settlement.periodoFin,
  bankApprovalNumber: settlement.numeroAprobacionBancaria,
  status: settlement.estado,
  paidAt,
  registeredBy: settlement.registradoPorNombre,
  creditCount: settlement.numeroCreditos,
  totalSaleValue: settlement.totalValorVenta,
  totalInitialPayment: settlement.totalCuotaInicial,
  totalAuthorizedCredit: settlement.totalCreditoAutorizado,
  totalIntermediation: settlement.totalIntermediacion,
  totalPayable: settlement.totalPagar,
  totalAllyCollections: settlement.totalRecaudosAliado,
  totalAnnulmentAdjustments: settlement.totalAjustesAnulacion,
  totalCentralCollectionAdjustments: settlement.totalAjustesRecaudoCentral,
  netBalance: settlement.saldoNeto,
  balanceDirection: settlement.direccionSaldo,
  platformSummary: {
    ANDROID: {
      creditCount: settlement.summary.ANDROID.numeroCreditos,
      intermediationPercentage:
        settlement.summary.ANDROID.porcentajeIntermediacion,
      payableValue: settlement.summary.ANDROID.totalPagar,
    },
    IPHONE: {
      creditCount: settlement.summary.IPHONE.numeroCreditos,
      intermediationPercentage:
        settlement.summary.IPHONE.porcentajeIntermediacion,
      payableValue: settlement.summary.IPHONE.totalPagar,
    },
  },
  lines: settlement.items.map((item) => ({
    creditId: item.creditoId,
    creditDate: item.fechaCredito,
    allyName: settlement.aliado.nombre,
    siteName: item.sede.nombre,
    clientName: item.clienteNombre,
    clientDocument: item.clienteDocumento,
    equipment: item.equipo,
    imei: item.imei,
    platform: item.plataforma,
    saleValue: item.valorVenta,
    initialPayment: item.cuotaInicial,
    authorizedCredit: item.creditoAutorizado,
    intermediationPercentage: item.porcentajeIntermediacion,
    intermediationValue: item.valorIntermediacion,
    payableValue: item.valorPagar,
    status: item.estado,
  })),
  collections: settlement.recaudos.map((item) => ({
    paymentDate: item.fechaAbono,
    folio: item.folio,
    numeroCreditoVisible: visibleNumbers.get(item.creditoId) || item.folio,
    clientName: item.clienteNombre,
    clientDocument: item.clienteDocumento,
    siteName: item.sedeNombre,
    paymentMethod: item.metodoPago,
    value: item.valor,
    status: item.estado,
  })),
  annulmentAdjustments: annulmentAdjustments.map((item) => ({
    adjustmentId: item.ajusteId ?? item.id,
    creditId: item.creditoId,
    annulledAt: item.fechaAnulacion,
    folio: item.folio,
    visibleCreditNumber: visibleNumbers.get(item.creditoId) || item.folio,
    clientName: item.clienteNombre,
    clientDocument: item.clienteDocumento,
    equipment: item.equipo,
    imei: item.imei,
    platform: item.plataforma,
    siteName: item.sedeNombre,
    sourceSettlementId: item.liquidacionOrigenId,
    discountValue: item.valorDescuento,
    reason: item.motivo,
    status: item.estado,
  })),
  centralCollectionAdjustments: centralCollectionAdjustments.map((item) => ({
    adjustmentId: item.ajusteId ?? item.id,
    creditId: item.creditoId,
    paymentDate: item.fechaAbono,
    adjustmentDate: item.fechaAjuste,
    folio: item.folio,
    visibleCreditNumber: visibleNumbers.get(item.creditoId) || item.folio,
    clientName: item.clienteNombre,
    clientDocument: item.clienteDocumento,
    siteName: item.sedeNombre,
    paymentMethod: item.metodoPago,
    sourceSettlementId: item.liquidacionOrigenId,
    registeredBy: item.usuarioRecaudoNombre,
    registeredByUsername: item.usuarioRecaudoLogin,
    value: item.valorAjuste,
    reason: item.motivo,
    status: item.estado,
  })),
});
return pdf;
}
