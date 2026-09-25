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
  const origin = record(snapshot.origen);
  const currentImei = text(credit.imei);

  // Historical CSV imports have no signed contract in FINSER PAY. Once their
  // temporary IMEI is corrected, documents use the verified operational IMEI
  // while the original CSV value remains frozen in the import snapshot.
  if (
    text(origin.tipo) === "IMPORTACION_MASIVA" &&
    origin.sinFirmaDigital === true &&
    origin.imeiTemporalPendienteCorreccion === false &&
    equipment.imeiTemporal === true &&
    !text(sealedTerms.imei) &&
    currentImei &&
    currentImei === text(credit.deviceUid)
  ) {
    return currentImei;
  }

  return (
    text(sealedTerms.imei) ||
    text(equipment.imei) ||
    text(credit.imei) ||
    text(credit.deviceUid)
  );
}
