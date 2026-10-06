import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { assertMoraActor, type MoraActor } from "@/lib/analyst-mora-access";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { ensureMoraExceptionRequestSchema } from "@/lib/mora-exception-schema";
import { MORA_COOLDOWN_BYPASS_PERMISSION } from "@/lib/mora-exception-requests";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type PermissionMutation = { userId: number; active: boolean; reason: string; idempotencyKey: string };
type PermissionItem = { userId: number; nombre: string; active: boolean; reason: string | null; grantedByName: string | null; updatedAt: Date | string | null };
type PermissionEvent = { id: string; userId: number; permissionKey: string; active: boolean; reason: string; actorUserId: number; actorName: string; createdAt: Date | string; requestHash?: string };

function dto(item: PermissionItem) {
  return { ...item, updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : null };
}
function eventDto(item: PermissionEvent) {
  const { requestHash: _hash, ...event } = item;
  void _hash;
  return { ...event, createdAt: new Date(item.createdAt).toISOString() };
}

export function parseMoraPermissionMutation(value: unknown): PermissionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CreditApprovalError("INVALID_PERMISSION", "Permiso inválido.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["userId","active","reason","idempotencyKey"].includes(key)) ||
    typeof body.active !== "boolean" || !Number.isSafeInteger(body.userId) || Number(body.userId) < 1 ||
    !uuid.test(String(body.idempotencyKey || ""))) throw new CreditApprovalError("INVALID_PERMISSION", "Permiso inválido.");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10 || reason.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason))
    throw new CreditApprovalError("INVALID_PERMISSION", "Explica el cambio de permiso (10 a 1000 caracteres).");
  return { userId: Number(body.userId), active: body.active, reason, idempotencyKey: String(body.idempotencyKey) };
}

const itemSql = `SELECT u."id" AS "userId",u."nombre",COALESCE(permission."active",FALSE) AS active,
  permission."reason",permission."grantedByName",permission."updatedAt" FROM "Usuario" u JOIN "Rol" role ON role."id"=u."rolId"
  JOIN "Sede" site ON site."id"=u."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
  LEFT JOIN "CreditMoraSpecialPermission" permission ON permission."userId"=u."id"
    AND permission."permissionKey"='MORA_COOLDOWN_BYPASS'
  WHERE u."activo"=TRUE AND site."activa"=TRUE AND ally."activo"=TRUE
    AND UPPER(BTRIM(role."nombre"))='ADMIN' AND UPPER(BTRIM(ally."codigo"))='FINSERPAY'`;

export async function listMoraExceptionPermissions(actor: MoraActor) {
  await ensureMoraExceptionRequestSchema();
  return prisma.$transaction(async db => {
    await assertMoraActor(db, actor, true);
    const [items, history] = await Promise.all([
      db.$queryRawUnsafe<PermissionItem[]>(itemSql + ` ORDER BY u."nombre",u."id"`),
      db.$queryRawUnsafe<PermissionEvent[]>(`SELECT "id"::text,"userId","permissionKey","active","reason",
        "actorUserId","actorName","createdAt" FROM "CreditMoraPermissionEvent" ORDER BY "createdAt" DESC,"id" DESC LIMIT 100`),
    ]);
    const normalized = items.map(dto);
    return {
      users: normalized.map(item => ({ id: item.userId, nombre: item.nombre })),
      grants: normalized.filter(item => item.updatedAt !== null).map(({ userId, active, reason, grantedByName, updatedAt }) => ({ userId, active, reason, grantedByName, updatedAt })),
      history: history.map(eventDto),
    };
  }, { isolationLevel: "RepeatableRead" });
}

export async function changeMoraExceptionPermission(input: PermissionMutation, actor: MoraActor) {
  await ensureMoraExceptionRequestSchema();
  const requestHash = createHash("sha256").update(JSON.stringify({ input, actorId: actor.id })).digest("hex");
  return prisma.$transaction(async db => {
    const verified = await assertMoraActor(db, actor, true);
    const prior = await db.$queryRawUnsafe<PermissionEvent[]>(`SELECT * FROM "CreditMoraPermissionEvent" WHERE "idempotencyKey"=$1::uuid`, input.idempotencyKey);
    if (prior[0]) {
      if (prior[0].requestHash !== requestHash) throw new CreditApprovalError("IDEMPOTENCY_CONFLICT", "La petición ya corresponde a otro permiso.", 409);
      const items = await db.$queryRawUnsafe<PermissionItem[]>(itemSql + ` AND u."id"=$1`, input.userId);
      return { item: dto(items[0]), unchanged: true };
    }
    const target = await assertMoraActor(db, { id: input.userId, nombre: "", centralAdmin: true }, true);
    await db.$queryRawUnsafe(`SELECT "id" FROM "Usuario" WHERE "id"=$1 FOR UPDATE`, input.userId);
    const active = input.active;
    await db.$queryRawUnsafe(`INSERT INTO "CreditMoraSpecialPermission"
      ("userId","permissionKey","active","reason","grantedByUserId","grantedByName","createdAt","updatedAt")
      VALUES ($1,'MORA_COOLDOWN_BYPASS',$2,$3,$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT ("userId","permissionKey") DO UPDATE SET "active"=EXCLUDED."active","reason"=EXCLUDED."reason",
        "grantedByUserId"=EXCLUDED."grantedByUserId","grantedByName"=EXCLUDED."grantedByName","updatedAt"=CURRENT_TIMESTAMP`,
    target.id,active,input.reason,verified.id,verified.nombre);
    await db.$queryRawUnsafe(`INSERT INTO "CreditMoraPermissionEvent"
      ("id","userId","permissionKey","active","reason","actorUserId","actorName","idempotencyKey","requestHash")
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid,$9)`,
    randomUUID(),target.id,MORA_COOLDOWN_BYPASS_PERMISSION,active,input.reason,verified.id,verified.nombre,input.idempotencyKey,requestHash);
    const items = await db.$queryRawUnsafe<PermissionItem[]>(itemSql + ` AND u."id"=$1`, target.id);
    return { item: dto(items[0]), unchanged: false };
  }, { isolationLevel: "ReadCommitted" });
}
