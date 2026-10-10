export type CreditImeiConfirmation = {
  imei: string;
  confirmedAt: string;
  confirmedByUserId: number;
  confirmedBySellerId: number | null;
};

export class ImeiConfirmationError extends Error {
  constructor(
    readonly code: "IMEI_CONFIRMATION_INVALID" | "IMEI_CONFIRMATION_MISMATCH" | "IMEI_CONFIRMATION_REQUIRED",
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "ImeiConfirmationError";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** IMEIs are identifiers: never coerce numbers, trim, truncate or remove digits. */
export function isExactCreditImei(value: unknown): value is string {
  return typeof value === "string" && /^\d{15}$/.test(value);
}

export function validateCreditImeiConfirmation(entered: unknown, current: unknown): string {
  if (!isExactCreditImei(entered)) {
    throw new ImeiConfirmationError("IMEI_CONFIRMATION_INVALID", "El IMEI debe contener exactamente 15 números.", 400);
  }
  if (!isExactCreditImei(current) || entered !== current) {
    throw new ImeiConfirmationError("IMEI_CONFIRMATION_MISMATCH", "Los IMEI no coinciden. Revisa el número directamente en el equipo e inténtalo nuevamente.");
  }
  return entered;
}

export function readCreditImeiConfirmation(payload: unknown, currentImei: unknown): CreditImeiConfirmation | null {
  const confirmation = object(object(payload).imeiConfirmation);
  if (!isExactCreditImei(currentImei) || confirmation.imei !== currentImei ||
      !Number.isSafeInteger(confirmation.confirmedByUserId) || Number(confirmation.confirmedByUserId) <= 0 ||
      typeof confirmation.confirmedAt !== "string" || !Number.isFinite(Date.parse(confirmation.confirmedAt))) return null;
  return confirmation as CreditImeiConfirmation;
}

/** Existing sent versions remain operable; superseded versions never exempt a new IMEI. */
export function hasCurrentContractImeiConfirmation(input: {
  imei: unknown;
  payload: unknown;
  currentProcess?: { processUuid?: unknown; draftPayload?: unknown; supersededAt?: unknown } | null;
}): boolean {
  if (readCreditImeiConfirmation(input.payload, input.imei)) return true;
  const process = input.currentProcess;
  if (!isExactCreditImei(input.imei) || !process?.processUuid || process.supersededAt) return false;
  const snapshot = object(process.draftPayload);
  // This compatibility path only applies to versions sent before confirmation
  // was recorded. A new version's acknowledgement must match its current IMEI.
  if (snapshot.imeiConfirmation || object(input.payload).imeiConfirmation) return false;
  return (snapshot.imei || snapshot.deviceUid) === input.imei &&
    (!snapshot.deviceUid || snapshot.deviceUid === input.imei);
}

/** Only the dedicated endpoint may add or change the confirmation and its audit. */
export function preserveCreditImeiConfirmation(stored: unknown, incoming: Record<string, unknown>, currentImei: unknown): Record<string, unknown> {
  const source = object(stored);
  const result = { ...incoming };
  delete result.imeiConfirmation;
  delete result.imeiConfirmationHistory;
  delete result.imeiConfirmationRequired;
  const confirmed = readCreditImeiConfirmation(source, currentImei);
  if (confirmed) result.imeiConfirmation = confirmed;
  if (Array.isArray(source.imeiConfirmationHistory)) result.imeiConfirmationHistory = source.imeiConfirmationHistory;
  return result;
}
