export const MASS_CREDIT_COMPONENTS_VERSION = "MASIVO_COMPONENTES_V1" as const;

export type MassCreditComponents = {
  version: typeof MASS_CREDIT_COMPONENTS_VERSION;
  capital: number;
  cuota: number;
  numeroCuotas: number;
  total: number;
  fianza: number;
  seguro: number;
  intereses: number;
  fianzaPorcentaje: number;
  seguroCuotaPorcentaje: number;
  liquidacionAnticipada?: true;
};

export type MassCreditCurrentTerms = {
  montoCredito: number;
  saldoBaseFinanciado: number;
  valorCuota?: number | null;
  plazoMeses?: number | null;
  valorFianza: number;
  valorInteres: number;
  planCapitalVigente?: unknown;
};

type MassCreditComponentsInput = {
  capital: number;
  cuota: number;
  numeroCuotas: number;
  fianzaPorcentaje: number;
  seguroCuotaPorcentaje: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function financialRecord(snapshot: unknown) {
  const root = record(snapshot);
  if (!root) return null;
  return record(root.financiero) ?? root;
}

function moneyCents(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      value > 1e12 || Math.round(value * 100) / 100 !== value) {
    throw new Error(`${label} debe ser un importe no negativo con máximo dos decimales.`);
  }
  return BigInt(Math.round(value * 100));
}

function quotaCount(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 600) {
    throw new Error("El número de cuotas debe ser un entero entre 1 y 600.");
  }
  return value;
}

function percentageUnits(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100 ||
      Math.round(value * 1e12) / 1e12 !== value) {
    throw new Error(`${label} debe estar entre 0 y 100, con máximo doce decimales.`);
  }
  // Fixed decimal text prevents binary multiplication from changing cent rounding.
  const [whole, fraction] = value.toFixed(12).split(".");
  return BigInt(whole) * BigInt("1000000000000") + BigInt(fraction);
}

function toMoney(cents: bigint) {
  if (cents < 0 || cents > BigInt("100000000000000")) throw new Error("Importe fuera del rango permitido.");
  return Number(cents) / 100;
}

function percentageCharge(capital: bigint, units: bigint, periods = 1) {
  const denominator = BigInt("100000000000000");
  const numerator = capital * units * BigInt(periods);
  return (numerator + denominator / BigInt("2")) / denominator;
}

/** Reclassifies an agreed obligation; it never calculates a new installment or rate. */
export function calculateMassCreditComponents(input: MassCreditComponentsInput): MassCreditComponents {
  const capital = moneyCents(input.capital, "Capital");
  const cuota = moneyCents(input.cuota, "Cuota");
  const numeroCuotas = quotaCount(input.numeroCuotas);
  if (capital <= 0 || cuota <= 0) throw new Error("El capital y la cuota deben ser mayores a cero.");
  const fianzaRate = percentageUnits(input.fianzaPorcentaje, "Fianza total");
  const seguroRate = percentageUnits(input.seguroCuotaPorcentaje, "Seguro por cuota");
  const total = cuota * BigInt(numeroCuotas);
  const fianza = percentageCharge(capital, fianzaRate);
  const seguro = percentageCharge(capital, seguroRate, numeroCuotas);
  const intereses = total - capital - fianza - seguro;
  if (intereses < 0) {
    throw new Error("La cuota y el plazo no cubren el capital, la fianza y el seguro. Los intereses no pueden ser negativos.");
  }
  return {
    version: MASS_CREDIT_COMPONENTS_VERSION,
    capital: toMoney(capital), cuota: toMoney(cuota), numeroCuotas,
    total: toMoney(total), fianza: toMoney(fianza), seguro: toMoney(seguro), intereses: toMoney(intereses),
    fianzaPorcentaje: input.fianzaPorcentaje, seguroCuotaPorcentaje: input.seguroCuotaPorcentaje,
  };
}

