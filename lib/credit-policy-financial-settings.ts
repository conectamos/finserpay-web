import {
  parseDataCreditoPolicyFinancialSettings,
  type DataCreditoPolicyFinancialSettings,
} from "@/lib/datacredito/policy";

type CreditFinancialBase = {
  tasaInteresEa: number;
  fianzaCuotaPorcentaje: number;
  seguroCuotaPorcentaje: number;
  frecuenciaPago: string;
};

type CreditFinancialDocumentOverride = {
  tasaInteresEa?: number | null;
  fianzaPorcentaje?: number | null;
  fianzaCuotaPorcentaje?: number | null;
  seguroCuotaPorcentaje?: number | null;
  frecuenciaPago?: string | null;
} | null;

export type ResolvedCreditPolicyFinancialSettings = CreditFinancialBase & {
  calculoVersion: "FRANCES_V1";
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
  const exceptionSuretyPerInstallment = presentNumber(
    exception?.fianzaCuotaPorcentaje
  );
  const exceptionSuretyTotal = presentNumber(exception?.fianzaPorcentaje);
  const exceptionInsurance = presentNumber(exception?.seguroCuotaPorcentaje);
  const legacySuretyTotal = presentNumber(
    input.legacyOfferSuretyPercentage
  );

  let fianzaCuotaPorcentaje = input.globalSettings.fianzaCuotaPorcentaje;
  let fianzaSource: ResolvedCreditPolicyFinancialSettings["fianzaSource"] =
    "GLOBAL";

  if (exceptionSuretyPerInstallment !== null) {
    fianzaCuotaPorcentaje = exceptionSuretyPerInstallment;
    fianzaSource = "CLIENTE_POR_CUOTA";
  } else if (exceptionSuretyTotal !== null) {
    fianzaCuotaPorcentaje =
      exceptionSuretyTotal / input.numeroCuotas;
    fianzaSource = "CLIENTE_TOTAL";
  } else if (policy) {
    fianzaCuotaPorcentaje = policy.fianzaCuotaPorcentaje;
    fianzaSource = "POLITICA";
  } else if (legacySuretyTotal !== null) {
    fianzaCuotaPorcentaje = legacySuretyTotal / input.numeroCuotas;
    fianzaSource = "OFERTA_LEGACY_TOTAL";
  }

  return {
    calculoVersion: "FRANCES_V1",
    tasaInteresEa:
      exceptionInterest ?? policy?.tasaInteresEa ??
      input.globalSettings.tasaInteresEa,
    fianzaCuotaPorcentaje,
    seguroCuotaPorcentaje:
      exceptionInsurance ?? policy?.seguroCuotaPorcentaje ??
      input.globalSettings.seguroCuotaPorcentaje,
    frecuenciaPago:
      input.forcePaymentFrequency ||
      exception?.frecuenciaPago ||
      policy?.frecuenciaPago ||
      input.globalSettings.frecuenciaPago,
    fianzaSource,
  };
}
