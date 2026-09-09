import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { createApprovalSharedToken, verifyApprovalSharedToken, APPROVAL_SHARED_SESSION_MAX_AGE_SECONDS } from "@/lib/session";

type Database = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type Grant = { id: string; createdAt: Date; revokedAt: Date | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseSharedGrantMutation(value: unknown, revoke = false) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "expectedGrantId") throw new CreditApprovalError("INVALID_LINK_REQUEST", "Actualiza el estado del enlace.");
  const expected = (value as { expectedGrantId: unknown }).expectedGrantId;
  if ((expected !== null && (typeof expected !== "string" || !uuid.test(expected))) || (revoke && expected === null)) throw new CreditApprovalError("INVALID_LINK_REQUEST", "Selecciona un enlace vigente.");
  return expected as string | null;
}
async function latest(db: Database) {
  return (await db.$queryRawUnsafe<Grant[]>(`SELECT "id"::text,"createdAt","revokedAt" FROM "CreditApprovalSharedGrant"
    WHERE "scope"='CREDIT_APPROVAL' ORDER BY CASE WHEN "revokedAt" IS NULL THEN 0 ELSE 1 END,"generation" DESC LIMIT 1`))[0] || null;
}
function serialize(grant: Grant | null, origin: string) {
  const active = Boolean(grant && !grant.revokedAt);
  return { ok: true, active, hasLink: Boolean(grant), grantId: grant?.id || null,
    createdAt: grant ? new Date(grant.createdAt).toISOString() : null,
    accessUrl: active && grant ? origin + "/acceso-revision#acceso=" + encodeURIComponent(createApprovalSharedToken(grant.id)) : null };
}
export async function getSharedApprovalLink(db: Database, origin: string) { return serialize(await latest(db), origin); }
/** An advisory lock serializes first issuance, rotation and revocation without an account row. */
export async function changeSharedApprovalLink(db: Database, actorId: number, expected: string | null, origin: string, revoke = false) {
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('finserpay-shared-approval-grant'))");
  const previous = await latest(db);
  if ((previous?.id || null) !== expected) throw new CreditApprovalError("LINK_CHANGED", "El enlace cambió. Consulta su estado antes de continuar.", 409);
  if (revoke && !previous) throw new CreditApprovalError("LINK_NOT_FOUND", "No hay un enlace para revocar.", 404);
  if (previous && !previous.revokedAt) await db.$executeRawUnsafe(`UPDATE "CreditApprovalSharedGrant"
    SET "revokedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',"revokedByUserId"=$2 WHERE "id"=$1::uuid AND "revokedAt" IS NULL`, previous.id, actorId);
  if (!revoke) await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalSharedGrant" ("id","scope","issuedByUserId") VALUES ($1::uuid,'CREDIT_APPROVAL',$2)`, randomUUID(), actorId);
  return getSharedApprovalLink(db, origin);
}
export async function exchangeSharedApprovalLink(db: Database, value: unknown) {
  const token = verifyApprovalSharedToken(value);
  if (!token) throw new CreditApprovalError("INVALID_ACCESS_LINK", "El enlace no es válido o fue revocado.", 401);
  const grants = await db.$queryRawUnsafe<Grant[]>(`SELECT "id"::text,"createdAt","revokedAt" FROM "CreditApprovalSharedGrant"
    WHERE "id"=$1::uuid AND "scope"='CREDIT_APPROVAL' AND "revokedAt" IS NULL FOR SHARE`, token.grantId);
  if (!grants.length) throw new CreditApprovalError("INVALID_ACCESS_LINK", "El enlace no es válido o fue revocado.", 401);
  const sessionId = randomUUID();
  const sessions = await db.$queryRawUnsafe<Array<{ expiresAt: Date }>>(`INSERT INTO "CreditApprovalSharedSession" ("id","grantId","expiresAt")
    VALUES ($1::uuid,$2::uuid,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+($3*INTERVAL '1 second')) RETURNING "expiresAt"`, sessionId, token.grantId, APPROVAL_SHARED_SESSION_MAX_AGE_SECONDS);
  return { grantId: token.grantId, sessionId, expiresAt: new Date(sessions[0].expiresAt) };
}
export async function revokeSharedApprovalSession(db: Database, grantId: string, sessionId: string) {
  await db.$executeRawUnsafe(`UPDATE "CreditApprovalSharedSession" SET "revokedAt"=COALESCE("revokedAt",CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "id"=$1::uuid AND "grantId"=$2::uuid`, sessionId, grantId);
}
