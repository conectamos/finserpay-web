import "server-only";
import type { Prisma } from "@/app/generated/prisma/client";

export type ApprovalActor =
  | { kind?: "USER"; id: number; nombre: string }
  | { kind: "SHARED_LINK"; id: null; nombre: string; grantId: string; sessionId: string };
export class ApprovalActorAccessError extends Error {
  readonly code = "SHARED_ACCESS_REVOKED";
  readonly status = 401;
  constructor() { super("El acceso compartido venció o fue revocado. Solicita un enlace vigente."); }
}
export function approvalActorAudit(actor: ApprovalActor) {
  return actor.kind === "SHARED_LINK"
    ? { actorKind: "SHARED_LINK" as const, actorUserId: null, actorName: "Acceso compartido",
        actorGrantId: actor.grantId, actorSessionId: actor.sessionId }
    : { actorKind: "USER" as const, actorUserId: actor.id, actorName: actor.nombre,
        actorGrantId: null, actorSessionId: null };
}
/** Acquire before Credit/Review locks. Grant rotation or logout waits for this mutation. */
export async function assertApprovalActorActive(db: Pick<Prisma.TransactionClient, "$queryRawUnsafe">, actor: ApprovalActor) {
  if (actor.kind !== "SHARED_LINK") return;
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT session."id"::text
    FROM "CreditApprovalSharedGrant" access_grant JOIN "CreditApprovalSharedSession" session ON session."grantId"=access_grant."id"
    WHERE access_grant."id"=$1::uuid AND access_grant."scope"='CREDIT_APPROVAL' AND access_grant."revokedAt" IS NULL
      AND session."id"=$2::uuid AND session."revokedAt" IS NULL
      AND session."expiresAt">CURRENT_TIMESTAMP AT TIME ZONE 'UTC' FOR SHARE OF access_grant, session`, actor.grantId, actor.sessionId);
  if (!rows.length) throw new ApprovalActorAccessError();
}

export class ApprovalActorCreditAccessError extends Error {
  readonly code = "CREDIT_NOT_FOUND";
  readonly status = 404;
  constructor() { super("Crédito no encontrado."); }
}
export async function assertApprovalActorCreditAccess(db: Pick<Prisma.TransactionClient, "$queryRawUnsafe">, id: number, actor: ApprovalActor) {
  if (actor.kind !== "SHARED_LINK") return;
  const rows = await db.$queryRawUnsafe<Array<{ id: number }>>(`SELECT credit."id" FROM "Credito" credit
    JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    JOIN "CreditApprovalPolicy" policy ON policy."id"=1
    WHERE credit."id"=$1 AND credit."createdAt">=policy."activatedAt" AND UPPER(BTRIM(ally."codigo"))<>'FINSERPAY'
      AND UPPER(BTRIM(credit."estado")) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA')
      AND NOT (COALESCE(credit."equalityService",'')='IMPORTACION_MASIVA' AND COALESCE(credit."contratoSnapshot" #>> '{origen,tipo}','')='IMPORTACION_MASIVA')
      AND NOT EXISTS (SELECT 1 FROM "LiquidacionAliadoCredito" paid WHERE paid."creditoId"=credit."id")`, id);
  if (!rows.length) throw new ApprovalActorCreditAccessError();
}

/** Shared by the approved list and read access. This does not grant mutation rights. */
export function buildCurrentCreditApprovalSql(creditAlias: string, reviewAlias: string) {
  if (![creditAlias, reviewAlias].every(alias => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))) throw new Error("Invalid approval SQL alias");
  return `(${reviewAlias}."status"='APPROVED' AND ${reviewAlias}."revision">0
    AND ${reviewAlias}."approvedRevision"=${reviewAlias}."revision"
    AND ${reviewAlias}."approvedAt" IS NOT NULL AND LENGTH(BTRIM(${reviewAlias}."approvedByName"))>0
    AND ${reviewAlias}."reviewHash" ~ '^[a-f0-9]{64}$'
    AND ((${reviewAlias}."approvedByKind"='USER' AND ${reviewAlias}."approvedByUserId" IS NOT NULL
        AND ${reviewAlias}."approvedByGrantId" IS NULL AND ${reviewAlias}."approvedBySessionId" IS NULL)
      OR (${reviewAlias}."approvedByKind"='SHARED_LINK' AND ${reviewAlias}."approvedByUserId" IS NULL
        AND ${reviewAlias}."approvedByGrantId" IS NOT NULL AND ${reviewAlias}."approvedBySessionId" IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM "CreditApprovalNovelty" unresolved
      WHERE unresolved."creditoId"=${creditAlias}."id" AND unresolved."status" IS DISTINCT FROM 'RESOLVED')
    AND NOT EXISTS (SELECT 1 FROM "CreditApprovalReissue" signature_reissue
      WHERE signature_reissue."creditoId"=${creditAlias}."id"
        AND (signature_reissue."status" IS NULL OR signature_reissue."status" NOT IN ('COMPLETED','FAILED_SAFE'))))`;
}

/** Reads additionally admit a current approved credit after settlement; writes retain the original guard. */
export async function assertApprovalActorCreditReadAccess(db: Pick<Prisma.TransactionClient, "$queryRawUnsafe">, id: number, actor: ApprovalActor) {
  await assertApprovalActorActive(db, actor);
  if (actor.kind !== "SHARED_LINK") return;
  const rows = await db.$queryRawUnsafe<Array<{ id: number }>>(`SELECT credit."id" FROM "Credito" credit
    JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    JOIN "CreditApprovalPolicy" policy ON policy."id"=1
    LEFT JOIN "CreditApprovalReview" review ON review."creditoId"=credit."id"
    WHERE credit."id"=$1 AND credit."createdAt">=policy."activatedAt" AND UPPER(BTRIM(ally."codigo"))<>'FINSERPAY'
      AND UPPER(BTRIM(credit."estado")) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA')
      AND NOT (COALESCE(credit."equalityService",'')='IMPORTACION_MASIVA' AND COALESCE(credit."contratoSnapshot" #>> '{origen,tipo}','')='IMPORTACION_MASIVA')
      AND (NOT EXISTS (SELECT 1 FROM "LiquidacionAliadoCredito" paid WHERE paid."creditoId"=credit."id")
        OR ${buildCurrentCreditApprovalSql("credit", "review")})`, id);
  if (!rows.length) throw new ApprovalActorCreditAccessError();
}
