import "server-only";
import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import { APPROVAL_SHARED_COOKIE_NAME, verifyApprovalSharedSessionToken } from "@/lib/session";
import type { ApprovalActor } from "@/lib/credit-approval-actor";

export async function getApprovalSharedRequestActor(): Promise<Extract<ApprovalActor, {kind: "SHARED_LINK"}> | null | undefined> {
  const token = (await cookies()).get(APPROVAL_SHARED_COOKIE_NAME)?.value;
  if (!token) return undefined;
  const session = verifyApprovalSharedSessionToken(token);
  if (!session) return null;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT session."id"::text
    FROM "CreditApprovalSharedSession" session JOIN "CreditApprovalSharedGrant" access_grant ON access_grant."id"=session."grantId"
    WHERE session."id"=$1::uuid AND session."grantId"=$2::uuid AND session."revokedAt" IS NULL
      AND session."expiresAt">CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AND access_grant."revokedAt" IS NULL AND access_grant."scope"='CREDIT_APPROVAL'`,
    session.sessionId, session.grantId);
  if (!rows.length) return null;
  return { kind: "SHARED_LINK", id: null, nombre: "Acceso compartido", grantId: session.grantId, sessionId: session.sessionId };
}
export async function getApprovalSharedSession() { return (await getApprovalSharedRequestActor()) ?? null; }
