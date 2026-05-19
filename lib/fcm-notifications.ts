import { createSign } from "node:crypto";
import prisma from "@/lib/prisma";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

let fcmDeviceTokenTableReady = false;
let accessTokenCache: { token: string; expiresAt: number } | null = null;

export type FcmDeviceTokenRow = {
  id: number;
  token: string;
  clienteDocumento: string;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  creditoId: number | null;
  deviceUid: string | null;
  platform: string;
  appVersion: string | null;
  active: boolean;
  lastSeenAt: Date | string;
  lastError: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type FirebaseServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

type RegisterFcmTokenInput = {
  appVersion?: string | null;
  documento: string;
  platform?: string | null;
  token: string;
  userAgent?: string | null;
};

export type FcmMessagePayload = {
  body: string;
  data?: Record<string, string | number | boolean | null | undefined>;
  title: string;
};

export type FcmSendResult = {
  ok: boolean;
  error: string | null;
  providerMessageId: string | null;
  status: number | null;
};

function normalizeDocument(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 40);
}

function sanitizeText(value: unknown, maxLength: number) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizePlatform(value: unknown) {
  const normalized = String(value ?? "ANDROID").trim().toUpperCase();
  return normalized.replace(/[^A-Z0-9_-]/g, "").slice(0, 30) || "ANDROID";
}

function base64Url(input: string | Buffer) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizePrivateKey(value: string | undefined) {
  return String(value || "").replace(/\\n/g, "\n").trim();
}

function getServiceAccount(): FirebaseServiceAccount {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();

  if (raw) {
    try {
      return JSON.parse(raw) as FirebaseServiceAccount;
    } catch {
      return {};
    }
  }

  return {
    project_id:
      process.env.FIREBASE_PROJECT_ID || process.env.FCM_PROJECT_ID || undefined,
    client_email:
      process.env.FIREBASE_CLIENT_EMAIL ||
      process.env.FCM_CLIENT_EMAIL ||
      undefined,
    private_key:
      process.env.FIREBASE_PRIVATE_KEY || process.env.FCM_PRIVATE_KEY || undefined,
  };
}

function getFcmConfig() {
  const serviceAccount = getServiceAccount();
  const projectId = sanitizeText(serviceAccount.project_id, 120);
  const clientEmail = sanitizeText(serviceAccount.client_email, 240);
  const privateKey = normalizePrivateKey(serviceAccount.private_key);

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  return { clientEmail, privateKey, projectId };
}

export function isFcmConfigured() {
  return Boolean(getFcmConfig());
}

