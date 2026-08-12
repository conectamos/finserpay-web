type CreditCreationRecoveryCandidate = {
  clienteDocumento?: string | null;
  createdAt?: string | null;
  deviceUid?: string | null;
  estado?: string | null;
  imei?: string | null;
};

type CreditCreationRecoveryInput = {
  documentNumber: string;
  imei: string;
  requestedAt: number;
  toleranceMs?: number;
};

const NETWORK_ERROR_PATTERN =
  /failed to fetch|fetch failed|networkerror|network request failed|network connection was lost|load failed|internet disconnected|connection (?:lost|closed|reset|aborted)|err_(?:connection|network|internet)/i;

function digits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

export function isCreditCreationNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return NETWORK_ERROR_PATTERN.test(message);
}

export function findCreditCreatedAfterConnectionLoss<
  T extends CreditCreationRecoveryCandidate,
>(items: T[], input: CreditCreationRecoveryInput) {
  const documentNumber = digits(input.documentNumber);
  const imei = digits(input.imei);
  const toleranceMs = Math.max(0, input.toleranceMs ?? 120_000);

  if (!documentNumber && !imei) return null;

  return (
    items.find((item) => {
      if (String(item.estado || "").toUpperCase() === "ANULADO") return false;

      const candidateDocument = digits(item.clienteDocumento);
      const candidateImei = digits(item.imei);
      const candidateDeviceUid = digits(item.deviceUid);
      const createdAt = Date.parse(String(item.createdAt || ""));

      if (!Number.isFinite(createdAt)) return false;
      if (createdAt < input.requestedAt - toleranceMs) return false;
      if (documentNumber && candidateDocument !== documentNumber) return false;
      if (imei && candidateImei !== imei && candidateDeviceUid !== imei) {
        return false;
      }

      return true;
    }) || null
  );
}
