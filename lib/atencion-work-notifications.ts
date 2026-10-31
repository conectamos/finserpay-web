import "server-only";
import { AttentionError, attentionUuid } from "./atencion-core";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import { assertAttentionWorkCurrentActor, attentionWorkRecipientKey } from "./atencion-work-actor";
import type { AttentionWorkActor, AttentionWorkKind } from "./atencion-work-types";
import type { AttentionWorkNotificationKind, AttentionWorkNotifications } from "./atencion-work-notification-types";

/** Also used immediately before push delivery. This grants notification visibility, never case access. */
export function attentionWorkNotificationEligibleSql(alias="n") {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid SQL notification alias");
  return `EXISTS(SELECT 1 FROM "AttentionWorkRequest" nw
    JOIN "AttentionConversation" nc ON nc.id=nw."conversationId"
    WHERE nw.id=${alias}."workId" AND (
      EXISTS(SELECT 1 FROM "Usuario" nu JOIN "Rol" nr ON nr.id=nu."rolId"
        JOIN "Sede" ns ON ns.id=nu."sedeId" JOIN "Aliado" na ON na.id=ns."aliadoId"
        WHERE ${alias}."recipientKey"='user:'||nu.id AND nu.activo AND ns.activa AND na.activo
        AND upper(trim(na.codigo))='FINSERPAY' AND upper(trim(nr.nombre)) IN ('ADMIN','ANALISTA_APROBACION')
        AND (${alias}.kind='created' OR (nc."assigneeUserId"=nu.id
          AND nc."assigneeKey"='analyst:'||nu.id AND nc."assigneeSellerId" IS NULL)))
      OR EXISTS(SELECT 1 FROM "Vendedor" nv JOIN "Usuario" nu ON nu.id=nw."userId"
        JOIN "Sede" nus ON nus.id=nu."sedeId" JOIN "Aliado" nua ON nua.id=nus."aliadoId"
        JOIN "SedeVendedor" nsv ON nsv."vendedorId"=nv.id AND nsv."sedeId"=nw."sedeId"
        JOIN "Sede" ns ON ns.id=nsv."sedeId" JOIN "Aliado" na ON na.id=ns."aliadoId"
        WHERE ${alias}."recipientKey"='seller:'||nv.id AND nv.id=nw."sellerId" AND ${alias}.kind='reply'
        AND nv.activo AND NOT nv."debeCambiarPin" AND upper(nv."tipoPerfil") IN ('VENDEDOR','SUPERVISOR')
        AND nu.activo AND nus.activa AND nua.activo AND nsv.activo AND ns.activa AND na.activo
        AND na.id=nw."aliadoId" AND EXISTS(SELECT 1 FROM (
          SELECT 'D' AS source,id,"vendedorId","sedeId" FROM "CreditoBorrador"
          UNION ALL SELECT 'C',id,"vendedorId","sedeId" FROM "Credito"
        ) no JOIN "Sede" nos ON nos.id=no."sedeId"
          WHERE no.source=nw."targetSource" AND no.id=nw."targetId" AND no."vendedorId"=nv.id
          AND nos.activa AND nos."aliadoId"=nw."aliadoId"))
    ))`;
}

type WorkNotificationContext = {id:string;conversationId:string;kind:AttentionWorkKind};
/** Called only within the work transaction, after its idempotency ledger accepted a new event. */
export async function notifyAttentionWork(db: AttentionDb, actor: AttentionWorkActor,
  work: WorkNotificationContext, eventKey:string, kind:AttentionWorkNotificationKind) {
  let recipients:string[];
  if (kind === "created") {
    const rows=await db.$queryRawUnsafe<{key:string}[]>(`SELECT 'user:'||u.id AS key FROM "Usuario" u
      JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
      WHERE u.activo AND s.activa AND a.activo AND upper(trim(a.codigo))='FINSERPAY'
      AND upper(trim(r.nombre)) IN ('ADMIN','ANALISTA_APROBACION')`);
    recipients=rows.map(r=>r.key);
  } else if(kind === "reply") {
    const rows=await db.$queryRawUnsafe<{key:string}[]>(`SELECT 'seller:'||"sellerId" AS key FROM "AttentionWorkRequest" WHERE id=$1::uuid`,work.id);
    recipients=rows.map(r=>r.key);
  } else {
    const rows=await db.$queryRawUnsafe<{key:string}[]>(`SELECT 'user:'||"assigneeUserId" AS key
      FROM "AttentionConversation" WHERE id=$1::uuid AND "assigneeUserId" IS NOT NULL
      AND "assigneeKey"='analyst:'||"assigneeUserId" AND "assigneeSellerId" IS NULL`,work.conversationId);
    recipients=rows.map(r=>r.key);
  }
  for (const recipientKey of recipients) {
    if(recipientKey === attentionWorkRecipientKey(actor)) continue;
    await db.$queryRawUnsafe(`INSERT INTO "AttentionWorkNotification"("recipientKey","workId","eventKey",kind,"workKind")
      SELECT n."recipientKey",n."workId",$3,n.kind,$5 FROM
      (SELECT $1::text AS "recipientKey",$2::uuid AS "workId",$4::text AS kind) n
      WHERE ${attentionWorkNotificationEligibleSql()} ON CONFLICT("recipientKey","eventKey") DO NOTHING RETURNING id`,
      recipientKey,work.id,`${work.id}:${eventKey}`,kind,work.kind);
  }
}

