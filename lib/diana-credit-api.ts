import { timingSafeEqual } from "node:crypto";
import { buildCreditPaymentPlan, type CreditPaymentPlanInput } from "@/lib/credit-payment-plan";
import { calculateCreditEarlyPayoff, type CreditEarlyPayoffInput } from "@/lib/credit-early-payoff";

export type DianaCredit = CreditPaymentPlanInput & Pick<CreditEarlyPayoffInput,
  "contratoSnapshot" | "saldoBaseFinanciado" | "valorInteres" | "valorFianza"> & {
  folio: string;
  estado: string;
  fechaProximoPago?: Date | null;
  pazYSalvoEmitidoAt?: Date | null;
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "private, no-store", Vary: "Authorization",
  } });
}

export function createDianaCreditHandler(deps: {
  token: () => string | undefined;
  lookup: (documento: string) => Promise<DianaCredit[]>;
  now?: () => Date;
}) {
  return async function POST(req: Request) {
    const expected = deps.token()?.trim();
    if (!expected) return json({ ok: false, error: "Integracion Diana no configurada" }, 503);
    const received = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") || "")?.[1] || "";
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }
    if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return json({ ok: false, error: "Usa Content-Type: application/json" }, 415);
    }
    let body: unknown;
    try { body = await req.json(); }
    catch { return json({ ok: false, error: "JSON invalido" }, 400); }
    const documento = body && typeof body === "object" && "cedula" in body
      ? (body as { cedula: unknown }).cedula : null;
    if (typeof documento !== "string" || !/^\d{5,15}$/.test(documento.trim())) {
      return json({ ok: false, error: "cedula debe ser un texto de 5 a 15 digitos" }, 400);
    }
    try {
      const consultadoAt = (deps.now || (() => new Date()))();
      const credits = await deps.lookup(documento.trim());
      const creditos = credits.map((credit) => {
        const paymentInput = { ...credit,
          fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
          settled: Boolean(credit.pazYSalvoEmitidoAt) || credit.estado === "PAZ_Y_SALVO",
          today: consultadoAt,
        };
        const plan = buildCreditPaymentPlan(paymentInput);
        const payoff = calculateCreditEarlyPayoff(paymentInput);
        const proxima = plan.saldoPendiente > 0 ? plan.nextInstallment : null;
        const saldoVencido = Math.round(plan.installments.reduce((sum, item) =>
          sum + (item.estaEnMora ? item.saldoPendiente : 0), 0) * 100) / 100;
        return {
          folio: credit.folio,
          estado: plan.estadoPago,
          saldoPendiente: plan.saldoPendiente,
          saldoVencido,
          valorAPagar: plan.estadoPago === "MORA" ? saldoVencido : proxima?.saldoPendiente || 0,
          fechaVencimiento: proxima?.fechaVencimiento || null,
          cuotasPagadas: plan.paidCount,
          cuotasPendientes: plan.pendingCount,
          cuotasTotales: plan.installments.filter(item => !item.eliminada).length,
          totalCuotasPendientes: plan.saldoPendiente,
          cuotasEnMora: plan.overdueCount,
          liquidacionAnticipada: {
            disponible: payoff.eligible,
            capitalPendiente: payoff.eligible ? payoff.capitalPendiente : null,
            motivo: payoff.reason,
            consultadoAt: consultadoAt.toISOString(),
            proximaCuotaFecha: proxima?.fechaVencimiento || null,
          },
          orientacion: plan.estadoPago === "PAGADO"
            ? "El credito esta pagado. Puedes consultar tus documentos en el portal de clientes."
            : plan.estadoPago === "MORA"
              ? "Tienes cuotas vencidas. Consulta el portal para revisar y pagar el saldo vencido. Si ya pagaste y el abono no aparece, solicita revision del comprobante con soporte."
              : "Tu credito esta al dia. Consulta el portal para pagar la proxima cuota antes de su vencimiento.",
        };
      });
      return json({ ok: true, encontrado: creditos.length > 0,
        estado: !creditos.length ? "SIN_CREDITOS" : creditos.some(c => c.estado === "MORA") ? "MORA"
          : creditos.some(c => c.estado === "AL_DIA") ? "AL_DIA" : "PAGADO",
        moneda: "COP", consultadoAt: consultadoAt.toISOString(),
        portalClientes: "https://finserpay.com/clientes", creditos });
    } catch {
      console.error("ERROR CONSULTA DIANA: no se pudo consultar el credito");
      return json({ ok: false, error: "No se pudo consultar el credito. Intenta nuevamente." }, 500);
    }
  };
}
