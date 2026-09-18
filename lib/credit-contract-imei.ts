type CreditWithContractSnapshot = {
  contratoSnapshot?: unknown;
  imei?: unknown;
  deviceUid?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The top-level credit IMEI is the current operational device. Signed
 * documents and approval history keep using the device frozen at origination.
 */
export function resolveContractualCreditImei(
  credit: CreditWithContractSnapshot
) {
  const snapshot = record(credit.contratoSnapshot);
  const financial = record(snapshot.financiero);
  const seal = record(financial.selloFinanciero);
  const sealedTerms = record(seal.snapshot);
  const equipment = record(snapshot.equipo);

  return (
    text(sealedTerms.imei) ||
    text(equipment.imei) ||
    text(credit.imei) ||
    text(credit.deviceUid)
  );
}