export function attentionWorkNotificationCopy(kind:AttentionWorkNotificationKind,workKind:AttentionWorkKind) {
  const queue=workKind === "enrollment" ? "Enrolamiento iPhone" : "Aprobación · bienvenida";
  return {
    title:kind === "created" ? `Nueva solicitud · ${queue}` : kind === "assigned" ? "Te asignaron una solicitud"
      : kind === "reply" ? "Respondieron a tu solicitud" : "El asesor envió información",
    description:kind === "created" ? "El equipo tiene una nueva solicitud pendiente de asignación."
      : kind === "assigned" ? `${queue}. Abre la solicitud para continuar la gestión.`
      : kind === "reply" ? `${queue}. Tienes un mensaje o archivo nuevo del equipo.`
      : `${queue}. Revisa el mensaje o archivo recibido.`,
  };
}

export function createAttentionWorkNotificationStore(database:AttentionDatabase) {
  async function transaction<T>(actor:AttentionWorkActor,run:(db:AttentionDb)=>Promise<T>) {
    return database.$transaction(async db=>{
      await assertAttentionWorkCurrentActor(db,actor);
      const [schema]=await db.$queryRawUnsafe<{ready:boolean}[]>(`SELECT to_regclass('public."AttentionWorkNotification"') IS NOT NULL AS ready`);
      if(!schema?.ready)throw new AttentionError("Las notificaciones están pendientes de instalar.",503);
      return run(db);
    },{isolationLevel:"ReadCommitted",timeout:20000,maxWait:10000});
  }
  async function list(db:AttentionDb,actor:AttentionWorkActor):Promise<AttentionWorkNotifications> {
    const key=attentionWorkRecipientKey(actor),where=`n."recipientKey"=$1 AND ${attentionWorkNotificationEligibleSql()}`;
    const rows=await db.$queryRawUnsafe<{id:string;workId:string;kind:AttentionWorkNotificationKind;workKind:AttentionWorkKind;createdAt:string|Date;readAt:string|Date|null;assigneeKey:string|null}[]>(
      `SELECT n.*,c."assigneeKey" FROM "AttentionWorkNotification" n
       JOIN "AttentionWorkRequest" w ON w.id=n."workId" JOIN "AttentionConversation" c ON c.id=w."conversationId"
       WHERE ${where} ORDER BY (n."readAt" IS NULL) DESC,n."createdAt" DESC,n.id DESC LIMIT 50`,key);
    const [total]=await db.$queryRawUnsafe<{count:number}[]>(`SELECT count(*)::int AS count FROM "AttentionWorkNotification" n WHERE ${where} AND n."readAt" IS NULL`,key);
    return {items:rows.map(n=>{
      const canOpen=actor.type === "seller" || actor.actor.central || n.assigneeKey === actor.actor.key;
      const base=actor.type === "seller" ? "/dashboard/gestion-comercial" : "/dashboard/atencion";
      return {id:n.id,kind:n.kind,workKind:n.workKind,...attentionWorkNotificationCopy(n.kind,n.workKind),
        description:n.kind === "created" && !canOpen ? "Pendiente de asignación. Administración central organiza esta bandeja." : attentionWorkNotificationCopy(n.kind,n.workKind).description,
        createdAt:new Date(n.createdAt).toISOString(),readAt:n.readAt ? new Date(n.readAt).toISOString() : null,
        href:`${base}?tipo=${n.workKind}${canOpen ? `&solicitud=${n.workId}` : ""}`};
    }),unreadCount:total.count,actorKey:key};
  }
  return {
    list:(actor:AttentionWorkActor)=>transaction(actor,db=>list(db,actor)),
    acknowledge:(actor:AttentionWorkActor,input:Record<string,unknown>)=>transaction(actor,async db=>{
      if(Object.keys(input).some(k=>k!=="ids") || !Array.isArray(input.ids) || !input.ids.length || input.ids.length>50)
        throw new AttentionError("Selecciona entre 1 y 50 avisos.");
      const ids=[...new Set(input.ids.map(attentionUuid))];
      await db.$queryRawUnsafe(`UPDATE "AttentionWorkNotification" n SET "readAt"=COALESCE(n."readAt",now())
        WHERE n.id=ANY($2::uuid[]) AND n."recipientKey"=$1 AND ${attentionWorkNotificationEligibleSql()} RETURNING n.id`,attentionWorkRecipientKey(actor),ids);
      return list(db,actor);
    }),
  };
}
export async function attentionWorkNotificationStore() {
  const {default:prisma}=await import("./prisma");
  return createAttentionWorkNotificationStore(prisma as unknown as AttentionDatabase);
}
