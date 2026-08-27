import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export const IPHONE_ENROLLMENT_CHECKLIST_VERSION =
  "IPHONE_ENROLLMENT_V1" as const;
export const IPHONE_ENROLLMENT_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const IPHONE_ENROLLMENT_CASE_TTL_SECONDS = 10 * 60;
export const IPHONE_ENROLLMENT_MAX_BODY_BYTES = 4 * 1024;
const IPHONE_ENROLLMENT_GRANT_TOKEN_VERSION = "v1";
export const IPHONE_ENROLLMENT_SHARED_GRANT_ID =
  "00000000-0000-4000-8000-000000000001";
export const IPHONE_ENROLLMENT_SHARED_ANALYST = {
  name: "Especialista de enrolamiento",
  externalId: "ACCESO-COMPARTIDO",
} as const;

export const IPHONE_ENROLLMENT_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

export type IphoneEnrollmentChecklist = {
  documentMatched: true;
  imeiMatched: true;
  enrollmentApproved: true;
};

export type IphoneEnrollmentAnalyst = {
  name: string;
  externalId: string;
};

export type IphoneEnrollmentPortalSessionPayload = {
  type: "iphone-enrollment-session";
  accessMode: "GRANT" | "SHARED";
  accessFingerprint: string;
  grantId: string;
  sessionId: string;
  analystName: string;
  analystExternalId: string;
  issuedAt: number;
  expiresAt: number;
};

export type IphoneEnrollmentCaseTokenPayload = {
  type: "iphone-enrollment-case";
  solicitudId: number;
  documentHash: string;
  imeiHash: string;
  grantId: string;
  sessionBinding: string;
  correlationId: string;
  issuedAt: number;
  expiresAt: number;
};

type PortalConfiguration = {
  enabled: boolean;
  configured: boolean;
  sessionSecret: string;
  identityPepper: string;
  identityKeyVersion: string;
  sharedAccessSecret: string;
};

export class IphoneEnrollmentRequestBodyError extends Error {
  readonly code: "UNSUPPORTED_MEDIA_TYPE" | "PAYLOAD_TOO_LARGE" | "INVALID_JSON";

  constructor(code: IphoneEnrollmentRequestBodyError["code"]) {
    super(code);
    this.code = code;
    this.name = "IphoneEnrollmentRequestBodyError";
  }
}

function compactText(value: unknown, maxLength: number) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isEnabled(value: unknown) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase()
  );
}

export function getIphoneEnrollmentPortalConfiguration(): PortalConfiguration {
  const sessionSecret = String(
    process.env.IPHONE_ENROLLMENT_SESSION_SECRET || ""
  ).trim();
  const identityPepper = String(
    process.env.IPHONE_ENROLLMENT_IDENTITY_PEPPER || ""
  ).trim();
  const rawKeyVersion = String(
    process.env.IPHONE_ENROLLMENT_IDENTITY_KEY_VERSION || "v1"
  ).trim();
  const identityKeyVersion = /^[A-Za-z0-9._-]{1,32}$/.test(rawKeyVersion)
    ? rawKeyVersion
    : "";
  const sharedAccessSecret = String(
    process.env.IPHONE_ENROLLMENT_SHARED_ACCESS_SECRET || ""
  ).trim();
  const enabled = isEnabled(process.env.IPHONE_ENROLLMENT_ENABLED);

  return {
    enabled,
    configured:
      enabled &&
      sessionSecret.length >= 32 &&
      identityPepper.length >= 32 &&
      Boolean(identityKeyVersion) &&
      /^[A-Za-z0-9_-]{43,128}$/.test(sharedAccessSecret),
    sessionSecret,
    identityPepper,
    identityKeyVersion,
    sharedAccessSecret,
  };
}

export function getIphoneEnrollmentIdentityKeyVersion() {
  const configuration = getIphoneEnrollmentPortalConfiguration();
  if (!configuration.configured) {
    throw new Error("IPHONE_ENROLLMENT_NOT_CONFIGURED");
  }
  return configuration.identityKeyVersion;
}