/** Only a valid server-owned marker matching current financial terms is a source. */
export function readMassCreditComponents(
  snapshot: unknown,
  current?: MassCreditCurrentTerms,
): MassCreditComponents | null {
  const marker = record(financialRecord(snapshot)?.componentesMasivos);
  if (!marker || marker.version !== MASS_CREDIT_COMPONENTS_VERSION || current?.planCapitalVigente != null) return null;
  try {
    const capital = moneyCents(marker.capital, "Capital");
    const cuota = moneyCents(marker.cuota, "Cuota");
    const numeroCuotas = quotaCount(marker.numeroCuotas);
    const total = moneyCents(marker.total, "Obligación");
    const fianza = moneyCents(marker.fianza, "Fianza");
    const seguro = moneyCents(marker.seguro, "Seguro");
    const intereses = moneyCents(marker.intereses, "Intereses");
    const fianzaRate = percentageUnits(marker.fianzaPorcentaje, "Fianza total");
    const seguroRate = percentageUnits(marker.seguroCuotaPorcentaje, "Seguro por cuota");
    if (capital <= 0 || cuota <= 0 || capital + fianza + seguro + intereses !== total) return null;
    if (marker.liquidacionAnticipada !== undefined && marker.liquidacionAnticipada !== true) return null;
    if (marker.liquidacionAnticipada !== true && (
      total !== cuota * BigInt(numeroCuotas) || fianza !== percentageCharge(capital, fianzaRate) ||
      seguro !== percentageCharge(capital, seguroRate, numeroCuotas)
    )) return null;
    if (current && (
      total !== moneyCents(current.montoCredito, "Obligación actual") ||
      capital !== moneyCents(current.saldoBaseFinanciado, "Capital actual") ||
      fianza !== moneyCents(current.valorFianza, "Fianza actual") ||
      intereses !== moneyCents(current.valorInteres, "Intereses actuales") ||
      (current.valorCuota != null && cuota !== moneyCents(current.valorCuota, "Cuota actual")) ||
      (current.plazoMeses != null && numeroCuotas !== quotaCount(current.plazoMeses))
    )) return null;
    return {
      version: MASS_CREDIT_COMPONENTS_VERSION, capital: toMoney(capital), cuota: toMoney(cuota), numeroCuotas,
      total: toMoney(total), fianza: toMoney(fianza), seguro: toMoney(seguro), intereses: toMoney(intereses),
      fianzaPorcentaje: marker.fianzaPorcentaje as number,
      seguroCuotaPorcentaje: marker.seguroCuotaPorcentaje as number,
      ...(marker.liquidacionAnticipada === true ? { liquidacionAnticipada: true as const } : {}),
    };
  } catch {
    return null;
  }
}

export function getMassCreditInsurance(credit: MassCreditCurrentTerms & { contratoSnapshot?: unknown }) {
  return readMassCreditComponents(credit.contratoSnapshot, credit)?.seguro ?? 0;
}

/** Closing changes only the current classification, preserving imported and signed evidence. */
export function updateMassCreditComponentsForPayoff(
  snapshot: unknown,
  amounts: { montoCredito: number; valorFianza: number; valorInteres: number; valorSeguro: number },
): unknown {
  const components = readMassCreditComponents(snapshot);
  if (!components) return snapshot;
  const total = moneyCents(amounts.montoCredito, "Obligación liquidada");
  const fianza = moneyCents(amounts.valorFianza, "Fianza reconocida");
  const intereses = moneyCents(amounts.valorInteres, "Intereses reconocidos");
  const seguro = moneyCents(amounts.valorSeguro, "Seguro reconocido");
  if (moneyCents(components.capital, "Capital") + fianza + intereses + seguro !== total) {
    throw new Error("Los componentes reconocidos no concilian con la obligación liquidada.");
  }
  if (total > moneyCents(components.total, "Obligación previa") ||
      fianza > moneyCents(components.fianza, "Fianza previa") ||
      intereses > moneyCents(components.intereses, "Intereses previos") ||
      seguro > moneyCents(components.seguro, "Seguro previo")) {
    throw new Error("La liquidación anticipada no puede aumentar los componentes financieros.");
  }
  const root = record(snapshot)!;
  const financial = financialRecord(snapshot)!;
  const nextFinancial = {
    ...financial,
    montoCredito: toMoney(total), valorFianza: toMoney(fianza), valorInteres: toMoney(intereses), valorSeguro: toMoney(seguro),
    cargosIncorporados: toMoney(total - moneyCents(components.capital, "Capital")),
    componentesMasivos: {
      ...record(financial.componentesMasivos),
      total: toMoney(total), fianza: toMoney(fianza), intereses: toMoney(intereses), seguro: toMoney(seguro),
      liquidacionAnticipada: true,
    },
  };
  return record(root.financiero) ? { ...root, financiero: nextFinancial } : nextFinancial;
}
