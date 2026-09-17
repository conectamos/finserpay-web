export type CreditDisplayIdentity = {
  folio?: string | null;
  numeroCreditoVisible?: string | null;
};

/** Presentation only: the original folio remains the contractual/integration identifier. */
export function creditDisplayNumber(credit: CreditDisplayIdentity) {
  return credit.numeroCreditoVisible?.trim() || credit.folio?.trim() || "Sin folio";
}

export function confirmedSadminNumber(registration: {
  numeroCredito?: string | null;
  numeroCreditoConfirmado?: boolean;
} | null | undefined) {
  return registration?.numeroCreditoConfirmado
    ? registration.numeroCredito?.trim() || null
    : null;
}
