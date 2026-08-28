export type OutstandingBalanceInput = {
  montoCredito: number;
  saldoBaseFinanciado: number;
  saldoPendiente: number;
  valorEquipoTotal: number;
  cuotaInicial: number;
  valorFianza: number;
  valorInteres: number;
};

export type OutstandingBalanceBreakdown = {
  saldoCapital: number;
  saldoFianza: number;
  saldoIntereses: number;
};

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function splitOutstandingBalance(
  options: OutstandingBalanceInput
): OutstandingBalanceBreakdown {
  const saldoPendiente = roundMoney(options.saldoPendiente);
  const capitalOriginal =
    Number(options.saldoBaseFinanciado || 0) ||
    Math.max(0, Number(options.valorEquipoTotal || 0) - Number(options.cuotaInicial || 0));
  const fianzaOriginal = Math.max(0, Number(options.valorFianza || 0));
  const interesOriginal = Math.max(0, Number(options.valorInteres || 0));
  const totalOriginal =
    capitalOriginal + fianzaOriginal + interesOriginal ||
    Math.max(0, Number(options.montoCredito || 0));

  if (saldoPendiente <= 0) {
    return {
      saldoCapital: 0,
      saldoFianza: 0,
      saldoIntereses: 0,
    };
  }

  if (totalOriginal <= 0) {
    return {
      saldoCapital: saldoPendiente,
      saldoFianza: 0,
      saldoIntereses: 0,
    };
  }

  const saldoCapital = roundMoney((saldoPendiente * capitalOriginal) / totalOriginal);
  const saldoFianza = roundMoney((saldoPendiente * fianzaOriginal) / totalOriginal);
  const saldoIntereses = roundMoney(
    Math.max(0, saldoPendiente - saldoCapital - saldoFianza)
  );

  return {
    saldoCapital,
    saldoFianza,
    saldoIntereses,
  };
}
