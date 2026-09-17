import { annualEffectiveToMonthlyEffectiveRate } from "@/lib/credit-factory";

export type CarteraExportScope = "cartera" | "mora";

const EXCLUDED_CREDIT_STATES = new Set([
  "ANULADO",
  "ANULADA",
  "CANCELADO",
  "CANCELADA",
]);

type CreditAmortizationRates = {
  tasaInteresEaPorcentaje?: unknown;
  fianzaCuotaPorcentaje?: unknown;
  seguroCuotaPorcentaje?: unknown;
  numeroCuotas?: unknown;
};

type CarteraExportRatesInput = {
  tasaInteresEa?: unknown;
  fianzaPorcentaje?: unknown;
  contratoSnapshot?: unknown;
  amortizacion?: CreditAmortizationRates | null;
};

function objectRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeNumber(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function positiveNumber(value: unknown) {
  const numeric = nonNegativeNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const numeric = nonNegativeNumber(value);

    if (numeric !== null) {
      return numeric;
    }
  }

  return null;
}

function percentageFraction(value: number | null) {
  return value === null ? null : value / 100;
}

export function shouldIncludeCarteraExportCredit(input: {
  scope: CarteraExportScope;
  saldoPendiente: unknown;
  hasOverdueInstallment: boolean;
}) {
  if (input.scope === "cartera") {
    return true;
  }

  const saldoPendiente = nonNegativeNumber(input.saldoPendiente) ?? 0;
  return saldoPendiente > 0 && input.hasOverdueInstallment;
}

export function isExcludedCarteraCreditState(value: unknown) {
  return EXCLUDED_CREDIT_STATES.has(String(value ?? "").trim().toUpperCase());
}

export function resolveCarteraExportRates(input: CarteraExportRatesInput) {
  const financiero = objectRecord(
    objectRecord(input.contratoSnapshot)?.financiero
  );
  const amortizacion = input.amortizacion;
  const amortizacionCuotas = positiveNumber(amortizacion?.numeroCuotas);
  const amortizacionFianzaCuota = nonNegativeNumber(
    amortizacion?.fianzaCuotaPorcentaje
  );
  const snapshotCuotas = positiveNumber(
    financiero?.cuotas ?? financiero?.plazo
  );
  const snapshotFianzaCuota = nonNegativeNumber(
    financiero?.fianzaCuotaPorcentaje
  );
  const tasaInteresEa = firstNumber(
    amortizacion?.tasaInteresEaPorcentaje,
    financiero?.tasaInteresEa,
    input.tasaInteresEa
  );
  const fianzaTotalPorcentaje = firstNumber(
    amortizacionCuotas !== null && amortizacionFianzaCuota !== null
      ? amortizacionCuotas * amortizacionFianzaCuota
      : null,
    financiero?.fianzaTotalPorcentaje,
    financiero?.fianzaPorcentaje,
    snapshotCuotas !== null && snapshotFianzaCuota !== null
      ? snapshotCuotas * snapshotFianzaCuota
      : null,
    input.fianzaPorcentaje
  );
  const seguroCuotaPorcentaje = firstNumber(
    amortizacion?.seguroCuotaPorcentaje,
    financiero?.seguroCuotaPorcentaje
  );

  return {
    interesMensual:
      tasaInteresEa === null
        ? null
        : annualEffectiveToMonthlyEffectiveRate(tasaInteresEa),
    fianza: percentageFraction(fianzaTotalPorcentaje),
    seguro: percentageFraction(seguroCuotaPorcentaje),
  };
}

export function formatCarteraPercentageCell(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "<td></td>";
  }

  return `<td style='mso-number-format:"0.0000%";'>${value}</td>`;
}
