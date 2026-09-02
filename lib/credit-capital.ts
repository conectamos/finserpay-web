export type CreditCapitalInput = {
  cuotaInicial?: number | null;
  montoCredito?: number | null;
  saldoBaseFinanciado?: number | null;
  valorEquipoTotal?: number | null;
  valorFianza?: number | null;
  valorInteres?: number | null;
};

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function resolveCapitalOriginal(input: CreditCapitalInput) {
  const saldoBase = Math.max(0, Number(input.saldoBaseFinanciado || 0));

  if (saldoBase > 0) {
    return roundMoney(saldoBase);
  }

  const capitalEquipo = Math.max(
    0,
    Number(input.valorEquipoTotal || 0) - Number(input.cuotaInicial || 0)
  );

  if (capitalEquipo > 0) {
    return roundMoney(capitalEquipo);
  }

  const montoCredito = Math.max(0, Number(input.montoCredito || 0));
  const cargos =
    Math.max(0, Number(input.valorInteres || 0)) +
    Math.max(0, Number(input.valorFianza || 0));

  return roundMoney(Math.max(0, montoCredito - cargos));
}
