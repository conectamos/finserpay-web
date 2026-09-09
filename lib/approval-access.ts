import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { CreditApprovalError } from "@/lib/credit-approval";
import { createApprovalAccessToken, getSessionCredentialVersion, verifyApprovalAccessToken } from "@/lib/session";
import { isApprovalAnalystRole } from "@/lib/roles";

type Database = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type Account = {
  id: number; activo: boolean; nombre: string; claveHash: string; updatedAt: Date;
  rolNombre: string; aliadoCodigo: string; sedeActiva: boolean; aliadoActivo: boolean;
};
type Link = { id: string; userId: number; credentialVersion: string; createdAt: Date; revokedAt: Date | null };
const grantPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseApprovalLinkMutation(value: unknown, revoking = false) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "expectedGrantId") {
    throw new CreditApprovalError("INVALID_LINK_REQUEST", "Actualiza la lista de analistas antes de continuar.");
  }
  const id = (value as { expectedGrantId: unknown }).expectedGrantId;
  if ((id !== null && (typeof id !== "string" || !grantPattern.test(id))) || (revoking && id === null)) {
    throw new CreditApprovalError("INVALID_LINK_REQUEST", "Selecciona un enlace válido.");
  }
  return id as string | null;
}

async function readAccount(db: Database, userId: number, lock = false) {
  const rows = await db.$queryRawUnsafe<Account[]>(`SELECT account."id", account."nombre", account."activo",
      account."claveHash", account."updatedAt", role."nombre" AS "rolNombre",
      ally."codigo" AS "aliadoCodigo", site."activa" AS "sedeActiva", ally."activo" AS "aliadoActivo"
    FROM "Usuario" account JOIN "Rol" role ON role."id" = account."rolId"
    JOIN "Sede" site ON site."id" = account."sedeId" JOIN "Aliado" ally ON ally."id" = site."aliadoId"
    WHERE account."id" = $1${lock ? " FOR UPDATE OF account" : ""}`, userId);
  return rows[0] || null;
}
async function readLink(db: Database, userId: number) {
  const rows = await db.$queryRawUnsafe<Link[]>(`SELECT "id"::text, "userId", "credentialVersion", "createdAt", "revokedAt"
    FROM "CreditApprovalAccessLink" WHERE "userId" = $1`, userId);
  return rows[0] || null;
}
function centralAnalyst(account: Account | null) {
  return Boolean(account && isApprovalAnalystRole(account.rolNombre) && account.aliadoCodigo?.trim().toUpperCase() === "FINSERPAY");
}
function activeAccount(account: Account | null) {
  return Boolean(centralAnalyst(account) && account?.activo && account.sedeActiva && account.aliadoActivo);
}
function activeLink(account: Account, link: Link | null) {
  return Boolean(activeAccount(account) && link && !link.revokedAt && link.credentialVersion === getSessionCredentialVersion(account.claveHash, account.updatedAt));
}

/** Host is supplied by the same-origin admin request; production has a canonical fallback. */
export function approvalAccessOrigin(request: Request) {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (configured) {
    const url = new URL(configured);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid public URL");
    return url.origin;
  }
  if (process.env.NODE_ENV === "production") return "https://finserpay.com";
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host") || requestUrl.host;
  if (/[\s,/@\\?#%]/.test(host)) throw new Error("Invalid request authority");
  return new URL(`${requestUrl.protocol}//${host}`).origin;
}

function serialize(account: Account, link: Link | null, origin: string) {
  const active = activeLink(account, link);
  return { ok: true, active, hasLink: Boolean(link), grantId: link?.id || null,
    createdAt: link ? new Date(link.createdAt).toISOString() : null,
    accessUrl: active && link ? `${origin}/acceso-aprobaciones#acceso=${encodeURIComponent(createApprovalAccessToken(account.id, link.id))}` : null };
}

export async function getApprovalAccessLink(db: Database, userId: number, origin: string) {
  const account = await readAccount(db, userId);
  if (!account || !centralAnalyst(account)) throw new CreditApprovalError("ANALYST_NOT_FOUND", "Analista no encontrado.", 404);
  return serialize(account, await readLink(db, userId), origin);
}

/** Call in a transaction. Serializing by account also protects two first-time issuers. */
export async function changeApprovalAccessLink(db: Database, userId: number, actorId: number, expectedGrantId: string | null, origin: string, revoke = false) {
  const account = await readAccount(db, userId, true);
  if (!account || !centralAnalyst(account)) throw new CreditApprovalError("ANALYST_NOT_FOUND", "Analista no encontrado.", 404);
  if (!revoke && !activeAccount(account)) throw new CreditApprovalError("ANALYST_INACTIVE", "Activa la cuenta y su sede central antes de generar el enlace.", 409);
  const previous = await readLink(db, userId);
  if ((previous?.id || null) !== expectedGrantId) throw new CreditApprovalError("LINK_CHANGED", "El enlace cambió. Actualiza la lista antes de continuar.", 409);
  if (revoke) {
    if (!previous) throw new CreditApprovalError("LINK_NOT_FOUND", "No hay un enlace para revocar.", 404);
    await db.$executeRawUnsafe(`UPDATE "CreditApprovalAccessLink" SET "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "userId" = $1`, userId);
  } else {
    await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalAccessLink" ("userId", "id", "credentialVersion", "issuedByUserId", "createdAt")
      VALUES ($1, $2::uuid, $3, $4, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      ON CONFLICT ("userId") DO UPDATE SET "id" = EXCLUDED."id", "credentialVersion" = EXCLUDED."credentialVersion",
        "issuedByUserId" = EXCLUDED."issuedByUserId", "createdAt" = EXCLUDED."createdAt", "revokedAt" = NULL`,
      userId, randomUUID(), getSessionCredentialVersion(account.claveHash, account.updatedAt), actorId);
  }
  return serialize(account, await readLink(db, userId), origin);
}

export async function exchangeApprovalAccess(db: Database, value: unknown) {
  const token = verifyApprovalAccessToken(value);
  if (!token) throw new CreditApprovalError("INVALID_ACCESS_LINK", "El enlace no es válido o fue revocado. Solicita uno vigente al administrador.", 401);
  const account = await readAccount(db, token.userId);
  const link = account ? await readLink(db, token.userId) : null;
  if (!account || !link || link.id !== token.grantId || !activeLink(account, link)) {
    throw new CreditApprovalError("INVALID_ACCESS_LINK", "El enlace no es válido o fue revocado. Solicita uno vigente al administrador.", 401);
  }
  return { userId: account.id, credentialVersion: link.credentialVersion, grantId: link.id };
}
