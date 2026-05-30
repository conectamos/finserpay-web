import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";

export const EARLY_PAYOFF_PAYMENT_TYPE = "LIQUIDACION_ANTICIPADA";

export type CreditEarlyPayoffInput = {
  abonos?: Array<{
    fechaAbono?: Date | string | null;
    valor?: number | null;
  }>;
  fechaPrimerPago?: Date | string | null;
  fechaProximoPago?: Date | string | null;
  frecuenciaPago?: string | null;
  montoCredito?: number | null;
  plazoMeses?: number | null;
  saldoBaseFinanciado?: number | null;
  today?: Date | string | null;
  valorCuota?: number | null;
  valorFianza?: number | null;
  valorInteres?: number | null;
};

export type CreditEarlyPayoffResult = {
  capitalAbonado: number;
  capitalOriginal: number;
  capitalPendiente: number;
  eligible: boolean;
  estadoPago: "PAGADO" | "AL_DIA" | "MORA";
  interesFianzaCondonado: number;
  montoCreditoLiquidado: number;
  montoCreditoOriginal: number;
  reason: string | null;
  saldoObligacion: number;
  totalAbonado: number;
  valorFianzaReconocida: number;
  valorInteresReconocido: number;
};

export type EarlyPayoffIntentMeta = {
  tipo: typeof EARLY_PAYOFF_PAYMENT_TYPE;
  capitalPendiente: number;
  condonacion: number;
  montoCreditoLiquidado: number;
  saldoObligacion: number;
};

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizePending(value: number) {
  const rounded = roundMoney(value);
  return rounded < 1 ? 0 : rounded;
}

function resolveCapitalOriginal(input: CreditEarlyPayoffInput) {
  const saldoBase = Math.max(0, Number(input.saldoBaseFinanciado || 0));

  if (saldoBase > 0) {
    return roundMoney(saldoBase);
  }

  const montoCredito = Math.max(0, Number(input.montoCredito || 0));
  const cargos =
    Math.max(0, Number(input.valorInteres || 0)) +
    Math.max(0, Number(input.valorFianza || 0));

  return roundMoney(Math.max(0, montoCredito - cargos));
}

export function calculateCreditEarlyPayoff(
  input: CreditEarlyPayoffInput
): CreditEarlyPayoffResult {
  const montoCreditoOriginal = roundMoney(Math.max(0, Number(input.montoCredito || 0)));
  const capitalOriginal = resolveCapitalOriginal(input);
  const plan = buildCreditPaymentPlan({
    montoCredito: montoCreditoOriginal,
    valorCuota: input.valorCuota,
    plazoMeses: input.plazoMeses,
    frecuenciaPago: input.frecuenciaPago,
    fechaPrimerPago: input.fechaPrimerPago || input.fechaProximoPago,
    abonos: input.abonos,
    today: input.today,
  });
  const totalAbonado = roundMoney(plan.totalPaid);
  const estadoPago = plan.estadoPago as CreditEarlyPayoffResult["estadoPago"];
  const saldoObligacion = normalizePending(plan.saldoPendiente);
  const capitalShare =
    montoCreditoOriginal > 0
      ? Math.min(1, Math.max(0, capitalOriginal / montoCreditoOriginal))
      : 1;
  const capitalAbonado = roundMoney(Math.min(capitalOriginal, totalAbonado * capitalShare));
  const capitalPendiente = normalizePending(
    Math.min(saldoObligacion, Math.max(0, capitalOriginal - capitalAbonado))
  );
  const montoCreditoLiquidado = roundMoney(totalAbonado + capitalPendiente);
  const interesFianzaCondonado = normalizePending(
    Math.max(0, saldoObligacion - capitalPendiente)
  );
  const cargosReconocidos = roundMoney(Math.max(0, montoCreditoLiquidado - capitalOriginal));
  const valorInteresOriginal = Math.max(0, Number(input.valorInteres || 0));
  const valorFianzaOriginal = Math.max(0, Number(input.valorFianza || 0));
  const cargosOriginales = valorInteresOriginal + valorFianzaOriginal;
  const interesShare =
    cargosOriginales > 0 ? Math.max(0, valorInteresOriginal / cargosOriginales) : 0;
  const valorInteresReconocido = roundMoney(cargosReconocidos * interesShare);
  const valorFianzaReconocida = roundMoney(
    Math.max(0, cargosReconocidos - valorInteresReconocido)
  );
  let reason: string | null = null;

  if (estadoPago === "PAGADO" || saldoObligacion <= 0) {
    reason = "El credito ya esta pagado.";
  } else if (estadoPago !== "AL_DIA") {
    reason = "La liquidacion anticipada solo aplica cuando el credito esta al dia.";
  } else if (capitalPendiente <= 0) {
    reason = "No hay capital pendiente para liquidar.";
  }

  return {
    capitalAbonado,
    capitalOriginal,
    capitalPendiente,
    eligible: !reason,
    estadoPago,
    interesFianzaCondonado,
    montoCreditoLiquidado,
    montoCreditoOriginal,
    reason,
    saldoObligacion,
    totalAbonado,
    valorFianzaReconocida,
    valorInteresReconocido,
  };
}

export function buildEarlyPayoffIntentMeta(
  payoff: CreditEarlyPayoffResult
): EarlyPayoffIntentMeta {
  return {
    tipo: EARLY_PAYOFF_PAYMENT_TYPE,
    capitalPendiente: payoff.capitalPendiente,
    condonacion: payoff.interesFianzaCondonado,
    montoCreditoLiquidado: payoff.montoCreditoLiquidado,
    saldoObligacion: payoff.saldoObligacion,
  };
}

export function isEarlyPayoffIntentMeta(value: unknown): value is EarlyPayoffIntentMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { tipo?: unknown }).tipo === EARLY_PAYOFF_PAYMENT_TYPE
  );
}

export function buildEarlyPayoffObservation(
  payoff: CreditEarlyPayoffResult,
  prefix = "Liquidacion anticipada"
) {
  return [
    prefix,
    `Capital pagado hoy ${roundMoney(payoff.capitalPendiente)}`,
    `Saldo anterior ${roundMoney(payoff.saldoObligacion)}`,
    `Condonado intereses/fianza ${roundMoney(payoff.interesFianzaCondonado)}`,
  ].join(" - ");
}
