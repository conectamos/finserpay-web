export type DataCreditoQueryResult = {
  durationMs: number;
  hasInformation: boolean;
  providerStatus: string | null;
  score: number | null;
  transactionCode: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isTrue(value: unknown) {
  if (value === true || value === 1) {
    return true;
  }

  const normalized = cleanText(value).toLowerCase();
  return ["1", "s", "si", "sí", "true", "yes"].includes(normalized);
}

function transactionCodeFrom(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  for (const item of value) {
    const record = asRecord(item);
    if (cleanText(record?.clave).toUpperCase() === "TX") {
      return cleanText(record?.valor) || null;
    }
  }

  return null;
}

function validScore(value: unknown) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 && value <= 950
      ? value
      : null;
  }

  const raw = cleanText(value);
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 950
    ? parsed
    : null;
}

export function parseDataCreditoQueryResponse(
  payload: unknown,
  durationMs: number
): DataCreditoQueryResult {
  const root = asRecord(payload);
  const content = asRecord(root?.content);
  const transaction = asRecord(content?.infoTransaccion);
  const answer = asRecord(content?.respuesta);
  const risk = asRecord(answer?.informacionRiesgo);
  const providerStatus = cleanText(root?.status).toUpperCase() || null;
  const transactionCode = transactionCodeFrom(transaction?.codigosRespuesta);
  const score = validScore(risk?.score);
  const hasInformation = isTrue(risk?.conInformacion);
  const acceptedTransaction =
    transactionCode !== null && /^(0[1-8])$/.test(transactionCode);
  const evaluable =
    providerStatus === "ACCEPTED" &&
    acceptedTransaction &&
    hasInformation &&
    score !== null;

  return {
    durationMs: Math.max(0, Math.round(durationMs)),
    hasInformation,
    providerStatus,
    score: evaluable ? score : null,
    transactionCode,
  };
}
