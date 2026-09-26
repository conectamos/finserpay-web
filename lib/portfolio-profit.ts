export type PortfolioProfitInput = {
  outstandingBalance: number;
  accumulatedCollections: number;
  accumulatedInvestment: number;
  operatingExpenses: number;
  committedCapital: number;
  recognizedProfit: number;
};

/** Projection agreed for the portfolio panel; backing is already netted from investment. */
export function calculatePortfolioProfit(input: PortfolioProfitInput) {
  const cents = (value: number) => {
    if (!Number.isFinite(value)) throw new RangeError("El cálculo requiere importes válidos.");
    return Math.round(value * 100);
  };
  return (
    cents(input.outstandingBalance) + cents(input.accumulatedCollections)
    - cents(input.accumulatedInvestment) - cents(input.operatingExpenses)
    - cents(input.committedCapital) - cents(input.recognizedProfit)
  ) / 100;
}

export type PortfolioInvestmentInput = {
  authorizedCapital: number;
  backingPercentage: number;
  recordedNetInvestment: number | null;
};

/** Prefer the settled per-credit amount; reconstruct missing history explicitly as an estimate. */
export function resolvePortfolioInvestment(input: PortfolioInvestmentInput) {
  if (input.recordedNetInvestment !== null) {
    if (!Number.isFinite(input.recordedNetInvestment) || input.recordedNetInvestment < 0) {
      throw new RangeError("La inversión registrada debe ser un importe válido.");
    }
    return { amount: Math.round(input.recordedNetInvestment * 100) / 100, estimated: false };
  }
  if (!Number.isFinite(input.authorizedCapital) || !Number.isFinite(input.backingPercentage)) {
    throw new RangeError("La inversión estimada requiere capital y respaldo válidos.");
  }
  const capitalCents = Math.round(Math.max(0, input.authorizedCapital) * 100);
  const retainedCents = Math.round(capitalCents * Math.min(100, Math.max(0, input.backingPercentage)) / 100);
  return { amount: (capitalCents - retainedCents) / 100, estimated: true };
}
