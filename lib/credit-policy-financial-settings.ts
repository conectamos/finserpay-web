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

type CreditFinancialDocumentOverride = {
  calculoVersion?: "FRANCES_V1" | "ARES_FRANCES_V1" | null;
  tasaInteresEa?: number | null;
  fianzaTotalPorcentaje?: number | null;
  fianzaPorcentaje?: number | null;
  fianzaCuotaPorcentaje?: number | null;
  seguroCuotaPorcentaje?: number | null;
  frecuenciaPago?: string | null;
  tasaPeriodoDecimales?: number | null;
  redondeoComercialModo?: "REDONDEO" | "PISO" | null;
  redondeoComercialMultiplo?: number | null;
} | null;

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
    | "CLIENTE_POR_CUOTA"
    | "CLIENTE_TOTAL"
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
 * Explicit document exceptions have the highest administrative precedence.
 * New policy revisions then provide the French-calculation parameters. The
 * legacy band surety remains a fallback only for historical revisions that did
 * not snapshot a per-installment surety.
 */
export function resolveCreditPolicyFinancialSettings(input: {
  globalSettings: CreditFinancialBase;
  documentException?: CreditFinancialDocumentOverride;
  policyFinancialSettings?: DataCreditoPolicyFinancialSettings | unknown | null;
  legacyOfferSuretyPercentage?: number | null;
  numeroCuotas: number;
  forcePaymentFrequency?: string | null;
}): ResolvedCreditPolicyFinancialSettings {
  if (!Number.isSafeInteger(input.numeroCuotas) || input.numeroCuotas <= 0) {
    throw new Error("numeroCuotas debe ser un entero positivo");
  }

  const policy = parseDataCreditoPolicyFinancialSettings(
    input.policyFinancialSettings,
    { optional: true }
  );
  const exception = input.documentException || null;
  const exceptionInterest = presentNumber(exception?.tasaInteresEa);
  const exceptionSuretyTotalAres = presentNumber(
    exception?.fianzaTotalPorcentaje
  );
  const exceptionSuretyPerInstallment = presentNumber(
    exception?.fianzaCuotaPorcentaje
  );
  const exceptionSuretyTotal = presentNumber(exception?.fianzaPorcentaje);
  const exceptionInsurance = presentNumber(exception?.seguroCuotaPorcentaje);
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
    exception?.calculoVersion ||
    policy?.calculoVersion ||
    globalCalculationVersion;

  let fianzaCuotaPorcentaje = input.globalSettings.fianzaCuotaPorcentaje;
  let fianzaTotalPorcentaje: number | null = null;
  let fianzaModalidad: ResolvedCreditPolicyFinancialSettings["fianzaModalidad"] =
    "POR_CUOTA";
  let fianzaSource: ResolvedCreditPolicyFinancialSettings["fianzaSource"] =
    "GLOBAL";

  if (exceptionSuretyTotalAres !== null) {
    fianzaTotalPorcentaje = exceptionSuretyTotalAres;
    fianzaCuotaPorcentaje =
      exceptionSuretyTotalAres / input.numeroCuotas;
    fianzaModalidad = "TOTAL_CREDITO";
    fianzaSource = "CLIENTE_TOTAL";
  } else if (exceptionSuretyPerInstallment !== null) {
    fianzaCuotaPorcentaje = exceptionSuretyPerInstallment;
    fianzaSource = "CLIENTE_POR_CUOTA";
  } else if (exceptionSuretyTotal !== null) {
    fianzaTotalPorcentaje = exceptionSuretyTotal;
    fianzaCuotaPorcentaje =
      exceptionSuretyTotal / input.numeroCuotas;
    fianzaModalidad = "TOTAL_CREDITO";
    fianzaSource = "CLIENTE_TOTAL";
  } else if (policy?.calculoVersion === "ARES_FRANCES_V1") {
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
      exceptionInterest ?? policy?.tasaInteresEa ??
      input.globalSettings.tasaInteresEa,
    fianzaCuotaPorcentaje,
    fianzaTotalPorcentaje,
    fianzaModalidad,
    seguroCuotaPorcentaje:
      exceptionInsurance ?? policy?.seguroCuotaPorcentaje ??
      input.globalSettings.seguroCuotaPorcentaje,
    frecuenciaPago:
      input.forcePaymentFrequency ||
      exception?.frecuenciaPago ||
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
