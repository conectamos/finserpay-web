import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import pg from "pg";
import { registerHooks } from "node:module";
import { PrismaPg } from "@prisma/adapter-pg";
import {actorModule,session,shared,loadSharedModule} from "./approval-shared-fixture.mjs";
import {installApprovalSharedSchema} from "../scripts/approval-shared-schema.mjs";
import {installApprovalEvidenceSchema} from "../scripts/approval-evidence-schema.mjs";
const connectionString=process.env.APPROVAL_SHARED_TEST_DATABASE_URL;
test("PostgreSQL aislado: grant común, sesiones, revocación y autoría verificable",{skip:connectionString?false:"Requiere APPROVAL_SHARED_TEST_DATABASE_URL local approval_shared_test"},async t=>{
  const url=new URL(connectionString);assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname));assert.equal(url.pathname,"/approval_shared_test");
  const pool=new pg.Pool({connectionString,max:6}),db=await pool.connect();t.after(async()=>{db.release();await pool.end();});
  const tables=["CreditApprovalEvidenceRevision","CreditApprovalSharedSession","CreditApprovalSharedGrant","LiquidacionAliadoCredito","CreditApprovalPolicy","Credito","Sede","Aliado","Usuario"];
  const previous=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;assert.ok(previous.every(row=>tables.includes(row.tablename)),"No se borran tablas ajenas");
  for(const table of tables)await db.query('DROP TABLE IF EXISTS "'+table+'" CASCADE');
  await db.query(`CREATE TABLE "Usuario"("id" INTEGER PRIMARY KEY);INSERT INTO "Usuario" VALUES(1);
    CREATE TABLE "Aliado"("id" INTEGER PRIMARY KEY,"codigo" TEXT);INSERT INTO "Aliado" VALUES(1,'ALLY'),(2,'FINSERPAY');
    CREATE TABLE "Sede"("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER);INSERT INTO "Sede" VALUES(1,1),(2,2);
    CREATE TABLE "Credito"("id" INTEGER PRIMARY KEY,"createdAt" TIMESTAMP,"sedeId" INTEGER,"estado" TEXT,"equalityService" TEXT,"contratoSnapshot" JSONB);
    INSERT INTO "Credito" VALUES(1,'2099-01-01',1,'ACTIVO',NULL,'{}'),(2,'2020-01-01',1,'ACTIVO',NULL,'{}'),(3,'2099-01-01',2,'ACTIVO',NULL,'{}'),(4,'2099-01-01',1,'ANULADO',NULL,'{}'),(5,'2099-01-01',1,'ACTIVO',NULL,'{}');
    CREATE TABLE "CreditApprovalPolicy"("id" INTEGER PRIMARY KEY,"activatedAt" TIMESTAMP);INSERT INTO "CreditApprovalPolicy" VALUES(1,'2026-01-01');
    CREATE TABLE "LiquidacionAliadoCredito"("creditoId" INTEGER);INSERT INTO "LiquidacionAliadoCredito" VALUES(5);`);
  await installApprovalEvidenceSchema(db);await installApprovalSharedSchema(db);
  const wrap=client=>({$queryRawUnsafe:async(sql,...args)=>(await client.query(sql,args)).rows,$executeRawUnsafe:async(sql,...args)=>(await client.query(sql,args)).rowCount});
  const api={...wrap(pool),$transaction:async callback=>{const client=await pool.connect();await client.query("BEGIN");await client.query("SET LOCAL TIME ZONE 'America/Bogota'");try{const result=await callback(wrap(client));await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}};
  const origin="https://example.invalid";
  const issued=await api.$transaction(tx=>shared.changeSharedApprovalLink(tx,1,null,origin));
  const token=new URL(issued.accessUrl).hash.slice("#acceso=".length);
  let current=issued;
  await t.test("grant no crea usuario, URL reusable y cada apertura tiene sesión propia de 8h",async()=>{
    assert.equal((await db.query('SELECT COUNT(*)::integer count FROM "Usuario"')).rows[0].count,1);
    assert.equal((await shared.getSharedApprovalLink(api,origin)).accessUrl,issued.accessUrl);
    const first=await api.$transaction(tx=>shared.exchangeSharedApprovalLink(tx,token));
    const second=await api.$transaction(tx=>shared.exchangeSharedApprovalLink(tx,token));
    assert.notEqual(first.sessionId,second.sessionId);assert.equal(first.grantId,second.grantId);
    assert.equal((await db.query(`SELECT EXTRACT(EPOCH FROM ("expiresAt"-"createdAt")) seconds FROM "CreditApprovalSharedSession" WHERE "id"=$1`,[first.sessionId])).rows[0].seconds,"28800.000000");
    const actor={kind:"SHARED_LINK",id:null,nombre:"Acceso compartido",grantId:first.grantId,sessionId:first.sessionId};
    await api.$transaction(tx=>actorModule.assertApprovalActorActive(tx,actor));
    await actorModule.assertApprovalActorCreditAccess(api,1,actor);
    for(const id of [2,3,4,5,99])await assert.rejects(actorModule.assertApprovalActorCreditAccess(api,id,actor),error=>error.status===404);
    const history=loadSharedModule("lib/credit-approval-evidence-history.ts",{"@/lib/credit-approval-actor":actorModule});
    await history.archiveEvidenceRevision(api,{creditId:1,key:"foto-entrega",previousDataUrl:null,previousSha256:null,nextSha256:"a".repeat(64),actor,source:"ANALISTA_APROBACION",reviewRevision:1,reviewHash:"b".repeat(64)});
    const audit=(await db.query('SELECT "actorUserId","actorName","actorKind","actorGrantId","actorSessionId" FROM "CreditApprovalEvidenceRevision"')).rows[0];
    assert.equal(audit.actorUserId,null);assert.equal(audit.actorName,"Acceso compartido");assert.equal(audit.actorKind,"SHARED_LINK");assert.equal(audit.actorGrantId,first.grantId);assert.equal(audit.actorSessionId,first.sessionId);
    await shared.revokeSharedApprovalSession(api,first.grantId,first.sessionId);
    await assert.rejects(api.$transaction(tx=>actorModule.assertApprovalActorActive(tx,actor)),error=>error.status===401);
    await api.$transaction(tx=>actorModule.assertApprovalActorActive(tx,{...actor,sessionId:second.sessionId}));
  });
  await t.test("dos rotaciones concurrentes conservan un solo vigente y rechazan intención obsoleta",async()=>{
    const results=await Promise.allSettled([1,2].map(()=>api.$transaction(tx=>shared.changeSharedApprovalLink(tx,1,current.grantId,origin))));
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(results.find(r=>r.status==="rejected").reason.code,"LINK_CHANGED");
    current=results.find(r=>r.status==="fulfilled").value;
    assert.equal((await db.query('SELECT COUNT(*)::integer count FROM "CreditApprovalSharedGrant" WHERE "revokedAt" IS NULL')).rows[0].count,1);
    await assert.rejects(api.$transaction(tx=>shared.exchangeSharedApprovalLink(tx,token)),error=>error.status===401);
    assert.equal((await db.query('SELECT COUNT(*)::integer count FROM "CreditApprovalSharedGrant"')).rows[0].count,2);
  });
  await t.test("revocar espera la mutación validada y después bloquea toda sesión del grant",async()=>{
    const access=await api.$transaction(tx=>shared.exchangeSharedApprovalLink(tx,new URL(current.accessUrl).hash.slice(8)));
    const actor={kind:"SHARED_LINK",id:null,nombre:"Acceso compartido",grantId:access.grantId,sessionId:access.sessionId};
    let release,entered;const hold=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
    const mutation=api.$transaction(async tx=>{await actorModule.assertApprovalActorActive(tx,actor);entered();await hold;});
    await started;let finished=false;
    const revoke=api.$transaction(tx=>shared.changeSharedApprovalLink(tx,1,current.grantId,origin,true)).then(result=>{finished=true;return result;});
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(finished,false);release();await mutation;
    assert.equal((await revoke).active,false);
    await assert.rejects(api.$transaction(tx=>actorModule.assertApprovalActorActive(tx,actor)),error=>error.status===401);
    await assert.rejects(db.query('DELETE FROM "CreditApprovalSharedGrant" WHERE "id"=$1',[current.grantId]),/IMMUTABLE/);
    await assert.rejects(db.query(`UPDATE "CreditApprovalSharedSession" SET "expiresAt"="expiresAt"+INTERVAL '1 hour' WHERE "id"=$1`,[access.sessionId]),/IMMUTABLE/);
  });
  await t.test("reinstala sin reactivar enlaces ni modificar corte e instala integridad Prisma-first",async()=>{
    await installApprovalSharedSchema(db);
    assert.equal((await shared.getSharedApprovalLink(api,origin)).active,false);
    assert.equal((await db.query('SELECT "activatedAt"::text FROM "CreditApprovalPolicy"')).rows[0].activatedAt,"2026-01-01 00:00:00");
    const checks=await db.query(`SELECT conname FROM pg_constraint WHERE conrelid='"CreditApprovalSharedSession"'::regclass AND contype='c'`);
    for(const {conname} of checks.rows)await db.query('ALTER TABLE "CreditApprovalSharedSession" DROP CONSTRAINT "'+conname+'"');
    await installApprovalSharedSchema(db);
    await assert.rejects(db.query(`INSERT INTO "CreditApprovalSharedSession"("id","grantId","expiresAt") VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '9 hours')`,[randomUUID(),issued.grantId]),error=>error.code==="23514");
    assert.equal(session.verifyApprovalSharedToken("invalid"),null);
  });
  await t.test("PrismaClient real genera, canjea, rota y revoca sin deserializar un lock void",async()=>{
    // Match the application's PrismaPg path; plain pg does not reject PostgreSQL void.
    const hooks=registerHooks({resolve(specifier,context,nextResolve){
      if(specifier.startsWith(".")&&context.parentURL?.includes("/app/generated/prisma/")){
        try{return nextResolve(specifier,context);}catch(error){
          if(error.code==="ERR_MODULE_NOT_FOUND")return nextResolve(`${specifier}.ts`,context);
          throw error;
        }
      }
      return nextResolve(specifier,context);
    }});
    let prisma;
    try{
      const {PrismaClient}=await import("../app/generated/prisma/client.ts");
      prisma=new PrismaClient({adapter:new PrismaPg({connectionString})});
      const issued=await prisma.$transaction(tx=>shared.changeSharedApprovalLink(tx,1,current.grantId,origin));
      assert.equal(issued.active,true);
      assert.equal((await shared.getSharedApprovalLink(prisma,origin)).grantId,issued.grantId);
      const token=new URL(issued.accessUrl).hash.slice(8);
      const access=await prisma.$transaction(tx=>shared.exchangeSharedApprovalLink(tx,token));
      const actor={kind:"SHARED_LINK",id:null,nombre:"Acceso compartido",grantId:access.grantId,sessionId:access.sessionId};
      await prisma.$transaction(tx=>actorModule.assertApprovalActorActive(tx,actor));
      const rotated=await prisma.$transaction(tx=>shared.changeSharedApprovalLink(tx,1,issued.grantId,origin));
      assert.notEqual(rotated.grantId,issued.grantId);
      await assert.rejects(prisma.$transaction(tx=>actorModule.assertApprovalActorActive(tx,actor)),error=>error.status===401);
      await assert.rejects(prisma.$transaction(tx=>shared.exchangeSharedApprovalLink(tx,token)),error=>error.status===401);
      const revoked=await prisma.$transaction(tx=>shared.changeSharedApprovalLink(tx,1,rotated.grantId,origin,true));
      assert.equal(revoked.active,false);
      assert.equal(revoked.accessUrl,null);
    }finally{
      if(prisma)await prisma.$disconnect();
      hooks.deregister();
    }
  });
});
