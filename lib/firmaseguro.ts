type JsonObject = Record<string, unknown>;

export type FirmaSeguroConfig = {
  baseUrl: string;
  accessToken: string;
  email: string;
  password: string;
  nit: string | null;
  processTypeId: number;
  signatureMethodId: number;
  authMethodId: number;
  balanceTypeId: number;
  identificationTypeId: number;
  typePersonId: number;
  deadlineDays: number;
  callbackUrl: string | null;
  callbackSecret: string | null;
};

type RequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
};

export class FirmaSeguroApiError extends Error {
  status: number;
  detail: unknown;

  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = "FirmaSeguroApiError";
    this.status = status;
    this.detail = detail;
  }
}

function readEnv(name: string) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readNumberEnv(name: string, fallback: number) {
  const numeric = Number(readEnv(name));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeBaseUrl(value: string) {
  const cleaned = value.trim().replace(/\/+$/, "");
  if (!cleaned) {
    return "https://demo.firmaseguro.co";
  }

  return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}

function normalizePublicUrl(value: string) {
  const cleaned = value.trim().replace(/\/+$/, "");
  if (!cleaned) {
    return "";
  }

  return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}

function getDefaultPublicBaseUrl() {
  return (
    normalizePublicUrl(readEnv("NEXT_PUBLIC_APP_URL")) ||
    normalizePublicUrl(readEnv("APP_URL")) ||
    normalizePublicUrl(readEnv("RAILWAY_PUBLIC_DOMAIN"))
  );
}

export function getFirmaSeguroConfig(): FirmaSeguroConfig {
  const explicitCallback = readEnv("FIRMASEGURO_CALLBACK_URL");
  const publicBaseUrl = getDefaultPublicBaseUrl();
  const callbackUrl =
    explicitCallback ||
    (publicBaseUrl ? `${publicBaseUrl}/api/firma-seguro/callback` : "");

  return {
    baseUrl: normalizeBaseUrl(readEnv("FIRMASEGURO_BASE_URL")),
    accessToken: readEnv("FIRMASEGURO_ACCESS_TOKEN"),
    email: readEnv("FIRMASEGURO_EMAIL"),
    password: readEnv("FIRMASEGURO_PASSWORD"),
    nit: readEnv("FIRMASEGURO_NIT") || null,
    processTypeId: readNumberEnv("FIRMASEGURO_PROCESS_TYPE_ID", 3),
    signatureMethodId: readNumberEnv("FIRMASEGURO_SIGNATURE_METHOD_ID", 2),
    authMethodId: readNumberEnv("FIRMASEGURO_AUTH_METHOD_ID", 4),
    balanceTypeId: readNumberEnv("FIRMASEGURO_BALANCE_TYPE_ID", 1),
    identificationTypeId: readNumberEnv("FIRMASEGURO_IDENTIFICATION_TYPE_ID", 1),
    typePersonId: readNumberEnv("FIRMASEGURO_TYPE_PERSON_ID", 1),
    deadlineDays: readNumberEnv("FIRMASEGURO_DEADLINE_DAYS", 5),
    callbackUrl: callbackUrl || null,
    callbackSecret: readEnv("FIRMASEGURO_CALLBACK_SECRET") || null,
  };
}

export function isFirmaSeguroConfigured() {
  const config = getFirmaSeguroConfig();
  return Boolean(
    config.baseUrl &&
      (config.accessToken || (config.email && config.password))
  );
}

export function buildFirmaSeguroCallbackUrl(creditoId?: number) {
  const config = getFirmaSeguroConfig();
  if (!config.callbackUrl) {
    return null;
  }

  const url = new URL(config.callbackUrl);
  if (config.callbackSecret) {
    url.searchParams.set("token", config.callbackSecret);
  }
  if (creditoId) {
    url.searchParams.set("creditoId", String(creditoId));
  }

  return url.toString();
}

async function parseResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectValidationMessages(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") {
    const cleaned = stripHtml(value);
    return cleaned ? [prefix ? `${prefix}: ${cleaned}` : cleaned] : [];
  }

  if (Array.isArray(value)) {
    return value
      .flatMap((item) => collectValidationMessages(item, prefix))
      .filter(Boolean);
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as JsonObject;
  const messages: string[] = [];

  for (const [key, item] of Object.entries(record)) {
    const field = prefix ? `${prefix}.${key}` : key;
    const diagnosticKey =
      /error|message|detail|exception|description|descripcion|validation|validacion/i.test(
        key
      );
    const sensitiveKey = /base64|token|password|authorization|document/i.test(key);

    if (key.toLowerCase() === "errors" && typeof item === "object" && item) {
      messages.push(...collectValidationMessages(item, ""));
      continue;
    }
    if (typeof item === "string" && diagnosticKey && !sensitiveKey) {
      const cleaned = stripHtml(item);
      if (cleaned && cleaned.length <= 500) {
        messages.push(prefix ? `${field}: ${cleaned}` : cleaned);
      }
      continue;
    }
    if (Array.isArray(item)) {
      messages.push(...collectValidationMessages(item, field));
      continue;
    }
    if (typeof item === "object" && item !== null && !sensitiveKey) {
      messages.push(...collectValidationMessages(item, field));
    }
  }

  return messages;
}

function getFirmaSeguroErrorMessage(status: number, payload: unknown) {
  if ([502, 503, 504].includes(status)) {
    return "FirmaSeguro no esta disponible temporalmente. Reintenta el envio en unos minutos.";
  }

  if (typeof payload === "string") {
    const cleaned = stripHtml(payload);
    return cleaned || "FirmaSeguro rechazo la solicitud";
  }

  if (typeof payload === "object" && payload) {
    const record = payload as JsonObject;
    const message = stripHtml(
      String(
        record.message ||
          record.error ||
          record.title ||
          "FirmaSeguro rechazo la solicitud"
      )
    );
    const details = collectValidationMessages(
      record.errors ||
        record.Errors ||
        record.details ||
        record.Details ||
        record.detail ||
        record.Detail ||
        record.data ||
        record.Data ||
        record
    );
    const uniqueDetails = Array.from(
      new Set(
        details
          .map((item) => stripHtml(item))
          .filter((item) => item && item !== message)
      )
    );

    if (uniqueDetails.length > 0) {
      return `${message}: ${uniqueDetails.slice(0, 6).join("; ")}`;
    }

    return message || "FirmaSeguro rechazo la solicitud";
  }

  return "FirmaSeguro rechazo la solicitud";
}

async function firmaSeguroRequest<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const config = getFirmaSeguroConfig();
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body,
    cache: "no-store",
  });
  const payload = await parseResponse(response);

  if (!response.ok) {
    const message = getFirmaSeguroErrorMessage(response.status, payload);
    throw new FirmaSeguroApiError(message, response.status, payload);
  }

  return payload as T;
}

