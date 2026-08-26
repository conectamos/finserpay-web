export type FirmaSeguroProcessSummary = {
  completedAt?: string | null;
  hasSignedDocument?: boolean;
  lastError?: string | null;
  processUuid?: string | null;
  status?: string | null;
};

export type FirmaSeguroProcessUiState =
  | "error"
  | "pending"
  | "signed"
  | "waiting";

type FirmaSeguroFailurePayload = {
  detail?: unknown;
  error?: unknown;
  message?: unknown;
};

const SENSITIVE_DETAIL_KEY =
  /authorization|base64|document|file|image|password|pdf|photo|signature|token/i;
const DIAGNOSTIC_MESSAGE_KEY =
  /description|descripcion|detail|error|exception|message|originaldetail|reason/i;
const DIAGNOSTIC_CONTAINER_KEY = /errors|validation|validacion/i;

export function sanitizeFirmaSeguroVisibleText(value: unknown, maxLength = 360) {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }

  const cleaned = String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [dato protegido]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[dato protegido]")
    .replace(
      /((?:access[_ -]?token|api[_ -]?key|authorization|password|token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[dato protegido]"
    )
    .replace(/[A-Za-z0-9+/=_-]{120,}/g, "[dato protegido]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "";
  }

  return cleaned.length > maxLength
    ? `${cleaned.slice(0, Math.max(1, maxLength - 3)).trim()}...`
    : cleaned;
}

function collectFirmaSeguroDetailMessages(
  value: unknown,
  output: string[],
  diagnosticContext = false,
  depth = 0
) {
  if (depth > 5 || output.length >= 8 || value === null || value === undefined) {
    return;
  }

  if (typeof value === "string" || typeof value === "number") {
    if (diagnosticContext || depth === 0) {
      const message = sanitizeFirmaSeguroVisibleText(value, 280);
      if (message) {
        output.push(message);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      collectFirmaSeguroDetailMessages(item, output, diagnosticContext, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) {
      continue;
    }

    const keyContainsMessage = DIAGNOSTIC_MESSAGE_KEY.test(key);
    if (typeof item === "string" || typeof item === "number") {
      collectFirmaSeguroDetailMessages(
        item,
        output,
        diagnosticContext || keyContainsMessage,
        depth + 1
      );
      continue;
    }

    collectFirmaSeguroDetailMessages(
      item,
      output,
      diagnosticContext || DIAGNOSTIC_CONTAINER_KEY.test(key),
      depth + 1
    );
  }
}

export function formatFirmaSeguroApiFailure(
  payload: FirmaSeguroFailurePayload | null | undefined,
  fallback: string
) {
  const fallbackMessage =
    sanitizeFirmaSeguroVisibleText(fallback) ||
    "No se pudo procesar la solicitud de FirmaSeguro";
  const primaryMessage =
    sanitizeFirmaSeguroVisibleText(payload?.error) ||
    sanitizeFirmaSeguroVisibleText(payload?.message) ||
    fallbackMessage;
  const detailMessages: string[] = [];

  collectFirmaSeguroDetailMessages(payload?.detail, detailMessages);

  const normalizedPrimary = primaryMessage.toLocaleLowerCase("es-CO");
  const uniqueDetails = Array.from(new Set(detailMessages)).filter((detail) => {
    const normalizedDetail = detail.toLocaleLowerCase("es-CO");
    return (
      normalizedDetail !== normalizedPrimary &&
      !normalizedPrimary.includes(normalizedDetail)
    );
  });

  return uniqueDetails.length > 0
    ? `${primaryMessage} Detalle: ${uniqueDetails.slice(0, 3).join("; ")}.`
    : primaryMessage;
}

export function hasFirmaSeguroSignedEvidence(
  process?: FirmaSeguroProcessSummary | null
) {
  return Boolean(process?.completedAt || process?.hasSignedDocument);
}

export function isFirmaSeguroSuccessfulProcess(
  process?: FirmaSeguroProcessSummary | null
) {
  if (!process) {
    return false;
  }

  if (hasFirmaSeguroSignedEvidence(process)) {
    return true;
  }

  return isFirmaSeguroSuccessfulStatus(process.status);
}

export function isFirmaSeguroFailedProcess(
  process?: FirmaSeguroProcessSummary | null
) {
  if (!process || hasFirmaSeguroSignedEvidence(process)) {
    return false;
  }

  if (sanitizeFirmaSeguroVisibleText(process.lastError)) {
    return true;
  }

  return isFirmaSeguroFailedStatus(process.status);
}

export function resolveFirmaSeguroProcessUiState(
  process?: FirmaSeguroProcessSummary | null
): FirmaSeguroProcessUiState {
  if (hasFirmaSeguroSignedEvidence(process)) {
    return "signed";
  }

  if (isFirmaSeguroFailedProcess(process)) {
    return "error";
  }

  if (process?.processUuid) {
    return "waiting";
  }

  return "pending";
}

export function formatFirmaSeguroProcessIssue(
  process?: FirmaSeguroProcessSummary | null
) {
  const lastError = sanitizeFirmaSeguroVisibleText(process?.lastError, 420);
  const status = sanitizeFirmaSeguroVisibleText(process?.status, 80);

  if (lastError) {
    return status ? `${lastError} Estado: ${status}.` : lastError;
  }

  return status
    ? `FirmaSeguro cerró el proceso con estado ${status}. Reintenta el envío o solicita soporte.`
    : "FirmaSeguro reportó un error en el proceso. Reintenta el envío o solicita soporte.";
}
import {
  isFirmaSeguroFailedStatus,
  isFirmaSeguroSuccessfulStatus,
} from "@/lib/firmaseguro-status";
