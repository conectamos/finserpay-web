import { createHmac, timingSafeEqual } from "node:crypto";

export type VeriffStatus =
  | "ABANDONED"
  | "APPROVED"
  | "DECLINED"
  | "ERROR"
  | "EXPIRED"
  | "PENDING"
  | "RESUBMISSION"
  | "REVIEW";

export class VeriffApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status = 500, payload: unknown = null) {
    super(message);
    this.name = "VeriffApiError";
    this.status = status;
    this.payload = payload;
  }
}

type VeriffRequestOptions = {
  body?: unknown;
  sign?: "body" | "session";
  sessionId?: string;
};

type VeriffMediaInput = {
  context: "document-back" | "document-front" | "face";
  content: string;
  timestamp?: string | null;
};

export type VeriffIdentityData = {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  documentNumber: string | null;
  documentType: string | null;
  documentCountry: string | null;
  dateOfBirth: string | null;
  issueDate: string | null;
  validUntil: string | null;
  gender: string | null;
  nationality: string | null;
  placeOfBirth: string | null;
};

type CreateSessionInput = {
  callbackUrl?: string | null;
  documentNumber?: string | null;
  documentType?: string | null;
  endUserId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  vendorData?: string | null;
};

const DEFAULT_VERIFF_BASE_URL = "https://stationapi.veriff.com";

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanDate(value: unknown) {
  const raw = cleanText(value);
  if (!raw) {
    return null;
  }

  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return isoMatch[1];
  }

  const slashMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[2]}-${slashMatch[1]}`;
  }

  return raw;
}

function cleanUrl(value: unknown) {
  const raw = cleanText(value || DEFAULT_VERIFF_BASE_URL).replace(/\/+$/, "");
  return raw.endsWith("/v1") ? raw.slice(0, -3) : raw;
}

function getSecret() {
  return cleanText(process.env.VERIFF_SHARED_SECRET);
}

function getApiKey() {
  return cleanText(process.env.VERIFF_API_KEY);
}

export function getVeriffConfig() {
  const mode = cleanText(process.env.VERIFF_IDENTITY_MODE || "soft").toLowerCase();
  const rawEnvironment = cleanText(
    process.env.VERIFF_ENVIRONMENT || process.env.VERIFF_ENV || "test"
  ).toLowerCase();
  const environment =
    rawEnvironment === "live" || rawEnvironment === "production"
      ? "live"
      : "test";

  return {
    apiKey: getApiKey(),
    baseUrl: cleanUrl(process.env.VERIFF_BASE_URL),
    callbackUrl: cleanText(process.env.VERIFF_CALLBACK_URL),
    decisionsTrusted: environment === "live",
    environment,
    mode: mode === "required" ? "required" : mode === "off" ? "off" : "soft",
    sharedSecret: getSecret(),
  } as const;
}

export function isVeriffConfigured() {
  const config = getVeriffConfig();
  return Boolean(config.apiKey && config.sharedSecret && config.baseUrl);
}

export function isVeriffRequired() {
  const config = getVeriffConfig();
  return config.mode === "required";
}

export function areVeriffDecisionsTrusted() {
  const config = getVeriffConfig();
  return config.decisionsTrusted;
}

export function signVeriffPayload(payload: string) {
  const secret = getSecret();

  if (!secret) {
    throw new VeriffApiError("Veriff no tiene clave secreta configurada", 500);
  }

  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyVeriffSignature(payload: string, signature: string | null) {
  const normalizedSignature = cleanText(signature).toLowerCase();
  if (!normalizedSignature) {
    return false;
  }

  const expected = signVeriffPayload(payload).toLowerCase();
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(normalizedSignature, "hex");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function veriffApiUrl(path: string) {
  const config = getVeriffConfig();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${config.baseUrl}/v1${normalizedPath}`;
}

function parseResponsePayload(text: string) {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function getErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const message = cleanText(record.message || record.error);
    if (message) {
      return message;
    }
  }

  return fallback;
}

function buildHeaders(payloadToSign?: string) {
  const config = getVeriffConfig();
  if (!config.apiKey) {
    throw new VeriffApiError("Veriff no tiene API key configurada", 500);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-AUTH-CLIENT": config.apiKey,
  };

  if (payloadToSign !== undefined) {
    headers["X-HMAC-SIGNATURE"] = signVeriffPayload(payloadToSign);
  }

  return headers;
}