export async function ensureFcmDeviceTokenTable() {
  if (fcmDeviceTokenTableReady) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FcmDeviceToken" (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      "clienteDocumento" TEXT NOT NULL,
      "clienteNombre" TEXT,
      "clienteTelefono" TEXT,
      "creditoId" INTEGER,
      "deviceUid" TEXT,
      platform TEXT NOT NULL DEFAULT 'ANDROID',
      "appVersion" TEXT,
      "userAgent" TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastError" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "FcmDeviceToken_clienteDocumento_idx"
    ON "FcmDeviceToken" ("clienteDocumento", active)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "FcmDeviceToken_creditoId_idx"
    ON "FcmDeviceToken" ("creditoId")
  `);

  fcmDeviceTokenTableReady = true;
}

function tokenToJson(row: FcmDeviceTokenRow) {
  return {
    ...row,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    lastSeenAt:
      row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : row.lastSeenAt,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

export async function registerFcmToken(input: RegisterFcmTokenInput) {
  await ensureFcmDeviceTokenTable();

  const token = sanitizeText(input.token, 4096);
  const documento = normalizeDocument(input.documento);

  if (!token || token.length < 20) {
    throw new Error("Token FCM invalido");
  }

  if (!documento || documento.length < 5) {
    throw new Error("Cedula invalida");
  }

  const credit = await prisma.credito.findFirst({
    where: {
      clienteDocumento: documento,
      estado: {
        not: "ANULADO",
      },
    },
    select: {
      id: true,
      clienteNombre: true,
      clienteTelefono: true,
      deviceUid: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const rows = await prisma.$queryRawUnsafe<FcmDeviceTokenRow[]>(
    `INSERT INTO "FcmDeviceToken"
      (token, "clienteDocumento", "clienteNombre", "clienteTelefono", "creditoId", "deviceUid",
       platform, "appVersion", "userAgent", active, "lastSeenAt", "lastError", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW(), NULL, NOW())
     ON CONFLICT (token) DO UPDATE SET
       "clienteDocumento" = EXCLUDED."clienteDocumento",
       "clienteNombre" = EXCLUDED."clienteNombre",
       "clienteTelefono" = EXCLUDED."clienteTelefono",
       "creditoId" = EXCLUDED."creditoId",
       "deviceUid" = EXCLUDED."deviceUid",
       platform = EXCLUDED.platform,
       "appVersion" = EXCLUDED."appVersion",
       "userAgent" = EXCLUDED."userAgent",
       active = TRUE,
       "lastSeenAt" = NOW(),
       "lastError" = NULL,
       "updatedAt" = NOW()
     RETURNING id, token, "clienteDocumento", "clienteNombre", "clienteTelefono",
       "creditoId", "deviceUid", platform, "appVersion", active, "lastSeenAt",
       "lastError", "createdAt", "updatedAt"`,
    token,
    documento,
    credit?.clienteNombre || null,
    credit?.clienteTelefono || null,
    credit?.id || null,
    credit?.deviceUid || null,
    normalizePlatform(input.platform),
    sanitizeText(input.appVersion, 80),
    sanitizeText(input.userAgent, 500)
  );

  return tokenToJson(rows[0]);
}

export async function listFcmTokensForDocument(documento: string) {
  await ensureFcmDeviceTokenTable();
  const normalized = normalizeDocument(documento);

  if (!normalized) {
    return [];
  }

  const rows = await prisma.$queryRawUnsafe<FcmDeviceTokenRow[]>(
    `SELECT id, token, "clienteDocumento", "clienteNombre", "clienteTelefono",
       "creditoId", "deviceUid", platform, "appVersion", active, "lastSeenAt",
       "lastError", "createdAt", "updatedAt"
     FROM "FcmDeviceToken"
     WHERE "clienteDocumento" = $1 AND active = TRUE
     ORDER BY "lastSeenAt" DESC`,
    normalized
  );

  return rows;
}

async function getAccessToken() {
  const now = Date.now();
  if (accessTokenCache && accessTokenCache.expiresAt - 60_000 > now) {
    return accessTokenCache.token;
  }

  const config = getFcmConfig();
  if (!config) {
    throw new Error("Firebase Cloud Messaging no esta configurado");
  }

  const issuedAt = Math.floor(now / 1000);
  const assertionHeader = base64Url(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  );
  const assertionPayload = base64Url(
    JSON.stringify({
      aud: OAUTH_TOKEN_URL,
      exp: issuedAt + 3600,
      iat: issuedAt,
      iss: config.clientEmail,
      scope: FCM_SCOPE,
    })
  );
  const unsignedAssertion = `${assertionHeader}.${assertionPayload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsignedAssertion)
    .sign(config.privateKey);
  const assertion = `${unsignedAssertion}.${base64Url(signature)}`;
  const response = await fetch(OAUTH_TOKEN_URL, {
    body: new URLSearchParams({
      assertion,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    expires_in?: number;
  };

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || "No se pudo autenticar Firebase"
    );
  }

  accessTokenCache = {
    expiresAt: now + Number(data.expires_in || 3600) * 1000,
    token: data.access_token,
  };

  return data.access_token;
}

function normalizeData(data: FcmMessagePayload["data"]) {
  return Object.fromEntries(
    Object.entries(data || {})
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
}

export async function sendFcmNotification(
  token: string,
  payload: FcmMessagePayload
): Promise<FcmSendResult> {
  const config = getFcmConfig();
  if (!config) {
    return {
      error: "Firebase Cloud Messaging no esta configurado",
      ok: false,
      providerMessageId: null,
      status: null,
    };
  }

  try {
    const accessToken = await getAccessToken();
    const messageData = normalizeData({
      ...payload.data,
      body: payload.body,
      title: payload.title,
    });
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
        config.projectId
      )}/messages:send`,
      {
        body: JSON.stringify({
          message: {
            android: {
              priority: "HIGH",
            },
            data: messageData,
            token,
          },
        }),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; UTF-8",
        },
        method: "POST",
      }
    );
    const data = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; status?: string };
      name?: string;
    };

    if (!response.ok) {
      return {
        error: data.error?.message || data.error?.status || "FCM rechazo el envio",
        ok: false,
        providerMessageId: null,
        status: response.status,
      };
    }

    return {
      error: null,
      ok: true,
      providerMessageId: data.name || null,
      status: response.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "No se pudo enviar FCM",
      ok: false,
      providerMessageId: null,
      status: null,
    };
  }
}

export async function markFcmTokenSendResult(
  tokenId: number,
  result: FcmSendResult
) {
  await ensureFcmDeviceTokenTable();
  await prisma.$executeRawUnsafe(
    `UPDATE "FcmDeviceToken"
     SET "lastError" = $1, "updatedAt" = NOW()
     WHERE id = $2`,
    result.error,
    tokenId
  );
}
