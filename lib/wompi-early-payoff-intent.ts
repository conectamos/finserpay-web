export const WOMPI_EARLY_PAYOFF_TYPE = "LIQUIDACION_ANTICIPADA";

export type WompiEarlyPayoffAmountValidation = {
  reason: "AMOUNT_MISMATCH" | null;
  valid: boolean;
};

function moneyToCents(value: number) {
  return Math.round(Number(value || 0) * 100);
}

export function isWompiEarlyPayoffReference(reference: unknown) {
  const normalized = String(reference || "").trim().toUpperCase();

  return /^FP-\d+-LIQUIDACION(?:-|$)/.test(normalized);
}

export function isWompiEarlyPayoffIntent(
  cuotaNumeros: unknown,
  reference: unknown
) {
  const metadataMatch =
    typeof cuotaNumeros === "object" &&
    cuotaNumeros !== null &&
    (cuotaNumeros as { tipo?: unknown }).tipo === WOMPI_EARLY_PAYOFF_TYPE;

  return metadataMatch || isWompiEarlyPayoffReference(reference);
}

export function validateWompiEarlyPayoffAmounts(options: {
  intentAmountInCents: number;
  paymentAmount: number;
  payoffAmount: number;
}): WompiEarlyPayoffAmountValidation {
  const intentAmountInCents = Math.round(Number(options.intentAmountInCents || 0));
  const paymentAmountInCents = moneyToCents(options.paymentAmount);
  const payoffAmountInCents = moneyToCents(options.payoffAmount);
  const valid =
    intentAmountInCents > 0 &&
    intentAmountInCents === paymentAmountInCents &&
    intentAmountInCents === payoffAmountInCents;

  return {
    reason: valid ? null : "AMOUNT_MISMATCH",
    valid,
  };
}
