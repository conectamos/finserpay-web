import {
  parseDataCreditoPolicyFinancialSettings,
  type DataCreditoPolicyFinancialSettings,
} from "@/lib/datacredito/policy";

type CreditFinancialBase = {
  calculoVersion?: "FRANCES_V1" | "ARES_FRANCES_V1" | null;
  tasaInteresEa: number;
  fianzaTotalPorcentaje?: number | null;
  fianzaCuotaPorcentaje: number;
  seguroCuotaPorcentaje: number;
  frecuenciaPago: string;
  tasaPeriodoDecimales?: number | null;
  redondeoComercialModo?: "REDONDEO" | "PISO" | null;
  redondeoComercialMultiplo?: number | null;
};

export type ResolvedCreditPolicyFinancialSettings = CreditFinancialBase & {
  calculoVersion: "FRANCES_V1" | "ARES_FRANCES_V1";
  fianzaTotalPorcentaje: number | null;
  fianzaModalidad: "TOTAL_CREDITO" | "POR_CUOTA";
  tasaPeriodoDecimales: number;
  redondeoComercial: {
    modo: "REDONDEO" | "PISO";
    multiplo: number;
  };
  fianzaSource:
    | "POLITICA"
    | "OFERTA_LEGACY_TOTAL"
    | "GLOBAL";
};

function presentNumber(value: unknown) {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed)
    ? parsed
    : null;
}

/**
 * Resolves the financial terms used by preview, signature and final creation.
 *
 * Published policy revisions provide the terms for evaluated applications.
 * Global settings remain only as a compatibility fallback when an assessment
 * does not contain financial settings. The legacy band surety is used only by
 * historical offers.
 */
export function resolveCreditPolicyFinancialSettings(input: {
  globalSettings: CreditFinancialBase;
  policyFinancialSettings?: DataCreditoPolicyFinancialSettings | unknown | null;
  legacyOfferSuretyPercentage?: number | null;
  numeroCuotas: number;
}): ResolvedCreditPolicyFinancialSettings {
  if (!Number.isSafeInteger(input.numeroCuotas) || input.numeroCuotas <= 0) {
    throw new Error("numeroCuotas debe ser un entero positivo");
  }

  const policy = parseDataCreditoPolicyFinancialSettings(
    input.policyFinancialSettings,
    { optional: true }
  );
  const legacySuretyTotal = presentNumber(
    input.legacyOfferSuretyPercentage
  );
  const globalSuretyTotal = presentNumber(
    input.globalSettings.fianzaTotalPorcentaje
  );
  const globalCalculationVersion =
    input.globalSettings.calculoVersion === "ARES_FRANCES_V1"
      ? "ARES_FRANCES_V1"
      : "FRANCES_V1";
  const calculationVersion =
    policy?.calculoVersion ||
    globalCalculationVersion;

  let fianzaCuotaPorcentaje = input.globalSettings.fianzaCuotaPorcentaje;
  let fianzaTotalPorcentaje: number | null = null;
  let fianzaModalidad: ResolvedCreditPolicyFinancialSettings["fianzaModalidad"] =
    "POR_CUOTA";
  let fianzaSource: ResolvedCreditPolicyFinancialSettings["fianzaSource"] =
    "GLOBAL";

  if (policy?.calculoVersion === "ARES_FRANCES_V1") {
    fianzaTotalPorcentaje = policy.fianzaTotalPorcentaje;
    fianzaCuotaPorcentaje =
      policy.fianzaTotalPorcentaje / input.numeroCuotas;
    fianzaModalidad = "TOTAL_CREDITO";
    fianzaSource = "POLITICA";
  } else if (policy?.calculoVersion === "FRANCES_V1") {
    fianzaCuotaPorcentaje = policy.fianzaCuotaPorcentaje;
    fianzaSource = "POLITICA";
  } else if (legacySuretyTotal !== null) {
    fianzaTotalPorcentaje = legacySuretyTotal;
    fianzaCuotaPorcentaje = legacySuretyTotal / input.numeroCuotas;
    fianzaModalidad = "TOTAL_CREDITO";
    fianzaSource = "OFERTA_LEGACY_TOTAL";
  } else if (
    globalCalculationVersion === "ARES_FRANCES_V1" &&
    globalSuretyTotal !== null
  ) {
    fianzaTotalPorcentaje = globalSuretyTotal;
    fianzaCuotaPorcentaje = globalSuretyTotal / input.numeroCuotas;
    fianzaModalidad = "TOTAL_CREDITO";
  }

  const aresCalculation = calculationVersion === "ARES_FRANCES_V1";

  return {
    calculoVersion: calculationVersion,
    tasaInteresEa:
      policy?.tasaInteresEa ?? input.globalSettings.tasaInteresEa,
    fianzaCuotaPorcentaje,
    fianzaTotalPorcentaje,
    fianzaModalidad,
    seguroCuotaPorcentaje:
      policy?.seguroCuotaPorcentaje ??
      input.globalSettings.seguroCuotaPorcentaje,
    frecuenciaPago:
      policy?.frecuenciaPago ||
      input.globalSettings.frecuenciaPago,
    tasaPeriodoDecimales: aresCalculation ? 6 : 12,
    redondeoComercial: {
      modo: aresCalculation ? "PISO" : "REDONDEO",
      multiplo: aresCalculation ? 50 : 100,
    },
    fianzaSource,
  };
}
