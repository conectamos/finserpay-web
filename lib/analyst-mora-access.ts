import "server-only";
import type { Prisma } from "@/app/generated/prisma/client";
import { getNominalApprovalAnalystSessionUser, getSessionUser } from "@/lib/auth";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { canManageApprovalAnalysts } from "@/lib/roles";
import { CreditApprovalError } from "@/lib/credit-approval-errors";

export type MoraActor = { id: number; nombre: string; centralAdmin: boolean };

export async function getMoraActor(): Promise<MoraActor> {
  if ((await getApprovalSharedRequestActor()) !== undefined) throw new CreditApprovalError("FORBIDDEN", "Ingresa con tu cuenta personal para gestionar mora.", 403);
  const admin = await getSessionUser();
  if (admin && canManageApprovalAnalysts(admin)) return { id: admin.id, nombre: admin.nombre, centralAdmin: true };
  const analyst = await getNominalApprovalAnalystSessionUser();
  if (analyst) return { id: analyst.id, nombre: analyst.nombre, centralAdmin: false };
  throw new CreditApprovalError("FORBIDDEN", "No tienes permiso para gestionar mora.", 403);
}

/** Revalidates the database identity inside the transaction before a mutation. */
export async function assertMoraActor(db: Pick<Prisma.TransactionClient, "$queryRawUnsafe">, actor: MoraActor, centralOnly = false) {
  const rows = await db.$queryRawUnsafe<Array<{ nombre: string; role: string }>>(
    `SELECT u."nombre", UPPER(BTRIM(r."nombre")) AS role FROM "Usuario" u JOIN "Rol" r ON r."id"=u."rolId"
      JOIN "Sede" s ON s."id"=u."sedeId" JOIN "Aliado" a ON a."id"=s."aliadoId"
      WHERE u."id"=$1 AND u."activo"=TRUE AND s."activa"=TRUE AND a."activo"=TRUE
        AND UPPER(BTRIM(a."codigo"))='FINSERPAY'
        AND UPPER(BTRIM(r."nombre")) IN ('ADMIN','ANALISTA_APROBACION') FOR SHARE OF u,s,a`, actor.id);
  const row = rows[0];
  if (!row || (centralOnly && row.role !== "ADMIN") || (actor.centralAdmin && row.role !== "ADMIN"))
    throw new CreditApprovalError("FORBIDDEN", "Tu cuenta ya no tiene permiso para esta gestión.", 403);
  return { ...actor, nombre: row.nombre, centralAdmin: row.role === "ADMIN" };
}
