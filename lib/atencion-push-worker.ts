import "server-only";
import { randomUUID } from "node:crypto";
import type { AttentionDatabase } from "./atencion-storage";
import { attentionWorkNotificationEligibleSql } from "./atencion-work-notifications";
import { attentionPushConfig, attentionPushPayload, attentionPushRetry, validateAttentionPushSubscription, type AttentionPushSubscription } from "./atencion-push-core";

type Delivery={id:string;notificationId:string;subscriptionId:string;attempts:number;leaseToken:string};
type Ready={endpoint:string;keys:AttentionPushSubscription["keys"];kind:string;workKind:string};
type Send=(subscription:AttentionPushSubscription,payload:string)=>Promise<unknown>;
/** The notification rows form the durable outbox; leases make restarts and multiple replicas safe. */
export async function dispatchAttentionPush(database:AttentionDatabase,send:Send){
  const lease=randomUUID(),eligible=attentionWorkNotificationEligibleSql();
  const deliveries=await database.$transaction(async db=>{
    await db.$queryRawUnsafe(`INSERT INTO "AttentionPushDelivery"("notificationId","subscriptionId")
      SELECT n.id,s.id FROM "AttentionWorkNotification" n JOIN "AttentionPushSubscription" s ON s."recipientKey"=n."recipientKey"
      WHERE n."readAt" IS NULL AND n."createdAt">now()-interval '24 hours' AND n."createdAt">=s."createdAt" AND s."expiresAt">now()
      AND ${eligible} AND NOT EXISTS(SELECT 1 FROM "AttentionPushDelivery" d WHERE d."notificationId"=n.id AND d."subscriptionId"=s.id)
      ORDER BY n."createdAt" LIMIT 100 ON CONFLICT("notificationId","subscriptionId") DO NOTHING RETURNING id`);
    return db.$queryRawUnsafe<Delivery[]>(`WITH claimed AS(SELECT id FROM "AttentionPushDelivery"
      WHERE "deliveredAt" IS NULL AND attempts<6 AND "nextAttemptAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now())
      ORDER BY "nextAttemptAt",id LIMIT 20 FOR UPDATE SKIP LOCKED)
      UPDATE "AttentionPushDelivery" d SET "leaseToken"=$1::uuid,"leaseUntil"=now()+interval '90 seconds',attempts=d.attempts+1
      FROM claimed WHERE d.id=claimed.id RETURNING d.id,d."notificationId",d."subscriptionId",d.attempts,d."leaseToken"`,lease);
  },{isolationLevel:"ReadCommitted",timeout:20000,maxWait:10000});
  let sent=0,failed=0;
  for(let offset=0;offset<deliveries.length;offset+=4){
    await Promise.all(deliveries.slice(offset,offset+4).map(async d=>{
      const [ready]=await database.$queryRawUnsafe<Ready[]>(`SELECT s.endpoint,s.keys,n.kind,n."workKind" FROM "AttentionPushDelivery" d
        JOIN "AttentionWorkNotification" n ON n.id=d."notificationId" JOIN "AttentionPushSubscription" s ON s.id=d."subscriptionId"
        WHERE d.id=$1::uuid AND d."leaseToken"=$2::uuid AND d."leaseUntil">now() AND d."deliveredAt" IS NULL
        AND n."recipientKey"=s."recipientKey" AND n."createdAt">=s."createdAt" AND n."readAt" IS NULL
        AND n."createdAt">now()-interval '24 hours' AND s."expiresAt">now() AND ${eligible}`,d.id,lease);
      if(!ready){await database.$queryRawUnsafe(`UPDATE "AttentionPushDelivery" SET "deliveredAt"=now(),"errorCode"='cancelled',"leaseUntil"=NULL WHERE id=$1::uuid AND "leaseToken"=$2::uuid RETURNING id`,d.id,lease);return;}
      try {
        const subscription=validateAttentionPushSubscription(ready);
        await send(subscription,JSON.stringify(attentionPushPayload(d.notificationId,ready.kind,ready.workKind)));
        await database.$queryRawUnsafe(`UPDATE "AttentionPushDelivery" SET "deliveredAt"=now(),"errorCode"=NULL,"leaseUntil"=NULL WHERE id=$1::uuid AND "leaseToken"=$2::uuid RETURNING id`,d.id,lease);
        sent++;
      } catch(error){
        const status=Number((error as {statusCode?:number;status?:number})?.statusCode||(error as {status?:number})?.status||0);
        const retry=attentionPushRetry(status,d.attempts);failed++;
        if(retry.remove){await database.$queryRawUnsafe(`DELETE FROM "AttentionPushSubscription" WHERE id=$1::uuid AND endpoint=$2 RETURNING id`,d.subscriptionId,ready.endpoint);return;}
        await database.$queryRawUnsafe(`UPDATE "AttentionPushDelivery" SET "deliveredAt"=CASE WHEN $3::boolean THEN now() ELSE NULL END,
          "nextAttemptAt"=now()+($4::integer*interval '1 second'),"leaseUntil"=NULL,"errorCode"=$5
          WHERE id=$1::uuid AND "leaseToken"=$2::uuid RETURNING id`,d.id,lease,retry.terminal,retry.delay,status?`http_${status}`:"network");
      }
    }));
  }
  return {processed:deliveries.length,sent,failed};
}

declare global {var __finserAttentionPushWorker:{running:boolean;timer:ReturnType<typeof setInterval>}|undefined;}
export function startAttentionPushWorker(){
  if(process.env.NODE_ENV!=="production"||process.env.NEXT_PHASE==="phase-production-build"||!attentionPushConfig()||globalThis.__finserAttentionPushWorker)return;
  const tick=async()=>{
    const state=globalThis.__finserAttentionPushWorker;if(!state||state.running)return;state.running=true;
    try {
      const config=attentionPushConfig();if(!config)return;
      const [{default:prisma},{default:webpush}]=await Promise.all([import("./prisma"),import("web-push")]);
      const result=await dispatchAttentionPush(prisma as unknown as AttentionDatabase,(subscription,payload)=>webpush.sendNotification(subscription,payload,{
        vapidDetails:config,TTL:3600,urgency:"normal",timeout:10000,
      }));
      if(result.failed)console.warn(`[attention-push] delivery failures=${result.failed}; durable retries enabled`);
    } catch {console.warn("[attention-push] worker unavailable; pending notifications retained");}
    finally {state.running=false;}
  };
  const timer=setInterval(()=>{void tick();},10000);timer.unref();
  globalThis.__finserAttentionPushWorker={running:false,timer};
  void tick();
}
