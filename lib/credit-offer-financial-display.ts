import { parseDataCreditoPolicyFinancialSettings } from "@/lib/datacredito/policy";

type OfferFinancialInput = {
  financialSettings?: unknown;
  suretyPercentage?: unknown;
};

export type CreditOfferFinancialDisplay = {
  fianzaLabel: string;
  fianzaPorcentaje: number | null;
  source: "POLITICA" | "OFERTA_LEGACY_TOTAL" | null;
  tasaInteresEa: number | null;
  seguroCuotaPorcentaje: number | null;
  frecuenciaPago: string | null;
};

/** Reads the stored offer only; never replaces historical terms with today's defaults. */
export function getCreditOfferFinancialDisplay(
  offer: OfferFinancialInput | null | undefined
): CreditOfferFinancialDisplay {
  const unavailable: CreditOfferFinancialDisplay = {
    fianzaLabel: "Fianza",
    fianzaPorcentaje: null,
    source: null,
    tasaInteresEa: null,
    seguroCuotaPorcentaje: null,
    frecuenciaPago: null,
  };
  if (!offer) return unavailable;
  try {
    const settings = parseDataCreditoPolicyFinancialSettings(
      offer.financialSettings,
      { optional: true }
    );
    if (settings) {
      const perInstallment = settings.calculoVersion === "FRANCES_V1";
      return {
        fianzaLabel: perInstallment ? "Fianza por cuota" : "Fianza total",
        fianzaPorcentaje: settings.calculoVersion === "FRANCES_V1"
          ? settings.fianzaCuotaPorcentaje
          : settings.fianzaTotalPorcentaje,
        source: "POLITICA",
        tasaInteresEa: settings.tasaInteresEa,
        seguroCuotaPorcentaje: settings.seguroCuotaPorcentaje,
        frecuenciaPago: settings.frecuenciaPago,
      };
    }
  } catch {
    // Invalid policy data must not silently switch to a band's legacy value.
    return unavailable;
  }
  const legacy = offer.suretyPercentage;
  return typeof legacy === "number" &&
    Number.isFinite(legacy) && legacy >= 0 && legacy <= 100
    ? {
        ...unavailable,
        fianzaLabel: "Fianza total (oferta histórica)",
        fianzaPorcentaje: legacy,
        source: "OFERTA_LEGACY_TOTAL",
      }
    : unavailable;
}