export function getIphoneEnrollmentPortalCookieName() {
  return process.env.NODE_ENV === "production"
    ? "__Secure-finser-iphone-enrollment"
    : "finser-iphone-enrollment";
}

export function getIphoneEnrollmentPortalCookiePath() {
  return "/api/public/iphone-enrollment";
}

export function normalizeIphoneEnrollmentDocument(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^\d{5,20}$/.test(digits) ? digits : null;
}

export function normalizeIphoneEnrollmentImei(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^\d{15}$/.test(digits) ? digits : null;
}

export function normalizeIphoneEnrollmentAnalystName(value: unknown) {
  const name = compactText(value, 100);
  return name.length >= 3 ? name : null;
}

export function normalizeIphoneEnrollmentAnalystExternalId(value: unknown) {
  const identifier = compactText(value, 120);
  return identifier.length >= 2 ? identifier : null;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

function constantTimeTextMatches(received: string, expected: string) {
  if (!received || !expected) return false;
  return timingSafeEqual(digest(received), digest(expected));
}

function identityHmacHex(domain: string, value: string) {
  const { configured, identityPepper, identityKeyVersion } =
    getIphoneEnrollmentPortalConfiguration();
  if (!configured) {
    throw new Error("IPHONE_ENROLLMENT_NOT_CONFIGURED");
  }
  return createHmac("sha256", identityPepper)
    .update(`${identityKeyVersion}:${domain}:${value}`)
    .digest("hex");
}

function sessionHmacHex(domain: string, value: string) {
  const { configured, sessionSecret } =
    getIphoneEnrollmentPortalConfiguration();
  if (!configured) {
    throw new Error("IPHONE_ENROLLMENT_NOT_CONFIGURED");
  }
  return createHmac("sha256", sessionSecret)
    .update(`${domain}:${value}`)
    .digest("hex");
}

export function hashIphoneEnrollmentDocument(document: string) {
  return identityHmacHex("document", document);
}

export function hashIphoneEnrollmentImei(imei: string) {
  return identityHmacHex("imei", imei);
}

export function hashIphoneEnrollmentGrantToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function hashIphoneEnrollmentSessionId(sessionId: string) {
  return sessionHmacHex("session-id", sessionId);
}

export function hashIphoneEnrollmentGrantFingerprint(grantId: string) {
  return identityHmacHex("grant", grantId);
}

export function hashIphoneEnrollmentSharedAccessFingerprint() {
  const { configured, sharedAccessSecret } =
    getIphoneEnrollmentPortalConfiguration();
  if (!configured) {
    throw new Error("IPHONE_ENROLLMENT_NOT_CONFIGURED");
  }
  return identityHmacHex("shared-access", sharedAccessSecret);
}

export function hashIphoneEnrollmentSharedReviewFingerprint() {
  return identityHmacHex("shared-review", IPHONE_ENROLLMENT_SHARED_GRANT_ID);
}

export function hashIphoneEnrollmentRateLimitKey(
  subject: "grant" | "session",
  value: string
) {
  return sessionHmacHex(`rate-limit-${subject}`, value);
}

export function createIphoneEnrollmentGrantSecret() {
  const nonce = randomBytes(32).toString("base64url");
  const signature = sessionHmacHex("grant-token-v1", nonce);
  return `${IPHONE_ENROLLMENT_GRANT_TOKEN_VERSION}.${nonce}.${signature}`;
}

export function normalizeIphoneEnrollmentGrantSecret(value: unknown) {
  const token = String(value || "").trim();
  const match =
    /^v1\.([A-Za-z0-9_-]{43})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return null;
  const expectedSignature = sessionHmacHex("grant-token-v1", match[1]);
  const actualBuffer = Buffer.from(match[2], "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
    ? token
    : null;
}

export function normalizeIphoneEnrollmentSharedAccessSecret(value: unknown) {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9_-]{43,128}$/.test(token) ? token : null;
}

export function iphoneEnrollmentSharedAccessSecretMatches(value: unknown) {
  const configuration = getIphoneEnrollmentPortalConfiguration();
  const received = normalizeIphoneEnrollmentSharedAccessSecret(value);
  const expected = normalizeIphoneEnrollmentSharedAccessSecret(
    configuration.sharedAccessSecret
  );
  return Boolean(
    configuration.configured &&
      received &&
      expected &&
      constantTimeTextMatches(received, expected)
  );
}

function signEncodedPayload(encodedPayload: string, purpose: string) {
  const { configured, sessionSecret } =
    getIphoneEnrollmentPortalConfiguration();
  if (!configured) {
    throw new Error("IPHONE_ENROLLMENT_NOT_CONFIGURED");
  }
  return createHmac("sha256", sessionSecret)
    .update(`${purpose}:${encodedPayload}`)
    .digest("base64url");
}

function encodeSignedPayload(payload: object, purpose: string) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${signEncodedPayload(encodedPayload, purpose)}`;
}

function decodeSignedPayload<T>(token: unknown, purpose: string): T | null {
  const [encodedPayload, receivedSignature, ...extra] = String(token || "").split(".");
  if (!encodedPayload || !receivedSignature || extra.length) return null;

  const expectedSignature = signEncodedPayload(encodedPayload, purpose);
  if (!constantTimeTextMatches(receivedSignature, expectedSignature)) return null;

  try {
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function issueIphoneEnrollmentPortalSession(input: {
  grantId: string;
  analyst: IphoneEnrollmentAnalyst;
  grantExpiresAt: Date;
  accessMode?: "GRANT" | "SHARED";
  accessFingerprint?: string;
  now?: Date;
}): {
  value: string;
  expiresAt: Date;
  payload: IphoneEnrollmentPortalSessionPayload;
} {
  const now = input.now || new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const maximumExpiresAt = issuedAt + IPHONE_ENROLLMENT_SESSION_TTL_SECONDS;
  const grantExpiresAt = Math.floor(input.grantExpiresAt.getTime() / 1000);
  const expiresAt = Math.min(maximumExpiresAt, grantExpiresAt);
  if (expiresAt <= issuedAt) {
    throw new Error("IPHONE_ENROLLMENT_GRANT_EXPIRED");
  }
  const accessMode = input.accessMode || "GRANT";
  const accessFingerprint =
    input.accessFingerprint ||
    (accessMode === "SHARED"
      ? hashIphoneEnrollmentSharedAccessFingerprint()
      : hashIphoneEnrollmentGrantFingerprint(input.grantId));
  const payload: IphoneEnrollmentPortalSessionPayload = {
    type: "iphone-enrollment-session",
    accessMode,
    accessFingerprint,
    grantId: input.grantId,
    sessionId: randomBytes(32).toString("base64url"),
    analystName: input.analyst.name,
    analystExternalId: input.analyst.externalId,
    issuedAt,
    expiresAt,
  };
  return {
    value: encodeSignedPayload(payload, "portal-session"),
    expiresAt: new Date(expiresAt * 1000),
    payload,
  };
}

export function issueIphoneEnrollmentSharedPortalSession(
  now = new Date()
) {
  return issueIphoneEnrollmentPortalSession({
    grantId: IPHONE_ENROLLMENT_SHARED_GRANT_ID,
    analyst: IPHONE_ENROLLMENT_SHARED_ANALYST,
    grantExpiresAt: new Date(
      now.getTime() + IPHONE_ENROLLMENT_SESSION_TTL_SECONDS * 1000
    ),
    accessMode: "SHARED",
    accessFingerprint: hashIphoneEnrollmentSharedAccessFingerprint(),
    now,
  });
}

export function verifyIphoneEnrollmentPortalSession(
  token: unknown,
  now = new Date()
): IphoneEnrollmentPortalSessionPayload | null {
  const configuration = getIphoneEnrollmentPortalConfiguration();
  if (!configuration.configured) return null;
  const payload = decodeSignedPayload<IphoneEnrollmentPortalSessionPayload>(
    token,
    "portal-session"
  );
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !payload ||
    payload.type !== "iphone-enrollment-session" ||
    !["GRANT", "SHARED"].includes(payload.accessMode) ||
    !/^[a-f0-9]{64}$/.test(payload.accessFingerprint) ||
    !/^[0-9a-f-]{36}$/i.test(payload.grantId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.sessionId) ||
    normalizeIphoneEnrollmentAnalystName(payload.analystName) !==
      payload.analystName ||
    normalizeIphoneEnrollmentAnalystExternalId(payload.analystExternalId) !==
      payload.analystExternalId ||
    !Number.isInteger(payload.issuedAt) ||
    !Number.isInteger(payload.expiresAt) ||
    payload.issuedAt > nowSeconds + 60 ||
    payload.expiresAt <= nowSeconds ||
    payload.expiresAt - payload.issuedAt >
      IPHONE_ENROLLMENT_SESSION_TTL_SECONDS
  ) {
    return null;
  }
  if (payload.accessMode === "SHARED") {
    if (
      payload.grantId !== IPHONE_ENROLLMENT_SHARED_GRANT_ID ||
      payload.analystName !== IPHONE_ENROLLMENT_SHARED_ANALYST.name ||
      payload.analystExternalId !==
        IPHONE_ENROLLMENT_SHARED_ANALYST.externalId ||
      !constantTimeTextMatches(
        payload.accessFingerprint,
        hashIphoneEnrollmentSharedAccessFingerprint()
      )
    ) {
      return null;
    }
  } else if (
    !constantTimeTextMatches(
      payload.accessFingerprint,
      hashIphoneEnrollmentGrantFingerprint(payload.grantId)
    )
  ) {
    return null;
  }
  return payload;
}

export function isSharedIphoneEnrollmentPortalSession(
  session: IphoneEnrollmentPortalSessionPayload
) {
  return (
    session.accessMode === "SHARED" &&
    session.grantId === IPHONE_ENROLLMENT_SHARED_GRANT_ID &&
    session.analystName === IPHONE_ENROLLMENT_SHARED_ANALYST.name &&
    session.analystExternalId === IPHONE_ENROLLMENT_SHARED_ANALYST.externalId &&
    constantTimeTextMatches(
      session.accessFingerprint,
      hashIphoneEnrollmentSharedAccessFingerprint()
    )
  );
}

export function getIphoneEnrollmentSessionBinding(
  session: Pick<
    IphoneEnrollmentPortalSessionPayload,
    "accessFingerprint" | "accessMode" | "grantId" | "sessionId"
  >
) {
  return sessionHmacHex(
    "case-session",
    `${session.accessMode}:${session.accessFingerprint}:${session.grantId}:${session.sessionId}`
  );
}

export function createIphoneEnrollmentCaseToken(input: {
  solicitudId: number;
  documentHash: string;
  imeiHash: string;
  session: IphoneEnrollmentPortalSessionPayload;
  now?: Date;
}) {
  const issuedAt = Math.floor((input.now || new Date()).getTime() / 1000);
  const expiresAt = Math.min(
    issuedAt + IPHONE_ENROLLMENT_CASE_TTL_SECONDS,
    input.session.expiresAt
  );
  const payload: IphoneEnrollmentCaseTokenPayload = {
    type: "iphone-enrollment-case",
    solicitudId: input.solicitudId,
    documentHash: input.documentHash,
    imeiHash: input.imeiHash,
    grantId: input.session.grantId,
    sessionBinding: getIphoneEnrollmentSessionBinding(input.session),
    correlationId: randomUUID(),
    issuedAt,
    expiresAt,
  };
  return encodeSignedPayload(payload, "case-token");
}

export function verifyIphoneEnrollmentCaseToken(
  token: unknown,
  now = new Date()
): IphoneEnrollmentCaseTokenPayload | null {
  const payload = decodeSignedPayload<IphoneEnrollmentCaseTokenPayload>(
    token,
    "case-token"
  );
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !payload ||
    payload.type !== "iphone-enrollment-case" ||
    !Number.isInteger(payload.solicitudId) ||
    payload.solicitudId <= 0 ||
    !/^[a-f0-9]{64}$/.test(payload.documentHash) ||
    !/^[a-f0-9]{64}$/.test(payload.imeiHash) ||
    !/^[0-9a-f-]{36}$/i.test(payload.grantId) ||
    !/^[a-f0-9]{64}$/.test(payload.sessionBinding) ||
    !/^[0-9a-f-]{36}$/i.test(payload.correlationId) ||
    !Number.isInteger(payload.issuedAt) ||
    !Number.isInteger(payload.expiresAt) ||
    payload.issuedAt > nowSeconds + 60 ||
    payload.expiresAt <= nowSeconds ||
    payload.expiresAt - payload.issuedAt > IPHONE_ENROLLMENT_CASE_TTL_SECONDS
  ) {
    return null;
  }
  return payload;
}

export function isIphoneEnrollmentCaseTokenForSession(
  caseToken: IphoneEnrollmentCaseTokenPayload,
  session: IphoneEnrollmentPortalSessionPayload
) {
  return (
    caseToken.grantId === session.grantId &&
    constantTimeTextMatches(
      caseToken.sessionBinding,
      getIphoneEnrollmentSessionBinding(session)
    )
  );
}

export function buildIphoneEnrollmentChecklist(
  enrollmentApproved: unknown
): IphoneEnrollmentChecklist | null {
  if (enrollmentApproved !== true) return null;
  return {
    documentMatched: true,
    imeiMatched: true,
    enrollmentApproved: true,
  };
}

export function hashIphoneEnrollmentChecklist(
  checklist: IphoneEnrollmentChecklist
) {
  return identityHmacHex(
    "checklist",
    JSON.stringify({
      version: IPHONE_ENROLLMENT_CHECKLIST_VERSION,
      ...checklist,
    })
  );
}

export async function readLimitedIphoneEnrollmentJson<T extends object>(
  request: Request,
  maximumBytes = IPHONE_ENROLLMENT_MAX_BODY_BYTES
): Promise<T> {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new IphoneEnrollmentRequestBodyError("UNSUPPORTED_MEDIA_TYPE");
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new IphoneEnrollmentRequestBodyError("PAYLOAD_TOO_LARGE");
  }
  if (!request.body) {
    throw new IphoneEnrollmentRequestBodyError("INVALID_JSON");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new IphoneEnrollmentRequestBodyError("PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }

  try {
    const body = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("INVALID_JSON");
    }
    return parsed as T;
  } catch {
    throw new IphoneEnrollmentRequestBodyError("INVALID_JSON");
  }
}

export function iphoneEnrollmentBodyErrorResponse(
  error: IphoneEnrollmentRequestBodyError
) {
  if (error.code === "UNSUPPORTED_MEDIA_TYPE") {
    return { status: 415, error: "Contenido invalido" };
  }
  if (error.code === "PAYLOAD_TOO_LARGE") {
    return { status: 413, error: "Contenido demasiado grande" };
  }
  return { status: 400, error: "Contenido invalido" };
}

export function isSameOriginIphoneEnrollmentRequest(request: Request) {
  const origin = request.headers.get("origin")?.trim();
  if (!origin) return false;

  try {
    const portalOrigin = String(
      process.env.IPHONE_ENROLLMENT_PUBLIC_ORIGIN || ""
    ).trim();
    if (portalOrigin) {
      return new URL(portalOrigin).origin === origin;
    }
  } catch {
    return false;
  }

  const allowedOrigins = new Set<string>();
  try {
    allowedOrigins.add(new URL(request.url).origin);
  } catch {
    return false;
  }
  try {
    const configuredOrigin = String(process.env.NEXT_PUBLIC_APP_URL || "").trim();
    if (configuredOrigin) allowedOrigins.add(new URL(configuredOrigin).origin);
  } catch {
    // A malformed optional URL must not broaden the allowed origins.
  }
  return allowedOrigins.has(origin);
}