function getNestedValue(source: unknown, keys: string[]): unknown {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }

  const record = source as JsonObject;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  for (const value of Object.values(record)) {
    const nested = getNestedValue(value, keys);
    if (nested !== undefined && nested !== null && nested !== "") {
      return nested;
    }
  }

  return undefined;
}

export function extractFirmaSeguroToken(payload: unknown) {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  const value = getNestedValue(payload, [
    "token",
    "access_token",
    "accessToken",
    "jwt",
    "bearer",
  ]);

  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function extractFirmaSeguroUuid(payload: unknown) {
  const value = getNestedValue(payload, [
    "uuid",
    "processUuid",
    "process_uuid",
    "processId",
    "process_id",
  ]);

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function extractFirmaSeguroStatus(payload: unknown) {
  const value = getNestedValue(payload, [
    "status",
    "state",
    "processStatus",
    "process_status",
    "statusName",
    "status_name",
    "name",
  ]);

  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function isFirmaSeguroCompletedStatus(status: string | null | undefined) {
  const normalized = String(status || "").trim().toUpperCase();
  return [
    "COMPLETED",
    "COMPLETE",
    "COMPLETADO",
    "FINALIZED",
    "FINALIZADO",
    "FINISHED",
    "SIGNED",
    "FIRMADO",
    "APROBADO",
    "APROBADA",
  ].some((item) => normalized.includes(item));
}

export function extractFirmaSeguroSignedDocument(payload: unknown) {
  const base64Value = getNestedValue(payload, [
    "base64String",
    "base64_string",
    "base64",
    "documentBase64",
    "document_base64",
    "fileBase64",
    "file_base64",
  ]);
  const fileNameValue = getNestedValue(payload, [
    "fileName",
    "file_name",
    "name",
    "documentName",
    "document_name",
  ]);

  return {
    base64:
      typeof base64Value === "string" && base64Value.trim()
        ? base64Value.trim()
        : "",
    fileName:
      typeof fileNameValue === "string" && fileNameValue.trim()
        ? fileNameValue.trim()
        : "",
  };
}

export async function firmaSeguroSignIn() {
  const config = getFirmaSeguroConfig();
  if (config.accessToken) {
    return {
      token: config.accessToken,
      payload: {
        source: "FIRMASEGURO_ACCESS_TOKEN",
      },
    };
  }

  if (!config.email || !config.password) {
    throw new FirmaSeguroApiError(
      "Falta configurar FIRMASEGURO_ACCESS_TOKEN o FIRMASEGURO_EMAIL y FIRMASEGURO_PASSWORD",
      500,
      null
    );
  }

  const payload = await firmaSeguroRequest<unknown>("/api/v2/Auth/SignIn", {
    method: "POST",
    body: {
      email: config.email,
      password: config.password,
    },
  });
  const token = extractFirmaSeguroToken(payload);

  if (!token) {
    throw new FirmaSeguroApiError(
      "FirmaSeguro no retorno token de autenticacion",
      500,
      payload
    );
  }

  return { token, payload };
}

export async function firmaSeguroCreateFull(token: string, payload: unknown) {
  return firmaSeguroRequest<unknown>("/api/v2/Process/create-full", {
    method: "POST",
    token,
    body: payload,
  });
}

export async function firmaSeguroCreateFullByCompany(
  token: string,
  payload: unknown
) {
  return firmaSeguroRequest<unknown>("/api/v2/Process/create-full-by-company", {
    method: "POST",
    token,
    body: payload,
  });
}

export async function firmaSeguroGetProcessStatus(token: string, uuid: string) {
  return firmaSeguroRequest<unknown>(
    `/api/v2/Process/get-process-status/${encodeURIComponent(uuid)}`,
    { token }
  );
}

export async function firmaSeguroGetSignaturesStatus(token: string, uuid: string) {
  return firmaSeguroRequest<unknown>(
    `/api/v2/Signature/get-signatures-status/${encodeURIComponent(uuid)}`,
    { token }
  );
}

export async function firmaSeguroGetDocumentsByUuid(uuid: string) {
  return firmaSeguroRequest<unknown>(
    `/api/v2/Document/ByUUID/${encodeURIComponent(uuid)}`
  );
}

export async function firmaSeguroChangeDocument(
  token: string,
  payload: { uuid: string; fileName?: string; base64String: string }
) {
  return firmaSeguroRequest<unknown>("/api/v2/Document/change-document", {
    method: "POST",
    token,
    body: payload,
  });
}
