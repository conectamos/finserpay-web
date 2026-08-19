import {
  DATACREDITO_MAX_SCORE,
  DATACREDITO_MIN_SCORE,
  DATACREDITO_NO_INFORMATION_SCORE,
} from "./policy";

export type DataCreditoQueryOutcome =
  | "SCORE"
  | "SIN_INFORMACION"
  | "INVALID";

export type DataCreditoQueryResult = {
  durationMs: number;
  hasInformation: boolean;
  outcome: DataCreditoQueryOutcome;
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

function informationFlag(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const normalized = cleanText(value).toLowerCase();
  if (["1", "s", "si", "sí", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "n", "no", "false"].includes(normalized)) {
    return false;
  }

  return null;
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
    return Number.isSafeInteger(value) && value >= DATACREDITO_MIN_SCORE &&
        value <= DATACREDITO_MAX_SCORE
      ? value
      : null;
  }

  const raw = cleanText(value);
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= DATACREDITO_MIN_SCORE &&
      parsed <= DATACREDITO_MAX_SCORE
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
  const providerInformation = informationFlag(risk?.conInformacion);
  const acceptedTransaction =
    transactionCode !== null && /^(0[1-8])$/.test(transactionCode);
  const providerAccepted = providerStatus === "ACCEPTED";
  const hasScore =
    providerAccepted &&
    acceptedTransaction &&
    providerInformation === true &&
    score !== null;
  const hasExplicitNoInformation =
    providerAccepted &&
    (transactionCode === "17" ||
      (acceptedTransaction && providerInformation === false));
  const outcome: DataCreditoQueryOutcome = hasScore
    ? "SCORE"
    : hasExplicitNoInformation
      ? "SIN_INFORMACION"
      : "INVALID";

  return {
    durationMs: Math.max(0, Math.round(durationMs)),
    hasInformation: providerInformation === true,
    outcome,
    providerStatus,
    score:
      outcome === "SCORE"
        ? score
        : outcome === "SIN_INFORMACION"
          ? DATACREDITO_NO_INFORMATION_SCORE
          : null,
    transactionCode,
  };
}