async function veriffRequest<T>(
  method: "GET" | "PATCH" | "POST",
  path: string,
  options: VeriffRequestOptions = {}
) {
  if (!isVeriffConfigured()) {
    throw new VeriffApiError(
      "Veriff no esta configurado. Faltan VERIFF_API_KEY, VERIFF_SHARED_SECRET o VERIFF_BASE_URL.",
      503
    );
  }

  const bodyJson =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const signatureSource =
    options.sign === "body"
      ? bodyJson || ""
      : options.sign === "session"
        ? cleanText(options.sessionId)
        : undefined;
  const response = await fetch(veriffApiUrl(path), {
    method,
    headers: buildHeaders(signatureSource),
    body: bodyJson,
    cache: "no-store",
  });
  const text = await response.text();
  const payload = parseResponsePayload(text);

  if (!response.ok) {
    throw new VeriffApiError(
      getErrorMessage(payload, `Veriff respondio con estado ${response.status}`),
      response.status,
      payload
    );
  }

  return payload as T;
}

function mapDocumentType(value: string | null | undefined) {
  const normalized = cleanText(value).toUpperCase();

  if (normalized.includes("PASAPORTE")) {
    return "PASSPORT";
  }

  if (normalized.includes("EXTRANJERIA")) {
    return "RESIDENCE_PERMIT";
  }

  return "ID_CARD";
}

export function getVeriffPublicSummary() {
  const config = getVeriffConfig();

  return {
    configured: isVeriffConfigured(),
    decisionsTrusted: config.decisionsTrusted,
    environment: config.environment,
    mode: config.mode,
    baseUrl: config.baseUrl,
  };
}

export function normalizeVeriffStatus(value: unknown): VeriffStatus {
  const normalized = cleanText(value).toUpperCase();

  if (["APPROVED", "SUCCESS"].includes(normalized)) {
    return "APPROVED";
  }

  if (["DECLINED", "FAILED", "FAIL", "REJECTED"].includes(normalized)) {
    return "DECLINED";
  }

  if (normalized.includes("ABANDONED")) {
    return "ABANDONED";
  }

  if (normalized.includes("EXPIRED")) {
    return "EXPIRED";
  }

  if (normalized.includes("RESUBMISSION")) {
    return "RESUBMISSION";
  }

  if (normalized.includes("REVIEW")) {
    return "REVIEW";
  }

  if (normalized.includes("ERROR")) {
    return "ERROR";
  }

  return "PENDING";
}

