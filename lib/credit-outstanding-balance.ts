import { getCapitalOutstandingBalance } from "@/lib/credit-principal-payment";
import { readMassCreditComponents, type MassCreditComponents } from "@/lib/mass-credit-financial-components";

export type OutstandingBalanceInput = {
  contratoSnapshot?: unknown;
  valorCuota?: number | null;
  plazoMeses?: number | null;
  planCapitalVigente?: unknown;
  totalAbonado?: number;
  montoCredito: number;
  saldoBaseFinanciado: number;
  saldoPendiente: number;
  valorEquipoTotal: number;
  cuotaInicial: number;
  valorFianza: number;
  valorInteres: number;
};

export type OutstandingBalanceBreakdown = {
  saldoCapital: number;
  saldoFianza: number;
  saldoIntereses: number;
  saldoSeguro?: number;
};

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function splitTaggedBalance(components: MassCreditComponents, pending: number): OutstandingBalanceBreakdown {
  const totalCents = BigInt(Math.round(components.total * 100));
  const pendingCents = BigInt(Math.max(0, Math.round(pending * 100)));
  const parts = [components.capital, components.fianza, components.intereses, components.seguro].map((value, index) => {
    const numerator = pendingCents * BigInt(Math.round(value * 100));
    return { index, assigned: numerator / totalCents, remainder: numerator % totalCents };
  });
  let remainder = pendingCents - parts.reduce((sum, part) => sum + part.assigned, BigInt("0"));
  const order = [...parts].sort((left, right) => left.remainder === right.remainder
    ? left.index - right.index : left.remainder > right.remainder ? -1 : 1);
  for (const part of order) {
    if (remainder <= BigInt("0")) break;
    part.assigned += BigInt("1");
    remainder -= BigInt("1");
  }
  return {
    saldoCapital: Number(parts[0].assigned) / 100,
    saldoFianza: Number(parts[1].assigned) / 100,
    saldoIntereses: Number(parts[2].assigned) / 100,
    saldoSeguro: Number(parts[3].assigned) / 100,
  };
}
export function splitOutstandingBalance(
  options: OutstandingBalanceInput
): OutstandingBalanceBreakdown {
  const saldoPendiente = roundMoney(options.saldoPendiente);
  if (options.planCapitalVigente != null && saldoPendiente > 0) {
    const capitalPlanBalance = getCapitalOutstandingBalance(
      options.planCapitalVigente,
      Number(options.totalAbonado || 0)
    );
    if (capitalPlanBalance) return capitalPlanBalance;
  }
  const components = readMassCreditComponents(options.contratoSnapshot, options);
  if (components) return splitTaggedBalance(components, saldoPendiente);
  const capitalOriginal =
    Number(options.saldoBaseFinanciado || 0) ||
    Math.max(0, Number(options.valorEquipoTotal || 0) - Number(options.cuotaInicial || 0));
  const fianzaOriginal = Math.max(0, Number(options.valorFianza || 0));
  const interesOriginal = Math.max(0, Number(options.valorInteres || 0));
  const totalOriginal =
    capitalOriginal + fianzaOriginal + interesOriginal ||
    Math.max(0, Number(options.montoCredito || 0));

  if (saldoPendiente <= 0) {
    return {
      saldoCapital: 0,
      saldoFianza: 0,
      saldoIntereses: 0,
    };
  }

  if (totalOriginal <= 0) {
    return {
      saldoCapital: saldoPendiente,
      saldoFianza: 0,
      saldoIntereses: 0,
    };
  }

  const saldoCapital = roundMoney((saldoPendiente * capitalOriginal) / totalOriginal);
  const saldoFianza = roundMoney((saldoPendiente * fianzaOriginal) / totalOriginal);
  const saldoIntereses = roundMoney(
    Math.max(0, saldoPendiente - saldoCapital - saldoFianza)
  );

  return {
    saldoCapital,
    saldoFianza,
    saldoIntereses,
  };
}
