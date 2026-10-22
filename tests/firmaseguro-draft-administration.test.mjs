import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createReissueFixture, loadReissueModule, seals } from "./credit-approval-reissue-fixture.mjs";
const schema = JSON.parse(readFileSync(new URL("../lib/firmaseguro-draft-administration-schema.json",import.meta.url),"utf8"));
const ledgerSource=readFileSync(new URL("../lib/firmaseguro-draft-dispatch-ledger.ts",import.meta.url),"utf8");
const statements=[...ledgerSource.matchAll(/await prisma\.\$executeRawUnsafe\(`([\s\S]*?)`\);/g)].map(x=>x[1]);
const actor={id:7,nombre:"Administrador real"};
const reason="Revisión del portal por documento y folio; el resultado remoto sigue incierto.";
const sha=x=>createHash("sha256").update(x).digest("hex");
class DraftDispatchError extends Error { constructor(code,message,status=409){super(message);this.code=code;this.status=status;} }
async function fixture(t,{identity=false,failReservation=false}={}) {
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE "Usuario"("id" INTEGER PRIMARY KEY);
 CREATE TABLE "CreditoBorrador"("id" INTEGER PRIMARY KEY,"estado" TEXT DEFAULT 'ABIERTO',"creditoId" INTEGER,
 "currentStep" INTEGER DEFAULT 3,"payload" JSONB NOT NULL,"closedAt" TIMESTAMP,"closedReason" TEXT,"createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"expiresAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP+INTERVAL '15 days');
 CREATE TABLE "FirmaSeguroProcess"("processUuid" TEXT PRIMARY KEY,"draftId" INTEGER,"creditoId" INTEGER,
 "draftFolio" TEXT,"draftPayload" JSONB,"supersededAt" TIMESTAMP,"status" TEXT);
 CREATE TABLE "VeriffIdentityValidation"("id" INTEGER PRIMARY KEY,"draftId" INTEGER,"creditoId" INTEGER,"status" TEXT,"clienteDocumento" TEXT);
 INSERT INTO "Usuario" VALUES(7),(8);`);
 for(const statement of statements) await db.exec(statement);
 const adapters=connection=>({
  $queryRawUnsafe:async(sql,...params)=>(await connection.query(sql,params)).rows,
  $executeRawUnsafe:async(sql,...params)=>{if(failReservation && /^\s*INSERT INTO "FirmaSeguroDraftDispatch"/.test(sql)) return connection.query("SELECT 'injected reservation failure'::integer"); return (await connection.query(sql,params)).affectedRows;},
 });
 let queue=Promise.resolve(); const prisma={...adapters(db),$transaction:operation=>{const result=queue.then(()=>db.transaction(tx=>operation(adapters(tx))));queue=result.catch(()=>{});return result;}};
 const originalId=randomUUID(),source=createReissueFixture(81),document=Buffer.from("%PDF-1.7\nFrozen exact contract\n%%EOF");
 const payload={clienteDocumento:"100000001",clienteTelefono:"3000000001",veriffValidationId:91,firmaSeguroDraftFolio:source.credit.folio};
 await db.query('INSERT INTO "CreditoBorrador"("id","payload") VALUES(81,$1)',[payload]);
 await db.exec(`INSERT INTO "VeriffIdentityValidation" VALUES(91,81,NULL,'approved','100000001')`);
 await db.query(`INSERT INTO "FirmaSeguroDraftDispatch"
 ("id","draftId","actorUserId","actorName","reason","status","draftFolio","sourcePayload","updatedPayload",
 "draftPayload","frozenCredit","documentBase64","documentHash")
 VALUES($1,81,8,'Asesor original','Envío del contrato de la solicitud a FirmaSeguro','PREPARING',$2,$3,$3,$4,$5,$6,$7)`,
 [originalId,source.credit.folio,payload,{...payload,financialTermsSeal:source.seal},source.credit,document.toString("base64"),sha(document)]);
 await db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'DISPATCHING\',"dispatchedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',[originalId]);
 await db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'UNCERTAIN\',"lastError"=\'provider_dispatch HTTP502\' WHERE "id"=$1',[originalId]);
 const dates={dateKey:source.seal.snapshot.fechaPrimerPago};
 const service=loadReissueModule("lib/firmaseguro-draft-administration.ts",{
  "@/lib/prisma":{default:prisma},
  "@/lib/firmaseguro-draft-administration-schema.json":{default:schema},
  "@/lib/firmaseguro-draft-dispatch-ledger":{DraftDispatchError,ensureDraftDispatchSchema:async()=>{}},
  "@/lib/firmaseguro-storage":{lockSolicitudOperationMutation:async(database,id)=>{await database.$queryRawUnsafe("SELECT pg_advisory_xact_lock(5843,$1)",id);}},
  "@/lib/credit-amortization-contract":seals,
  "@/lib/credit-factory":{resolveActivationFirstPaymentDate:()=>dates},
  "@/lib/datacredito":{getDataCreditoPublicConfig:()=>({enabled:identity})},
  "@/lib/veriff":{isVeriffRequired:()=>false},
  "@/lib/veriff-storage":{ensureVeriffSchema:async()=>{},isVeriffApproved:v=>v.status==="approved"},
 });
 const input=patch=>({draftId:81,dispatchId:originalId,actor,reason,providerReviewConfirmed:true,remoteOutcomeUnknownAccepted:true,...patch});
 return{db,source,originalId,document,payload,service,input,dates,
  recover:patch=>service.recoverUncertainDraftDispatch(input(patch)),
  rows:async()=> (await db.query('SELECT * FROM "FirmaSeguroDraftDispatch" ORDER BY "createdAt","id"')).rows,
  audit:async()=> (await db.query('SELECT * FROM "FirmaSeguroDraftAdministrativeRecovery"')).rows,
 };
}
test("recovery reserves one exact PDF/folio/seal, records UNKNOWN and never sends",async t=>{
 const f=await fixture(t),before=(await f.rows())[0],result=await f.recover();assert.equal(result.status,"PREPARING");
 const rows=await f.rows(),original=rows.find(x=>x.id===f.originalId),replacement=rows.find(x=>x.id===result.replacementDispatchId);
 assert.equal(original.status,"ABANDONED");
 for(const key of Object.keys(before).filter(k=>!["status","updatedAt"].includes(k))) assert.deepEqual(original[key],before[key],key);
 for(const key of ["draftFolio","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash"]) assert.deepEqual(replacement[key],before[key],key);
 assert.deepEqual(replacement.sourcePayload,before.updatedPayload);assert.equal(replacement.actorUserId,actor.id);
 assert.equal(replacement.requestPayload,null);assert.equal(replacement.dispatchedAt,null);
 const [audit]=await f.audit();assert.equal(audit.providerOutcome,"UNKNOWN");assert.equal(audit.actorUserId,actor.id);
 assert.equal(audit.reason,reason);assert.equal(audit.replacementDispatchId,replacement.id);
 assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM "FirmaSeguroDraftDispatchReceipt"')).rows[0].n,0);
});
test("replayed concurrent requests reuse one reservation; other actors cannot take it",async t=>{
 const f=await fixture(t);const [a,b]=await Promise.all([f.recover(),f.recover()]);
 assert.equal(a.replacementDispatchId,b.replacementDispatchId);assert.equal((await f.rows()).length,2);assert.equal((await f.audit()).length,1);
 await assert.rejects(f.recover({actor:{id:8,nombre:"Otro"}}),{code:"DRAFT_ADMINISTRATIVE_REPLAY_CONFLICT"});
});
test("both acknowledgements and a substantial reason are required before writes",async t=>{
 const f=await fixture(t);
 for(const patch of [{providerReviewConfirmed:false},{remoteOutcomeUnknownAccepted:false},{reason:"Corto"}])
  await assert.rejects(f.recover(patch),{code:"DRAFT_ADMINISTRATIVE_INVALID"});
 assert.equal((await f.rows()).length,1);
});
test("changed payload, expired draft and changed validation roll back recovery",async t=>{
 for(const mode of ["payload","expired","identity"]) await t.test(mode,async sub=>{
  const f=await fixture(sub,{identity:true});
  if(mode==="payload") await f.db.exec('UPDATE "CreditoBorrador" SET "payload"="payload"||\'{"clienteTelefono":"3009999999"}\'::jsonb');
  if(mode==="expired") await f.db.exec('UPDATE "CreditoBorrador" SET "expiresAt"=CURRENT_TIMESTAMP-INTERVAL \'1 day\'');
  if(mode==="identity") await f.db.exec('UPDATE "VeriffIdentityValidation" SET "status"=\'rejected\'');
  await assert.rejects(f.recover());assert.equal((await f.rows()).length,1);assert.equal((await f.audit()).length,0);
 });
});
test("a locator or existing provider process forbids abandonment",async t=>{
 for(const mode of ["locator","process"]) await t.test(mode,async sub=>{
  const f=await fixture(sub),uuid=randomUUID();
  if(mode==="locator") await f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "processUuid"=$1',[uuid]);
  else await f.db.query('INSERT INTO "FirmaSeguroProcess"("processUuid","draftId") VALUES($1,81)',[uuid]);
  await assert.rejects(f.recover());assert.equal((await f.rows())[0].status,"UNCERTAIN");
 });
});
test("damaged PDF or changed payment date prevents reservation without rewriting terms",async t=>{
 for(const mode of ["pdf","date"]) await t.test(mode,async sub=>{
  const f=await fixture(sub);
  if(mode==="date") f.dates.dateKey="2099-03-01";
  else {
   await f.db.exec('DROP TRIGGER "FirmaSeguroDraftDispatch_preserve" ON "FirmaSeguroDraftDispatch"');
   await f.db.exec('UPDATE "FirmaSeguroDraftDispatch" SET "documentBase64"=\'bm90IHBkZg==\'');
  }
  await assert.rejects(f.recover(),{code:"DRAFT_ADMINISTRATIVE_CONTRACT_INVALID"});assert.equal((await f.rows()).length,1);
 });
});
test("immutable audit and abandoned dispatch; a second uncertain replacement cannot form a retry chain",async t=>{
 const f=await fixture(t),recovered=await f.recover();
 await assert.rejects(f.db.exec('DELETE FROM "FirmaSeguroDraftAdministrativeRecovery"'),/DRAFT_ADMINISTRATIVE_AUDIT_IMMUTABLE/);
 await assert.rejects(f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "lastError"=\'changed\' WHERE "id"=$1',[f.originalId]),/IMMUTABLE/);
 await f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'DISPATCHING\' WHERE "id"=$1',[recovered.replacementDispatchId]);
 await f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'UNCERTAIN\' WHERE "id"=$1',[recovered.replacementDispatchId]);
 await assert.rejects(f.recover({dispatchId:recovered.replacementDispatchId}),{code:"DRAFT_ADMINISTRATIVE_EVIDENCE_CHANGED"});
 assert.equal((await f.rows()).length,2);
});
test("late abandoned callbacks and ambiguous same-PDF reconciliation cannot attach",async t=>{
 const f=await fixture(t),{replacementDispatchId}=await f.recover();
 const receipt=(id,kind,source="provider_reconciliation")=>f.db.query(
  `INSERT INTO "FirmaSeguroDraftDispatchReceipt"("dispatchId","processUuid","providerStatus","createPayload","source","actorUserId","actorName","evidence")
   VALUES($1,$2,'CREATED','{}',$3,7,'Real verifier',$4)`,[id,randomUUID(),source,{kind}]);
 await assert.rejects(receipt(f.originalId,"provider_tag"),/ABANDONED_DISPATCH_RECEIPT_FORBIDDEN/);
 await assert.rejects(receipt(replacementDispatchId,"original_pdf_sha256"),/DRAFT_ADMINISTRATIVE_EXACT_TAG_REQUIRED/);
 await receipt(replacementDispatchId,"provider_tag");
 await assert.rejects(f.db.query(`INSERT INTO "FirmaSeguroDraftDispatchReconciliation"
  ("dispatchId","processUuid","providerStatus","providerPayload","actorUserId","actorName","evidence")
  VALUES($1,$2,'CREATED','{}',7,'Real verifier','{"kind":"original_pdf_sha256"}')`,
  [replacementDispatchId,randomUUID()]),/DRAFT_ADMINISTRATIVE_EXACT_TAG_REQUIRED/);
});
test("unreviewed updates cannot abandon arbitrary dispatches",async t=>{
 const f=await fixture(t);await f.service.ensureDraftAdministrativeRecoverySchema();
 await assert.rejects(f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'ABANDONED\' WHERE "id"=$1',[f.originalId]),/DRAFT_ADMINISTRATIVE_RECOVERY_NOT_AUTHORIZED/);
 assert.equal((await f.rows())[0].status,"UNCERTAIN");
});
test("route authorizes Central only and resolves the audit actor from session",async()=>{
 const calls=[];let user={id:7,nombre:"Admin real",rolNombre:"ADMIN",aliadoAccesoCodigo:"CENTRAL"};
 const route=loadReissueModule("app/api/creditos/borradores/[id]/firma-seguro/recuperar/route.ts",{
  "next/server":{NextResponse:Response},"@/lib/auth":{getSessionUser:async()=>user},
  "@/lib/roles":{isAdminRole:r=>r==="ADMIN"},"@/lib/aliados":{isFinserPayCentralAlly:a=>a==="CENTRAL"},
  "@/lib/firmaseguro-draft-dispatch-ledger":{DraftDispatchError},
  "@/lib/firmaseguro-draft-administration":{recoverUncertainDraftDispatch:async input=>{calls.push(input);return{replacementDispatchId:randomUUID(),status:"PREPARING"};}},
 }).POST;
 const invoke=()=>route(new Request("https://example.invalid/recuperar",{method:"POST",body:JSON.stringify({
  dispatchId:randomUUID(),reason,actor:{id:999},providerReviewConfirmed:true,remoteOutcomeUnknownAccepted:true})}),{params:Promise.resolve({id:"81"})});
 assert.equal((await invoke()).status,200);assert.equal(calls[0].actor.id,7);
 user={...user,aliadoAccesoCodigo:"ALLY"};assert.equal((await invoke()).status,403);assert.equal(calls.length,1);
 user=null;assert.equal((await invoke()).status,401);
});


const legacy3433 = "CREATE FUNCTION public.firmaseguro_draft3433_administrative_guard() RETURNS trigger LANGUAGE plpgsql AS $function$\n  BEGIN\n    IF OLD.\"status\"='ABANDONED' AND NEW IS DISTINCT FROM OLD THEN\n      RAISE EXCEPTION 'ABANDONED_DISPATCH_IMMUTABLE' USING ERRCODE='23514';\n    END IF;\n    IF NEW.\"status\"='ABANDONED' AND OLD.\"status\" IS DISTINCT FROM NEW.\"status\" THEN\n      IF OLD.\"id\"<>'e3955dc0-25f4-4b77-b665-11cdb814ea70'::uuid OR OLD.\"draftId\"<>3433\n        OR OLD.\"status\"<>'UNCERTAIN' OR OLD.\"processUuid\" IS NOT NULL OR OLD.\"expectedProcessUuid\" IS NOT NULL\n        OR md5((to_jsonb(NEW)-'status'-'updatedAt')::text)<>md5((to_jsonb(OLD)-'status'-'updatedAt')::text)\n        OR NOT EXISTS (SELECT 1 FROM \"FirmaSeguroDraft3433AdministrativeLog\" log\n          WHERE log.\"dispatchId\"=OLD.\"id\" AND log.\"action\"='AUTHORIZE_ABANDONMENT'\n            AND log.\"freezeFingerprint\"=md5((to_jsonb(OLD)-'status'-'updatedAt')::text))\n        OR EXISTS (SELECT 1 FROM \"FirmaSeguroDraftDispatchReceipt\" WHERE \"dispatchId\"=OLD.\"id\")\n        OR EXISTS (SELECT 1 FROM \"FirmaSeguroProcess\" WHERE \"draftId\"=3433)\n        THEN RAISE EXCEPTION 'ADMINISTRATIVE_ABANDONMENT_NOT_AUTHORIZED' USING ERRCODE='23514'; END IF;\n    END IF;\n    RETURN NEW;\n  END $function$;\n";

test("reserved recovery rejects stale autosave and direct insertion cannot bypass its allowance",async t=>{
 const f=await fixture(t),{replacementDispatchId}=await f.recover();
 await assert.rejects(f.db.exec('UPDATE "CreditoBorrador" SET "payload"="payload"-\'firmaSeguroDraftFolio\''),/DRAFT_ADMINISTRATIVE_CONTRACT_FROZEN/);
 assert.deepEqual((await f.db.query('SELECT "payload" FROM "CreditoBorrador" WHERE "id"=81')).rows[0].payload,f.payload);
 await f.db.exec('UPDATE "CreditoBorrador" SET "updatedAt"=CURRENT_TIMESTAMP');
 const insert=(status,id=randomUUID(),expected=null)=>f.db.query(`INSERT INTO "FirmaSeguroDraftDispatch"
  ("id","draftId","actorUserId","actorName","reason","expectedProcessUuid","status","draftFolio",
   "sourcePayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash")
  SELECT $2::uuid,"draftId",7,'Administrator','Audited ordinary correction',$4,$3,"draftFolio",
   "updatedPayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash"
  FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1`,[replacementDispatchId,id,status,expected]);
 await assert.rejects(insert("ABANDONED"),/DRAFT_ADMINISTRATIVE_INSERT_ABANDONED_FORBIDDEN/);
 await f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'FAILED_SAFE\' WHERE "id"=$1',[replacementDispatchId]);
 await assert.rejects(insert("PREPARING"),/DRAFT_ADMINISTRATIVE_ALLOWANCE_CONSUMED/);
});

test("legacy3433 guard and audit remain effective while unrelated recovery works",async t=>{
 const f=await fixture(t);
 await f.db.exec(legacy3433);
 await f.db.exec(`CREATE TABLE "FirmaSeguroDraft3433AdministrativeLog"("dispatchId" UUID,"action" TEXT,"freezeFingerprint" CHAR(32));
 CREATE TRIGGER "FirmaSeguroDraft3433_administrative_guard" BEFORE UPDATE ON "FirmaSeguroDraftDispatch"
 FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_draft3433_administrative_guard();
 ALTER TABLE "FirmaSeguroDraftDispatch" DROP CONSTRAINT "FirmaSeguroDraftDispatch_status_check";
 ALTER TABLE "FirmaSeguroDraftDispatch" ADD CONSTRAINT "FirmaSeguroDraftDispatch_status_check"
 CHECK ("status" IN('PREPARING','DISPATCHING','AWAITING_SIGNATURE','FAILED_SAFE','UNCERTAIN')
 OR ("status"='ABANDONED' AND "id"='e3955dc0-25f4-4b77-b665-11cdb814ea70' AND "draftId"=3433));
 INSERT INTO "CreditoBorrador"("id","payload") VALUES(3433,'{}');
 INSERT INTO "FirmaSeguroDraftDispatch"
  ("id","draftId","actorUserId","actorName","reason","status","draftFolio","sourcePayload","updatedPayload",
   "draftPayload","frozenCredit","documentBase64","documentHash")
 SELECT 'e3955dc0-25f4-4b77-b665-11cdb814ea70',3433,"actorUserId","actorName","reason",'ABANDONED',"draftFolio",
 "sourcePayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash" FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=81;
 INSERT INTO "FirmaSeguroDraft3433AdministrativeLog" VALUES('e3955dc0-25f4-4b77-b665-11cdb814ea70','AUTHORIZE_ABANDONMENT','01234567890123456789012345678901');`);
 const before=(await f.db.query('SELECT to_jsonb(d) AS data FROM "FirmaSeguroDraftDispatch" d WHERE "draftId"=3433')).rows[0].data;
 const audit=(await f.db.query('SELECT * FROM "FirmaSeguroDraft3433AdministrativeLog"')).rows;
 const originalHash=(await f.db.query("SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid='public.firmaseguro_draft3433_administrative_guard()'::regprocedure")).rows[0].hash;
 assert.equal(originalHash,"1a6e4acce6d003d0a6ee53f9e08c4d5c");
 await f.recover();
 assert.deepEqual((await f.db.query('SELECT to_jsonb(d) AS data FROM "FirmaSeguroDraftDispatch" d WHERE "draftId"=3433')).rows[0].data,before);
 assert.deepEqual((await f.db.query('SELECT * FROM "FirmaSeguroDraft3433AdministrativeLog"')).rows,audit);
 await assert.rejects(f.db.exec('UPDATE "FirmaSeguroDraftDispatch" SET "lastError"=\'changed\' WHERE "draftId"=3433'),/IMMUTABLE/);
 for(const statement of schema) await f.db.exec(statement);
});



test("reservation write failure atomically restores the uncertain source and leaves no audit authorization",async t=>{
 const f=await fixture(t,{failReservation:true});
 await assert.rejects(f.recover());
 assert.equal((await f.rows()).length,1);assert.equal((await f.rows())[0].status,"UNCERTAIN");
 assert.equal((await f.audit()).length,0);
});
test("a verified subsequent ordinary correction remains allowed after recovery",async t=>{
 const f=await fixture(t),{replacementDispatchId}=await f.recover(),uuid=randomUUID();
 await f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'DISPATCHING\' WHERE "id"=$1',[replacementDispatchId]);
 await f.db.query(`INSERT INTO "FirmaSeguroDraftDispatchReceipt"
 ("dispatchId","processUuid","providerStatus","createPayload","source","evidence")
 VALUES($1,$2,'CREATED','{}','send_response','{}')`,[replacementDispatchId,uuid]);
 await f.db.query(`INSERT INTO "FirmaSeguroProcess"("processUuid","draftId","creditoId","draftFolio","draftPayload")
 SELECT $2,81,NULL,"draftFolio","draftPayload" FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1`,[replacementDispatchId,uuid]);
 await f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'AWAITING_SIGNATURE\',"processUuid"=$2 WHERE "id"=$1',[replacementDispatchId,uuid]);
 const next=randomUUID();
 await f.db.query(`INSERT INTO "FirmaSeguroDraftDispatch"
 ("id","draftId","actorUserId","actorName","reason","expectedProcessUuid","status","draftFolio",
 "sourcePayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash")
 SELECT $2,81,7,'Administrator','Audited ordinary correction',$3,'PREPARING',"draftFolio",
 "updatedPayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash"
 FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1`,[replacementDispatchId,next,uuid]);
 assert.equal((await f.rows()).length,3);
});




test("a verified terminal FAILED_SAFE source permits its ordinary audited correction",async t=>{
 const f=await fixture(t),{replacementDispatchId}=await f.recover(),uuid=randomUUID();
 await f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'DISPATCHING\' WHERE "id"=$1',[replacementDispatchId]);
 await f.db.query(`INSERT INTO "FirmaSeguroDraftDispatchReceipt"
 ("dispatchId","processUuid","providerStatus","createPayload","source","evidence")
 VALUES($1,$2,'EXPIRED','{}','send_response','{}')`,[replacementDispatchId,uuid]);
 await f.db.query(`INSERT INTO "FirmaSeguroProcess"("processUuid","draftId","creditoId","draftFolio","draftPayload","status")
 SELECT $2,81,NULL,"draftFolio","draftPayload",'EXPIRED' FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1`,[replacementDispatchId,uuid]);
 await f.db.query('UPDATE "FirmaSeguroDraftDispatch" SET "status"=\'FAILED_SAFE\',"processUuid"=$2 WHERE "id"=$1',[replacementDispatchId,uuid]);
 await f.db.query(`INSERT INTO "FirmaSeguroDraftDispatch"
 ("id","draftId","actorUserId","actorName","reason","expectedProcessUuid","status","draftFolio",
 "sourcePayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash")
 SELECT $2,81,7,'Administrator','Audited terminal correction',$3,'PREPARING',"draftFolio",
 "updatedPayload","updatedPayload","draftPayload","frozenCredit","documentBase64","documentHash"
 FROM "FirmaSeguroDraftDispatch" WHERE "id"=$1`,[replacementDispatchId,randomUUID(),uuid]);
 assert.equal((await f.rows()).length,3);
});
test("ordinary expiry may close a reserved draft while preserving all contract values",async t=>{
 const f=await fixture(t);await f.recover();
 // Advance the fixture's stored deadline to model elapsed wall time.
 await f.db.exec(`ALTER TABLE "CreditoBorrador" DISABLE TRIGGER "CreditoBorrador_administrative_recovery_freeze";
 UPDATE "CreditoBorrador" SET "expiresAt"=CURRENT_TIMESTAMP-INTERVAL '1 day';
 ALTER TABLE "CreditoBorrador" ENABLE TRIGGER "CreditoBorrador_administrative_recovery_freeze";`);
 await f.db.exec(`UPDATE "CreditoBorrador" SET "estado"='CERRADO',"closedReason"='EXPIRADA_15_DIAS',"closedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP`);
 const row=(await f.db.query('SELECT "estado","payload" FROM "CreditoBorrador" WHERE "id"=81')).rows[0];
 assert.equal(row.estado,"CERRADO");assert.deepEqual(row.payload,f.payload);
});

test("predeploy acquires both runtime schema locks before retaining any DDL lock",()=>{
 const installer=readFileSync(new URL("../scripts/ensure-firmaseguro-draft-dispatch-schema.mjs",import.meta.url),"utf8");
 const ddl=installer.indexOf("for (const statement of statements) await client.query(statement)");
 const adminLock=installer.indexOf('await client.query("SELECT pg_advisory_xact_lock(5843,20261022)")');
 const baseLock=installer.indexOf('await client.query("SELECT pg_advisory_xact_lock(5843,20261020)")');
 assert.ok(adminLock>=0 && baseLock>adminLock && ddl>baseLock,
  "DDL must not retain Receipt locks while waiting for either runtime schema lock");
});
