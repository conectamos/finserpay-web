import "server-only";
import { AttentionError } from "./atencion-core";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import type { AttentionWorkActor } from "./atencion-work-types";
import { assertAttentionWorkCurrentActor, attentionWorkRecipientKey } from "./atencion-work-actor";
import { validateAttentionPushSubscription } from "./atencion-push-core";

export function createAttentionPushStore(database:AttentionDatabase){
  async function transaction<T>(actor:AttentionWorkActor,run:(db:AttentionDb)=>Promise<T>){
    return database.$transaction(async db=>{
      await assertAttentionWorkCurrentActor(db,actor);
      const [schema]=await db.$queryRawUnsafe<{ready:boolean}[]>(`SELECT to_regclass('public."AttentionPushSubscription"') IS NOT NULL AS ready`);
      if(!schema?.ready)throw new AttentionError("Los avisos al celular están pendientes de instalar.",503);
      return run(db);
    },{isolationLevel:"ReadCommitted",timeout:20000,maxWait:10000});
  }
  return {
    status:(actor:AttentionWorkActor,endpoint:string|null)=>transaction(actor,async db=>{
      if(!endpoint)return {subscribed:false};
      const rows=await db.$queryRawUnsafe<{id:string}[]>(`UPDATE "AttentionPushSubscription" SET "updatedAt"=now(),"expiresAt"=now()+interval '90 days'
        WHERE endpoint=$1 AND "recipientKey"=$2 AND "expiresAt">now() RETURNING id`,endpoint,attentionWorkRecipientKey(actor));
      return {subscribed:rows.length>0};
    }),
    subscribe:(actor:AttentionWorkActor,input:unknown)=>transaction(actor,async db=>{
      const subscription=validateAttentionPushSubscription(input),key=attentionWorkRecipientKey(actor);
      await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`attention-push:${key}`);
      await db.$queryRawUnsafe(`DELETE FROM "AttentionPushSubscription" WHERE "recipientKey"=$1 AND "expiresAt"<=now() RETURNING id`,key);
      const [count]=await db.$queryRawUnsafe<{n:number}[]>(`SELECT count(*)::int AS n FROM "AttentionPushSubscription" WHERE "recipientKey"=$1 AND endpoint<>$2`,key,subscription.endpoint);
      if(count.n>=10)throw new AttentionError("Ya tienes 10 dispositivos activos. Desactiva uno antes de agregar otro.",409);
      const [row]=await db.$queryRawUnsafe<{id:string}[]>(`INSERT INTO "AttentionPushSubscription"("recipientKey",endpoint,keys)
        VALUES($1,$2,$3::jsonb) ON CONFLICT(endpoint) DO UPDATE SET "recipientKey"=excluded."recipientKey",keys=excluded.keys,
        "createdAt"=now(),"updatedAt"=now(),"expiresAt"=now()+interval '90 days' RETURNING id`,key,subscription.endpoint,JSON.stringify(subscription.keys));
      return row;
    }),
    unsubscribe:(actor:AttentionWorkActor,endpoint:unknown)=>transaction(actor,async db=>{
      if(typeof endpoint!=="string"||endpoint.length>2048)throw new AttentionError("Dispositivo inválido.");
      await db.$queryRawUnsafe(`DELETE FROM "AttentionPushSubscription" WHERE endpoint=$1 AND "recipientKey"=$2 RETURNING id`,endpoint,attentionWorkRecipientKey(actor));
      return {subscribed:false};
    }),
  };
}
export async function attentionPushStore(){
  const {default:prisma}=await import("./prisma");
  return createAttentionPushStore(prisma as unknown as AttentionDatabase);
}
