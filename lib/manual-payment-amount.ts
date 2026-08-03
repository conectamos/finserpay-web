function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function resolveSelectedPaymentAmount(
  receivedValue: number,
  exactSelectedBalance: number
) {
  const received = roundMoney(Math.max(0, Number(receivedValue || 0)));
  const selectedBalance = roundMoney(
    Math.max(0, Number(exactSelectedBalance || 0))
  );

  // The UI presents COP without decimal places. When the displayed amount is
  // the same, apply the exact contractual balance so centavos do not leave a
  // phantom remainder in later installments.
  return Math.round(received) === Math.round(selectedBalance)
    ? selectedBalance
    : received;
}
