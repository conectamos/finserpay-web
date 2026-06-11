type JsonObject = Record<string, unknown>;

export type FirmaSeguroConfig = {
  baseUrl: string;
  accessToken: string;
  email: string;
  password: string;
  authMode: string;
  nit: string | null;
  useCompanyEndpoint: boolean;
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

export function isFirmaSeguroPermissionError(error: unknown) {
  if (!(error instanceof FirmaSeguroApiError)) {
    return false;
  }

  const raw = [
    error.message,
    typeof error.detail === "string" ? error.detail : "",
  ].join(" ");
  const normalized = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return (
    normalized.includes("no tiene permitido") ||
    normalized.includes("not allowed") ||
    normalized.includes("forbidden")
  );
}

export function isFirmaSeguroUnauthorizedError(error: unknown) {
  return error instanceof FirmaSeguroApiError && error.status === 401;
}

function readEnv(name: string) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readNumberEnv(name: string, fallback: number) {
  const numeric = Number(readEnv(name));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function readOptionalBooleanEnv(name: string) {
  const value = readEnv(name).toLowerCase();
  if (!value) {
    return null;
  }

  if (["1", "true", "yes", "si", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return null;
}

function findTokenCandidate(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const token = findTokenCandidate(item);
      if (token) {
        return token;
      }
    }

    return "";
  }

  if (typeof value !== "object" || value === null) {
    return "";
  }

  const tokenKeys = new Set([
    "token",
    "access_token",
    "accessToken",
    "jwt",
    "bearer",
  ]);
  const record = value as JsonObject;

  for (const [key, item] of Object.entries(record)) {
    if (tokenKeys.has(key) && typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }

  for (const item of Object.values(record)) {
    const token = findTokenCandidate(item);
    if (token) {
      return token;
    }
  }

  return "";
}

function unwrapEnvValue(value: string) {
  let cleaned = value.trim();
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
  ];

  let changed = true;
  while (changed && cleaned.length >= 2) {
    changed = false;
    for (const [open, close] of quotePairs) {
      if (cleaned.startsWith(open) && cleaned.endsWith(close)) {
        cleaned = cleaned.slice(1, -1).trim();
        changed = true;
      }
    }
  }

  return cleaned;
}

function normalizeAccessTokenEnv(value: string) {
  let cleaned = unwrapEnvValue(value);
  if (!cleaned) {
    return "";
  }

  cleaned = cleaned.replace(/^Authorization\s*:\s*/i, "").trim();
  cleaned = unwrapEnvValue(cleaned);

  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    try {
      const token = findTokenCandidate(JSON.parse(cleaned));
      if (token && token !== cleaned) {
        return normalizeAccessTokenEnv(token);
      }
    } catch {
      // Keep the original value; FirmaSeguro will reject it if it is not a token.
    }
  }

  const jwtMatch = cleaned.match(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
  );
  if (jwtMatch) {
    return jwtMatch[0];
  }

  return cleaned;
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
  const nit = readEnv("FIRMASEGURO_NIT") || null;
  const explicitCompanyEndpoint = readOptionalBooleanEnv(
    "FIRMASEGURO_USE_COMPANY_ENDPOINT"
  );

  return {
    baseUrl: normalizeBaseUrl(readEnv("FIRMASEGURO_BASE_URL")),
    accessToken: normalizeAccessTokenEnv(readEnv("FIRMASEGURO_ACCESS_TOKEN")),
    email: readEnv("FIRMASEGURO_EMAIL"),
    password: readEnv("FIRMASEGURO_PASSWORD"),
    authMode: readEnv("FIRMASEGURO_AUTH_MODE").toLowerCase() || "auto",
    nit,
    useCompanyEndpoint: explicitCompanyEndpoint ?? false,
    processTypeId: readNumberEnv("FIRMASEGURO_PROCESS_TYPE_ID", 3),
    signatureMethodId: readNumberEnv("FIRMASEGURO_SIGNATURE_METHOD_ID", 2),
    authMethodId: readNumberEnv("FIRMASEGURO_AUTH_METHOD_ID", 4),
    balanceTypeId: readNumberEnv("FIRMASEGURO_BALANCE_TYPE_ID", 2),
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

  if (status === 401) {
    return "FirmaSeguro no autorizo la solicitud. Verifica que FIRMASEGURO_ACCESS_TOKEN sea un token API vigente y con permiso para crear procesos.";
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

function withRequestContext(message: string, status: number, path: string) {
  if (message.includes(path) || message.includes(`HTTP ${status}`)) {
    return message;
  }

  return `${message} (HTTP ${status} en ${path})`;
}

function sanitizeDiagnosticPayload(value: unknown): unknown {
  if (typeof value === "string") {
    const cleaned = stripHtml(value);
    return cleaned.length > 500 ? `${cleaned.slice(0, 500)}...` : cleaned;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDiagnosticPayload(item));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const sanitized: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (/base64|token|password|authorization|document/i.test(key)) {
      sanitized[key] = "[redacted]";
      continue;
    }

    sanitized[key] = sanitizeDiagnosticPayload(item);
  }

  return sanitized;
}

function buildAuthorizationHeader(token: string, raw = false) {
  const cleaned = token.trim();
  if (!cleaned) {
    return "";
  }

  if (raw || /^Bearer\s+/i.test(cleaned)) {
    return cleaned;
  }

  return `Bearer ${cleaned}`;
}

function shouldRetryWithRawAuthorization(
  status: number,
  message: string,
  token: string,
  authorization: string
) {
  if (!token || /^Bearer\s+/i.test(token.trim()) || authorization === token) {
    return false;
  }

  const normalized = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return (
    status === 401 ||
    status === 403 ||
    normalized.includes("no tiene permitido") ||
    normalized.includes("not allowed") ||
    normalized.includes("forbidden")
  );
}

async function firmaSeguroRequest<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const config = getFirmaSeguroConfig();
  const baseHeaders: Record<string, string> = {
    Accept: "application/json",
  };

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    baseHeaders["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const requestUrl = `${config.baseUrl}${path}`;
  const method = options.method || "GET";
  const authorization = options.token
    ? buildAuthorizationHeader(options.token)
    : "";

  async function execute(authorizationHeader: string, authorizationMode: string) {
    const headers = { ...baseHeaders };
    if (authorizationHeader) {
      headers.Authorization = authorizationHeader;
    }

    const response = await fetch(requestUrl, {
      method,
      headers,
      body,
      cache: "no-store",
    });
    const payload = await parseResponse(response);
    return { response, payload, authorizationMode };
  }

  const attempts: Array<{
    authorizationMode: string;
    status: number;
    ok: boolean;
    payload: unknown;
  }> = [];
  let { response, payload, authorizationMode } = await execute(
    authorization,
    options.token ? "bearer" : "none"
  );
  attempts.push({
    authorizationMode,
    status: response.status,
    ok: response.ok,
    payload: sanitizeDiagnosticPayload(payload),
  });

  if (!response.ok) {
    let message = getFirmaSeguroErrorMessage(response.status, payload);
    if (
      options.token &&
      shouldRetryWithRawAuthorization(
        response.status,
        message,
        options.token,
        authorization
      )
    ) {
      const retry = await execute(
        buildAuthorizationHeader(options.token, true),
        "raw"
      );
      response = retry.response;
      payload = retry.payload;
      authorizationMode = retry.authorizationMode;
      attempts.push({
        authorizationMode,
        status: response.status,
        ok: response.ok,
        payload: sanitizeDiagnosticPayload(payload),
      });
      message = getFirmaSeguroErrorMessage(response.status, payload);
    }

    if (response.ok) {
      return payload as T;
    }

    const contextualMessage = withRequestContext(message, response.status, path);
    const detail = {
      path,
      method,
      status: response.status,
      authorizationMode,
      payload: sanitizeDiagnosticPayload(payload),
      attempts,
    };
    console.error("[FirmaSeguro] request failed", detail);
    throw new FirmaSeguroApiError(contextualMessage, response.status, detail);
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

function buildAccessTokenAuthPayload(
  token: string,
  warning?: string
) {
  return {
    token,
    payload: {
      source: "FIRMASEGURO_ACCESS_TOKEN",
      ...(warning ? { signInWarning: warning } : {}),
    },
  };
}

export async function firmaSeguroSignIn(
  options: { ignoreAccessToken?: boolean } = {}
) {
  const config = getFirmaSeguroConfig();
  const tokenOnly =
    config.authMode === "token" || config.authMode === "access_token";
  const emailOnly =
    config.authMode === "email" || config.authMode === "password";

  if (tokenOnly) {
    if (config.accessToken && !options.ignoreAccessToken) {
      return buildAccessTokenAuthPayload(config.accessToken);
    }

    throw new FirmaSeguroApiError(
      "FIRMASEGURO_AUTH_MODE=token requiere FIRMASEGURO_ACCESS_TOKEN",
      500,
      null
    );
  }

  if (config.accessToken && !options.ignoreAccessToken && !emailOnly) {
    return buildAccessTokenAuthPayload(config.accessToken);
  }

  if (config.email && config.password) {
    try {
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

      return {
        token,
        payload: {
          source: "FIRMASEGURO_EMAIL_PASSWORD",
        },
      };
    } catch (error) {
      if (
        emailOnly ||
        options.ignoreAccessToken ||
        !config.accessToken ||
        (!isFirmaSeguroUnauthorizedError(error) &&
          !isFirmaSeguroPermissionError(error))
      ) {
        throw error;
      }

      const warning =
        error instanceof Error
          ? error.message
          : "No se pudo iniciar sesion en FirmaSeguro";
      return buildAccessTokenAuthPayload(config.accessToken, warning);
    }
  }

  if (config.accessToken && !options.ignoreAccessToken) {
    return buildAccessTokenAuthPayload(config.accessToken);
  }

  throw new FirmaSeguroApiError(
    "Falta configurar FIRMASEGURO_ACCESS_TOKEN o FIRMASEGURO_EMAIL y FIRMASEGURO_PASSWORD",
    500,
    null
  );
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

export async function firmaSeguroGetBalanceByNit(token: string, nit: string) {
  return firmaSeguroRequest<unknown>(
    `/api/v2/Balance/balance-by-nit/${encodeURIComponent(nit)}`,
    { token }
  );
}

export async function firmaSeguroGetSignatureTypes(token: string) {
  return firmaSeguroRequest<unknown>("/api/v2/SignatureTypes/All", { token });
}

export async function firmaSeguroGetAuthenticationTypes(token: string) {
  return firmaSeguroRequest<unknown>("/api/v2/AutenticationTypes/All", {
    token,
  });
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
