import { timingSafeEqual } from "node:crypto";
import { buildCreditPaymentPlan, type CreditPaymentPlanInput } from "@/lib/credit-payment-plan";
import { calculateCreditEarlyPayoff, type CreditEarlyPayoffInput } from "@/lib/credit-early-payoff";
import { extensionEligibility } from "@/lib/atencion-financial-core";

type DianaOpenProtection = NonNullable<Parameters<typeof extensionEligibility>[1]>;
export type DianaExtensionProtection = { verified: true; open: DianaOpenProtection | null } | { verified: false };

/** A failed/unknown protection read must never look like an unprotected credit. */
export async function readDianaExtensionProtections(creditIds: number[], read: (ids: number[]) => Promise<unknown>): Promise<Map<number, DianaExtensionProtection>> {
  const ids = [...new Set(creditIds)];
  const unavailable = new Map<number, DianaExtensionProtection>(ids.map(id => [id, { verified: false }]));
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1)) return unavailable;
  try {
    const rows = await read(ids);
    if (!Array.isArray(rows)) return unavailable;
    const open = new Map<number, DianaOpenProtection>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || !ids.includes(row.creditoId) || open.has(row.creditoId)
        || typeof row.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(row.id)
        || !["EXCEPCION", "PRORROGA"].includes(row.type) || !["PENDING", "APPROVED"].includes(row.status)) return unavailable;
      const expiresOn = row.expiresOn;
      if (expiresOn !== null) {
        const date = expiresOn instanceof Date ? expiresOn : typeof expiresOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expiresOn) ? new Date(`${expiresOn}T00:00:00Z`) : null;
        if (!date || !Number.isFinite(date.getTime()) || (typeof expiresOn === "string" && date.toISOString().slice(0, 10) !== expiresOn)) return unavailable;
      }
      open.set(row.creditoId, { id: row.id, type: row.type, status: row.status, expiresOn });
    }
    return new Map(ids.map(id => [id, { verified: true, open: open.get(id) || null }]));
  } catch {
    return unavailable;
  }
}

export type DianaCredit = CreditPaymentPlanInput & Pick<CreditEarlyPayoffInput,
  "contratoSnapshot" | "saldoBaseFinanciado" | "valorInteres" | "valorFianza"> & {
  folio: string;
  estado: string;
  fechaProximoPago?: Date | null;
  pazYSalvoEmitidoAt?: Date | null;
  extensionProtection?: DianaExtensionProtection;
  /** Active, non-annulled payments, using the same filter as the CRM. */
  extensionAbonos?: CreditPaymentPlanInput["abonos"];
};

function extensionOptions(credit: DianaCredit, now: Date, paid: boolean) {
  const unverified = { verificada: false, disponible: false,
    motivo: "No se pudo verificar la protección vigente del crédito. Solicita revisión con un analista.",
    cuotaNumero: null, vencimientoCuota: null, opciones: [],
    compromisoSugerido: { valor: null, fecha: null }, consultadoAt: now.toISOString() };
  if (!credit.extensionProtection?.verified) return unverified;
  try {
    const eligibility = extensionEligibility({ ...credit, abonos: credit.extensionAbonos ?? credit.abonos,
      pazYSalvoEmitidoAt: credit.pazYSalvoEmitidoAt ?? null }, credit.extensionProtection.open, now);
    // Legacy PAZ_Y_SALVO rows may lack a timestamp or a complete payment ledger.
    // Do not offer an extension while the existing financial answer says paid.
    if (paid) return { ...unverified, verificada: true,
      motivo: "El crédito está pagado y no tiene una cuota regular pendiente." };
    return { verificada: true, disponible: eligibility.canGrant, motivo: eligibility.blockedReason,
      cuotaNumero: eligibility.installmentNumber, vencimientoCuota: eligibility.dueDate,
      opciones: eligibility.choices.map(choice => ({ dias: choice.days, fechaLimite: choice.expiresOn })),
      compromisoSugerido: eligibility.canGrant ? { valor: eligibility.promise.amount, fecha: eligibility.promise.date }
        : { valor: null, fecha: null }, consultadoAt: now.toISOString() };
  } catch {
    return unverified;
  }
}

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
          prorroga: extensionOptions(credit, consultadoAt, plan.estadoPago === "PAGADO"),
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
