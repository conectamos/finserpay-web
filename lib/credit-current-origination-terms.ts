import { ARES_COMMERCIAL_AMORTIZATION_VERSION } from "@/lib/credit-amortization";

export const CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE =
  "DATACREDITO_FINANCIAL_TERMS_OUTDATED";
export const CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_MESSAGE =
  "La oferta conserva condiciones financieras anteriores. Renueva la oferta reutilizando la consulta vigente, sin generar una nueva consulta ni cobro, antes de continuar.";

/** Applies only when originating a new contract, never to an existing signed seal. */
export function hasCurrentCreditOriginationTerms(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return false;
  }
  const value = settings as Record<string, unknown>;
  const rounding = value.redondeoComercial;
  if (!rounding || typeof rounding !== "object" || Array.isArray(rounding)) {
    return false;
  }
  const commercialRounding = rounding as Record<string, unknown>;
  const annualRate = Number(value.tasaInteresEa);
  const totalSurety = Number(value.fianzaTotalPorcentaje);
  const insuranceRate = Number(value.seguroCuotaPorcentaje);
  return (
    value.calculoVersion === ARES_COMMERCIAL_AMORTIZATION_VERSION &&
    Number.isFinite(annualRate) &&
    Math.abs(annualRate - 29.24) <= 1e-9 &&
    Number.isFinite(totalSurety) &&
    Math.abs(totalSurety - 75) <= 1e-9 &&
    (value.fianzaModalidad === undefined || value.fianzaModalidad === "TOTAL_CREDITO") &&
    Number.isFinite(insuranceRate) &&
    Math.abs(insuranceRate - 0.03) <= 1e-9 &&
    Number(value.tasaPeriodoDecimales) === 6 &&
    commercialRounding.modo === "PISO" &&
    Number(commercialRounding.multiplo) === 50
  );
}
