import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import prisma from "@/lib/prisma";
import { getSessionCookieOptions } from "@/lib/session";

export const DEFAULT_FINANCIAL_PANEL_PASSWORD = "Adm1995";
export const FINANCIAL_ACCESS_COOKIE_NAME = "financial_access";
const FINANCIAL_ACCESS_MAX_AGE_SECONDS = 60 * 60 * 12;

type FinancialAccessPayload = {
  exp: number;
  sedeId: number;
  sedeUpdatedAt: string;
  userId: number;
};

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;
type FinancialSedeRecord = {
  id: number;
  nombre: string;
  updatedAt: Date;
  clavePanelFinancieroHash: string | null;
};
type FinancialSedeListRecord = {
  id: number;
  nombre: string;
  clavePanelFinancieroHash: string | null;
};

function getFinancialAccessSecret() {
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
  return createHmac("sha256", getFinancialAccessSecret())
    .update(value)
    .digest("base64url");
}

export function createFinancialAccessToken(
  userId: number,
  sedeId: number,
  sedeUpdatedAt: string
) {
  const payload: FinancialAccessPayload = {
    userId,
    sedeId,
    sedeUpdatedAt,
    exp: Math.floor(Date.now() / 1000) + FINANCIAL_ACCESS_MAX_AGE_SECONDS,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  return `${encodedPayload}.${sign(encodedPayload)}`;
}

function verifyFinancialAccessToken(token?: string | null) {
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
    const payload = JSON.parse(
      base64UrlDecode(encodedPayload)
    ) as FinancialAccessPayload;

    if (!payload?.userId || !payload?.sedeId || !payload?.sedeUpdatedAt || !payload?.exp) {
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

export function getFinancialAccessCookieOptions() {
  return {
    ...getSessionCookieOptions(),
    maxAge: FINANCIAL_ACCESS_MAX_AGE_SECONDS,
  };
}

export function clearFinancialAccessCookie(response: NextResponse) {
  response.cookies.set(FINANCIAL_ACCESS_COOKIE_NAME, "", {
    ...getFinancialAccessCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });
}

export async function getFinancialSedeById(sedeId: number) {
  const rows = await prisma.$queryRaw<FinancialSedeRecord[]>`
    SELECT
      id,
      nombre,
      "updatedAt",
      "clavePanelFinancieroHash"
    FROM "Sede"
    WHERE id = ${sedeId}
    LIMIT 1
  `;

  return rows[0] ?? null;
}

export async function listFinancialSedes() {
  return prisma.$queryRaw<FinancialSedeListRecord[]>`
    SELECT
      id,
      nombre,
      "clavePanelFinancieroHash"
    FROM "Sede"
    ORDER BY id ASC
  `;
}

export async function updateFinancialSedePassword(
  sedeId: number,
  claveHash: string
) {
  const rows = await prisma.$queryRaw<{ id: number; nombre: string }[]>`
    UPDATE "Sede"
    SET
      "clavePanelFinancieroHash" = ${claveHash},
      "updatedAt" = NOW()
    WHERE id = ${sedeId}
    RETURNING id, nombre
  `;

  return rows[0] ?? null;
}

export async function getFinancialAccessState() {
  const user = await getSessionUser();

  if (!user) {
    return {
      authorized: false,
      esAdmin: false,
      sede: null,
      user: null,
    };
  }

  const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";

  if (esAdmin) {
    return {
      authorized: true,
      esAdmin: true,
      sede: null,
      user,
    };
  }

  const sede = await getFinancialSedeById(user.sedeId);

  if (!sede) {
    return {
      authorized: false,
      esAdmin: false,
      sede: null,
      user,
    };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(FINANCIAL_ACCESS_COOKIE_NAME)?.value;
  const payload = verifyFinancialAccessToken(token);
  const updatedAt = sede.updatedAt.toISOString();

  const authorized = Boolean(
    payload &&
      payload.userId === user.id &&
      payload.sedeId === sede.id &&
      payload.sedeUpdatedAt === updatedAt
  );

  return {
    authorized,
    esAdmin: false,
    sede: {
      id: sede.id,
      nombre: sede.nombre,
      updatedAt,
      usaClavePredeterminada: !sede.clavePanelFinancieroHash,
    },
    user,
  };
}

export async function requireFinancialAccess():
  Promise<
    | {
        ok: false;
        response: NextResponse;
      }
    | {
        ok: true;
        esAdmin: boolean;
        sedeId: number;
        user: SessionUser;
      }
  > {
  const state = await getFinancialAccessState();

  if (!state.user) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      ),
    };
  }

  if (!state.authorized) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Debes ingresar la clave del panel financiero" },
        { status: 403 }
      ),
    };
  }

  return {
    ok: true,
    esAdmin: state.esAdmin,
    sedeId: state.user.sedeId,
    user: state.user,
  };
}

export async function verifyFinancialPasswordForSede(
  sedeId: number,
  clave: string
) {
  const sede = await getFinancialSedeById(sedeId);

  if (!sede) {
    return null;
  }

  const isValid = verifyPassword(
    clave,
    sede.clavePanelFinancieroHash || DEFAULT_FINANCIAL_PANEL_PASSWORD
  );

  return {
    isValid,
    sede,
  };
}

export function hashFinancialPanelPassword(clave: string) {
  return hashPassword(clave);
}
