import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "session";
export const APPROVAL_ACCESS_COOKIE_NAME = "approval_access_session";
export const SELLER_SESSION_COOKIE_NAME = "seller_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export const APPROVAL_ACCESS_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const approvalGrantIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type SessionPayload = {
  exp: number;
  userId: number;
  credentialVersion?: string;
  approvalAccessGrantId?: string;
};

type SellerSessionPayload = {
  accesoSedeId?: number;
  exp: number;
  sedeId: number;
  userId: number;
  vendedorId: number;
};

function getSessionSecret() {
  const secret =
    process.env.SESSION_SECRET ??
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET ??
    (process.env.NODE_ENV !== "production" ? process.env.DATABASE_URL : undefined);

  if (!secret) {
    throw new Error("SESSION_SECRET no configurado");
  }

  return secret;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string) {
  return createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
}

export function getSessionCredentialVersion(passwordHash: string, updatedAt?: Date) {
  return createHash("sha256").update(passwordHash).update("|").update(updatedAt?.toISOString() || "").digest("base64url");
}

export function createSessionToken(userId: number, credentialVersion?: string) {
  const payload: SessionPayload = {
    userId,
    ...(credentialVersion ? { credentialVersion } : {}),
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };

  const serializedPayload = JSON.stringify(payload);
  const encodedPayload = base64UrlEncode(serializedPayload);

  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/** A link session remains limited to the analyst role and its live grant. */
export function createApprovalAccessSessionToken(userId: number, credentialVersion: string, grantId: string) {
  if (!approvalGrantIdPattern.test(grantId)) throw new Error("Invalid approval access grant");
  const payload: SessionPayload = { userId, credentialVersion, approvalAccessGrantId: grantId,
    exp: Math.floor(Date.now() / 1000) + APPROVAL_ACCESS_SESSION_MAX_AGE_SECONDS };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return encoded + "." + sign(encoded);
}

export function createApprovalAccessToken(userId: number, grantId: string) {
  if (!Number.isSafeInteger(userId) || userId < 1 || userId > 2_147_483_647 || !approvalGrantIdPattern.test(grantId)) {
    throw new Error("Invalid approval access grant");
  }
  const payload = "v1." + userId + "." + grantId;
  return payload + "." + sign("approval-access:" + payload);
}

export function verifyApprovalAccessToken(value: unknown) {
  if (typeof value !== "string" || value.length > 160) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^[1-9]\d{0,9}$/.test(parts[1]) || !approvalGrantIdPattern.test(parts[2])) return null;
  const userId = Number(parts[1]);
  if (userId > 2_147_483_647) return null;
  const expected = createApprovalAccessToken(userId, parts[2]);
  const receivedBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) return null;
  return { userId, grantId: parts[2] };
}

export function createSellerSessionToken(payload: {
  accesoSedeId?: number;
  sedeId: number;
  userId: number;
  vendedorId: number;
}) {
  const sellerPayload: SellerSessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };

  const serializedPayload = JSON.stringify(sellerPayload);
  const encodedPayload = base64UrlEncode(serializedPayload);

  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifySessionToken(token?: string | null) {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = sign(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SessionPayload;

    if (!payload?.userId || !payload?.exp) {
      return null;
    }

    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    if ("approvalAccessGrantId" in payload && (typeof payload.approvalAccessGrantId !== "string" || !approvalGrantIdPattern.test(payload.approvalAccessGrantId) || !payload.credentialVersion)) return null;

    return payload;
  } catch {
    return null;
  }
}

export function verifySellerSessionToken(token?: string | null) {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = sign(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SellerSessionPayload;

    if (!payload?.userId || !payload?.vendedorId || !payload?.sedeId || !payload?.exp) {
      return null;
    }

    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export const APPROVAL_SHARED_COOKIE_NAME = "approval_shared_session";
export const APPROVAL_SHARED_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
export function createApprovalSharedToken(grantId: string) {
  if (!approvalGrantIdPattern.test(grantId)) throw new Error("Invalid shared grant");
  const payload = "shared-v1." + grantId;
  return payload + "." + sign("approval-shared-link:" + payload);
}
export function verifyApprovalSharedToken(value: unknown) {
  if (typeof value !== "string" || value.length > 160) return null;
  const [version, grantId, signature, extra] = value.split(".");
  if (version !== "shared-v1" || !approvalGrantIdPattern.test(grantId || "") || !signature || extra !== undefined) return null;
  const expected = Buffer.from(createApprovalSharedToken(grantId));
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received) ? { grantId } : null;
}
export function createApprovalSharedSessionToken(grantId: string, sessionId: string, expiresAt: Date) {
  if (!approvalGrantIdPattern.test(grantId) || !approvalGrantIdPattern.test(sessionId)) throw new Error("Invalid shared session");
  const encoded = base64UrlEncode(JSON.stringify({ purpose: "approval-shared-session", grantId, sessionId, exp: Math.floor(expiresAt.getTime()/1000) }));
  return encoded + "." + sign("approval-shared-session:" + encoded);
}
export function verifyApprovalSharedSessionToken(value: unknown) {
  if (typeof value !== "string" || value.length > 1024) return null;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign("approval-shared-session:" + encoded));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(encoded));
    if (payload.purpose !== "approval-shared-session" || !approvalGrantIdPattern.test(payload.grantId)
      || !approvalGrantIdPattern.test(payload.sessionId) || !Number.isSafeInteger(payload.exp)
      || payload.exp <= Math.floor(Date.now()/1000)) return null;
    return { grantId: payload.grantId as string, sessionId: payload.sessionId as string, exp: payload.exp as number };
  } catch { return null; }
}