function rootAndVerification(payload: unknown) {
  const root =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const data =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : {};
  const verification =
    root.verification && typeof root.verification === "object"
      ? (root.verification as Record<string, unknown>)
      : data.verification && typeof data.verification === "object"
        ? (data.verification as Record<string, unknown>)
      : root;

  return { data, root, verification };
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findNestedRecord(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
  depth = 0
): Record<string, unknown> | null {
  if (depth > 6) {
    return null;
  }

  const record = asRecord(value);

  if (record) {
    if (predicate(record)) {
      return record;
    }

    for (const child of Object.values(record)) {
      const found = findNestedRecord(child, predicate, depth + 1);
      if (found) {
        return found;
      }
    }
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findNestedRecord(child, predicate, depth + 1);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

export function summarizeVeriffDecision(payload: unknown) {
  const { root, verification } = rootAndVerification(payload);
  const status = normalizeVeriffStatus(verification.status || root.status);

  return {
    attemptId: cleanText(verification.attemptId) || null,
    code: cleanText(verification.code) || null,
    decision: status,
    decidedAt:
      cleanText(
        verification.decisionTime ||
          verification.acceptanceTime ||
          verification.updatedTime
      ) || null,
    reason: cleanText(verification.reason) || null,
    reasonCode: cleanText(verification.reasonCode) || null,
    sessionId: cleanText(verification.id) || null,
    status,
  };
}

export function extractVeriffSessionUrl(payload: unknown) {
  const { data, root, verification } = rootAndVerification(payload);
  const url = cleanText(
    verification.url ||
      verification.sessionUrl ||
      verification.sessionURL ||
      root.url ||
      root.sessionUrl ||
      root.sessionURL ||
      data.url ||
      data.sessionUrl ||
      data.sessionURL
  );

  return url;
}

export function extractVeriffIdentityData(payload: unknown): VeriffIdentityData | null {
  const { data, root, verification } = rootAndVerification(payload);
  const person =
    verification.person && typeof verification.person === "object"
      ? (verification.person as Record<string, unknown>)
      : data.person && typeof data.person === "object"
        ? (data.person as Record<string, unknown>)
        : findNestedRecord(root, (record) =>
            Boolean(
              record.firstName ||
                record.fullName ||
                record.idNumber ||
                record.dateOfBirth ||
                record.nameComponents
            )
          ) || {};
  const document =
    verification.document && typeof verification.document === "object"
      ? (verification.document as Record<string, unknown>)
      : data.document && typeof data.document === "object"
        ? (data.document as Record<string, unknown>)
        : findNestedRecord(root, (record) =>
            Boolean(
              (record.number || record.documentNumber) &&
                (record.type || record.country || record.validFrom || record.validUntil)
            )
          ) || {};
  const nameComponents =
    person.nameComponents && typeof person.nameComponents === "object"
      ? (person.nameComponents as Record<string, unknown>)
      : {};
  const firstName =
    cleanText(nameComponents.firstNameOnly) || cleanText(person.firstName);
  const lastName = cleanText(person.lastName);
  const fullName =
    cleanText(person.fullName) || [firstName, lastName].filter(Boolean).join(" ");
  const documentNumber =
    cleanText(person.idNumber || person.idCode || person.documentNumber) ||
    cleanText(document.number || document.documentNumber);
  const identityData: VeriffIdentityData = {
    firstName: firstName || null,
    lastName: lastName || null,
    fullName: fullName || null,
    documentNumber: documentNumber || null,
    documentType: cleanText(document.type) || null,
    documentCountry: cleanText(document.country) || null,
    dateOfBirth: cleanDate(person.dateOfBirth),
    issueDate: cleanDate(document.validFrom || document.firstIssue),
    validUntil: cleanDate(document.validUntil),
    gender: cleanText(person.gender) || null,
    nationality: cleanText(person.nationality || person.citizenship) || null,
    placeOfBirth: cleanText(person.placeOfBirth) || null,
  };

  return Object.values(identityData).some(Boolean) ? identityData : null;
}

export async function veriffCreateSession(input: CreateSessionInput) {
  const callback = cleanText(input.callbackUrl || getVeriffConfig().callbackUrl);
  const firstName = cleanText(input.firstName);
  const lastName = cleanText(input.lastName);
  const documentNumber = cleanText(input.documentNumber);
  const hasCompleteIdentity = Boolean(firstName && lastName && documentNumber);
  const verification: Record<string, unknown> = {
    endUserId: cleanText(input.endUserId) || undefined,
    vendorData: cleanText(input.vendorData) || undefined,
  };

  if (hasCompleteIdentity) {
    verification.person = {
      firstName,
      lastName,
      idNumber: documentNumber,
    };
  }

  if (hasCompleteIdentity) {
    verification.document = {
      country: "CO",
      number: documentNumber,
      type: mapDocumentType(input.documentType),
    };
  }

  if (callback) {
    verification.callback = callback;
  }

  return veriffRequest<Record<string, unknown>>("POST", "/sessions", {
    body: { verification },
  });
}

export async function veriffUploadMedia(sessionId: string, media: VeriffMediaInput) {
  const body = {
    image: {
      context: media.context,
      content: media.content,
      timestamp: media.timestamp || undefined,
    },
  };

  return veriffRequest<Record<string, unknown>>(
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/media`,
    {
      body,
      sign: "body",
      sessionId,
    }
  );
}

export async function veriffSubmitSession(sessionId: string) {
  const body = {
    verification: {
      status: "submitted",
    },
  };

  return veriffRequest<Record<string, unknown>>(
    "PATCH",
    `/sessions/${encodeURIComponent(sessionId)}`,
    {
      body,
      sign: "body",
      sessionId,
    }
  );
}

export async function veriffGetDecision(sessionId: string) {
  return veriffRequest<Record<string, unknown>>(
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/decision`,
    {
      sign: "session",
      sessionId,
    }
  );
}

export async function veriffGetPerson(sessionId: string) {
  return veriffRequest<Record<string, unknown>>(
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/person`,
    {
      sign: "session",
      sessionId,
    }
  );
}

export function extractVeriffSessionId(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const root = payload as Record<string, unknown>;
  const verification =
    root.verification && typeof root.verification === "object"
      ? (root.verification as Record<string, unknown>)
      : null;

  return cleanText(verification?.id || root.id);
}

export function redactVeriffPayload(payload: unknown): unknown {
  return JSON.parse(
    JSON.stringify(payload, (key, value) => {
      if (/secret|token|authorization|signature/i.test(key)) {
        return "[redacted]";
      }

      if (typeof value === "string" && value.startsWith("data:") && value.length > 120) {
        return `[data-url:${value.length}]`;
      }

      return value;
    })
  );
}
