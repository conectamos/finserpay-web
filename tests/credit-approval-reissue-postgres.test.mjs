import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createReissueFixture, loadReissueModule, seals } from "./credit-approval-reissue-fixture.mjs";
import { installApprovalSharedSchema } from "../scripts/approval-shared-schema.mjs";
import { shared as sharedAccess, actorModule as sharedActorModule } from "./approval-shared-fixture.mjs";
import { installCreditApprovalSchema } from "../scripts/credit-approval-schema.mjs";
import { installCreditApprovalReissueSchema } from "../scripts/credit-approval-reissue-schema.mjs";

const connectionString = process.env.CREDIT_APPROVAL_REISSUE_TEST_DATABASE_URL;
test("PostgreSQL aislado: reemisión persistente, conservación, callbacks y concurrencia", {
  skip: connectionString ? false : "Requiere CREDIT_APPROVAL_REISSUE_TEST_DATABASE_URL local approval_reissue_test",
}, async t => {
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(url.hostname));
  assert.equal(url.pathname,"/approval_reissue_test");
  const pool = new pg.Pool({connectionString,max:8});
  const db = await pool.connect();
  t.after(async () => { db.release(); await pool.end(); });
  const tables = ["CreditApprovalSharedSession","CreditApprovalSharedGrant","CreditApprovalReissueEvent","CreditApprovalReissue","CreditApprovalEvent","CreditApprovalReview",
    "CreditApprovalPolicy","FirmaSeguroProcess","LiquidacionAliadoCredito","Credito","Usuario","Sede","Aliado"];
  const previous = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(previous.rows.every(row => tables.includes(row.tablename)),"No se borran tablas ajenas");
  for (const table of tables) await db.query('DROP TABLE IF EXISTS public."' + table + '" CASCADE');
  await db.query(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (1);
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY,"codigo" TEXT,"nombre" TEXT);
    INSERT INTO "Aliado" VALUES (10,'ALLY','Aliado prueba');
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER);
    INSERT INTO "Sede" VALUES (10,10);
    CREATE TABLE "Credito" (
      "id" INTEGER PRIMARY KEY,"folio" TEXT,"clienteNombre" TEXT,"clienteDocumento" TEXT,"clienteTelefono" TEXT,"clienteCorreo" TEXT,
      "clienteDireccion" TEXT,"fechaCredito" TIMESTAMP DEFAULT '2099-01-01',"createdAt" TIMESTAMP(3),"updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
      "estado" TEXT,"sedeId" INTEGER,"imei" TEXT,"deviceUid" TEXT,"referenciaEquipo" TEXT,"equipoMarca" TEXT,"equipoModelo" TEXT,
      "valorEquipoTotal" FLOAT,"cuotaInicial" FLOAT,"saldoBaseFinanciado" FLOAT,"montoCredito" FLOAT,"valorCuota" FLOAT,
      "plazoMeses" INTEGER,"tasaInteresEa" FLOAT,"frecuenciaPago" TEXT,
      "equalityService" TEXT,"contratoSnapshot" JSONB,
      "contratoCedulaFrenteDataUrl" TEXT,"contratoCedulaRespaldoDataUrl" TEXT,"iphoneSelfieCedulaDataUrl" TEXT,"fotoEntregaDataUrl" TEXT,"fotoRemisionDataUrl" TEXT
    );
    CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER UNIQUE REFERENCES "Credito"("id"));
    CREATE TABLE "FirmaSeguroProcess" (
      "id" SERIAL PRIMARY KEY,"creditoId" INTEGER,"draftId" INTEGER,"draftFolio" TEXT,"draftPayload" JSONB,"processUuid" TEXT UNIQUE,
      "status" TEXT,"requestPayload" JSONB,"createPayload" JSONB,"statusPayload" JSONB,"signaturesPayload" JSONB,"documentsPayload" JSONB,
      "signedDocumentBase64" TEXT,"signedDocumentFileName" TEXT,"lastError" TEXT,"completedAt" TIMESTAMP,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "supersededAt" TIMESTAMPTZ,"supersededByUserId" INTEGER,"supersededReason" TEXT
    );`);
  await installCreditApprovalSchema(db);
  await installCreditApprovalReissueSchema(db);
  await installApprovalSharedSchema(db);
  const activation = (await db.query('SELECT "activatedAt"::text FROM "CreditApprovalPolicy"')).rows[0].activatedAt;
  let afterQuery = null;
  const wrap = client => ({
    $queryRawUnsafe: async (sql,...args) => {
      const result = await client.query(sql,args);
      await afterQuery?.(sql,args);
      return result.rows;
    },
    $executeRawUnsafe: async (sql,...args) => (await client.query(sql,args)).rowCount,
  });
  const api = {
    ...wrap(pool),
    $transaction: async callback => {
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'America/Bogota'");
      try { const result = await callback(wrap(client)); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
  };
  class CreditApprovalError extends Error { constructor(code,message,status=400){super(message);this.code=code;this.status=status;} }
  const core = { CreditApprovalError, approvalPdf: value => {
    const bytes=Buffer.from(value||"","base64");return bytes.subarray(0,5).toString()==="%PDF-"?bytes:null;
  }};
  const state = loadReissueModule("lib/credit-approval-reissue-state.ts");
  const source = loadReissueModule("lib/credit-approval-reissue-source.ts", {"@/lib/credit-amortization-contract":seals});
  const guarded = loadReissueModule("lib/firmaseguro-credit.ts", {
    "@/lib/auth":{}, "@/lib/aliados":{}, "@/lib/credit-route-lookup":{}, "@/lib/firmaseguro":{},
    "@/lib/firmaseguro-folio-pdf":{}, "@/lib/firmaseguro-storage":{}, "@/lib/prisma":{default:api},
    "@/lib/roles":{}, "@/lib/seller-auth":{},
  });
  const historicStorage = loadReissueModule("lib/firmaseguro-storage.ts", {
    pg: {}, "@/lib/prisma": {default: {...api, $executeRawUnsafe: async () => 0}},
  });
  let sentCount=0,prepareFailure=false,sendFailure=false,gate=null,onSent=null;
  const provider = {
    prepareFirmaSeguroReissue: async () => {
      if(prepareFailure)throw new Error("no configuration");
      return { requestPayload:{safe:true}, sendOnce:async()=>{
        sentCount++;onSent?.();if(gate)await gate;if(sendFailure)throw new Error("result unknown");
        return {processUuid:"new-"+randomUUID(),status:"PENDING",createPayload:{ok:true}};
      }};
    },
    refreshFirmaSeguroProcess: async process => {
      await db.query('UPDATE "FirmaSeguroProcess" SET "status"=\'COMPLETED\',"signedDocumentBase64"=$2,"completedAt"=CURRENT_TIMESTAMP WHERE "processUuid"=$1',
        [process.processUuid,Buffer.from("%PDF-1.4\nNEW SIGNED\n%%EOF").toString("base64")]);
      await guarded.markCreditoFirmaSeguroCompleted(process.creditoId,{processUuid:process.processUuid,status:"COMPLETED"});
    },
  };
  const service = loadReissueModule("lib/credit-approval-reissue.ts", {
    "@/lib/prisma":{default:api},"@/lib/credit-approval":core,
    "@/lib/credit-approval-actor":loadReissueModule("lib/credit-approval-actor.ts"),
    "@/lib/firmaseguro-folio-pdf":{buildFirmaSeguroCreditPdf:async frozen => Buffer.from("%PDF-1.4\n"+JSON.stringify(frozen)+"\n%%EOF")},
    "@/lib/firmaseguro-credit":provider,"@/lib/credit-approval-reissue-source":source,
    "@/lib/credit-approval-reissue-state":state,"@/lib/firmaseguro":{isFirmaSeguroCompletedStatus:s=>s==="COMPLETED"},
  });
  const seed = async id => {
    const fixture=createReissueFixture(id);
    const credit={...fixture.credit};delete credit.eligible;delete credit.paid;
    const keys=Object.keys(credit);
    await db.query('INSERT INTO "Credito" ('+keys.map(k=>'"'+k+'"').join(",")+') VALUES ('+keys.map((_,i)=>"$"+(i+1)).join(",")+')',Object.values(credit));
    const process={...fixture.process};delete process.id;
    const pkeys=Object.keys(process);
    await db.query('INSERT INTO "FirmaSeguroProcess" ('+pkeys.map(k=>'"'+k+'"').join(",")+') VALUES ('+pkeys.map((_,i)=>"$"+(i+1)).join(",")+')',Object.values(process));
    return fixture;
  };
  const revision=async id=>(await db.query('SELECT "revision" FROM "CreditApprovalReview" WHERE "creditoId"=$1',[id])).rows[0].revision;
  const requestInput=async id=>({idempotencyKey:randomUUID(),expectedProcessUuid:"old-process-"+id,expectedRevision:await revision(id),reason:"La firma no es legible"});
  const approve=id=>db.query(`UPDATE "CreditApprovalReview" SET "status"='APPROVED',"approvedRevision"="revision",
    "approvedByUserId"=1,"approvedByName"='Analista prueba',"approvedAt"=CURRENT_TIMESTAMP,"reviewHash"=$2 WHERE "creditoId"=$1`,[id,"a".repeat(64)]);
  const actor={id:1,nombre:"Analista prueba"};

  await t.test("doble clic, bloqueo SQL, ACK tardío y callback antiguo conservan el histórico",async()=>{
    const f=await seed(81),request=await requestInput(81);let release;
    gate=new Promise(resolve=>{release=resolve;});
    const started=new Promise(resolve=>{onSent=resolve;});
    const running=service.requestCreditApprovalReissue(81,request,actor);
    await started;
    assert.equal((await state.getCreditApprovalReissueState(api,81)).operation.status,"DISPATCHING");
    await assert.rejects(approve(81),/SIGNATURE_REISSUE_PENDING/);
    await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoCredito"("creditoId") VALUES (81)'),/SIGNATURE_REISSUE_PENDING|CREDIT_APPROVAL_REQUIRED/);
    await service.requestCreditApprovalReissue(81,request,actor);
    assert.equal(sentCount,1);
    await assert.rejects(service.requestCreditApprovalReissue(81,{...request,idempotencyKey:randomUUID()},actor),e=>e.status===409);
    await db.query('UPDATE "CreditApprovalReissue" SET "updatedAt"=CURRENT_TIMESTAMP-INTERVAL \'3 minutes\' WHERE "id"=$1',[request.idempotencyKey]);
    assert.equal((await service.refreshCreditApprovalReissue(81,request.idempotencyKey)).operation.status,"UNCERTAIN");
    release();await running;gate=null;onSent=null;
    const waiting=await state.getCreditApprovalReissueState(api,81);
    assert.equal(waiting.operation.status,"AWAITING_SIGNATURE","Late ACK is retained without another POST");
    assert.equal((await db.query(`SELECT ABS(EXTRACT(EPOCH FROM ("createdAt"-(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))<10 utc FROM "FirmaSeguroProcess" WHERE "creditoId"=81 AND "supersededAt" IS NULL`)).rows[0].utc,true,"New process timestamps use UTC even with a Bogota database session");
    const before=(await db.query('SELECT "contratoSnapshot" FROM "Credito" WHERE "id"=81')).rows[0].contratoSnapshot;
    await guarded.markCreditoFirmaSeguroCompleted(81,{processUuid:f.process.processUuid,status:"COMPLETED"});
    assert.deepEqual((await db.query('SELECT "contratoSnapshot" FROM "Credito" WHERE "id"=81')).rows[0].contratoSnapshot,before);
    const completed=await service.refreshCreditApprovalReissue(81,request.idempotencyKey);
    assert.equal(completed.operation.status,"COMPLETED");
    assert.equal(completed.blocked,false);
    assert.deepEqual((await db.query('SELECT "contratoSnapshot" FROM "Credito" WHERE "id"=81')).rows[0].contratoSnapshot,before);
    assert.equal((await db.query('SELECT "signedDocumentBase64" FROM "FirmaSeguroProcess" WHERE "processUuid"=$1',[f.process.processUuid])).rows[0].signedDocumentBase64,f.signedPdf);
    await service.requestCreditApprovalReissue(81,request,actor);
    assert.equal(sentCount,1);
    await assert.rejects(db.query('UPDATE "FirmaSeguroProcess" SET "signedDocumentBase64"=\'changed\' WHERE "processUuid"=$1',[f.process.processUuid]),/REISSUE_ORIGINAL_IMMUTABLE/);
    await assert.rejects(db.query('DELETE FROM "CreditApprovalReissueEvent" WHERE "operationId"=$1',[request.idempotencyKey]),/IMMUTABLE/);
    await assert.rejects(db.query('UPDATE "CreditApprovalReissue" SET "originalDocumentHash"=$2 WHERE "id"=$1',[request.idempotencyKey,"b".repeat(64)]),/IMMUTABLE/);
    await approve(81);
    const approvedRevision = await revision(81);
    await historicStorage.updateFirmaSeguroProcess(f.process.processUuid, {status:"CALLBACK",
      statusPayload:{event:"late callback"},signedDocumentBase64:Buffer.from("%PDF-1.4 historical replacement").toString("base64")});
    assert.equal(await revision(81),approvedRevision,"A historical callback never invalidates the current OK");
    assert.equal((await db.query('SELECT "status" FROM "CreditApprovalReview" WHERE "creditoId"=81')).rows[0].status,"APPROVED");
    await db.query('INSERT INTO "LiquidacionAliadoCredito"("creditoId") VALUES (81)');
    await assert.rejects(service.requestCreditApprovalReissue(81,{...request,idempotencyKey:randomUUID()},actor),e=>e.status===409);
  });
  await t.test("resultado incierto nunca repite automáticamente ni libera liquidación",async()=>{
    await seed(82);const request=await requestInput(82);sendFailure=true;
    const before=sentCount;
    const failed=await service.requestCreditApprovalReissue(82,request,actor);
    assert.equal(failed.operation.status,"UNCERTAIN");assert.equal(failed.blocked,true);
    await service.requestCreditApprovalReissue(82,request,actor);assert.equal(sentCount,before+1);
    await assert.rejects(service.requestCreditApprovalReissue(82,{...request,idempotencyKey:randomUUID()},actor),e=>e.status===409);
    await assert.rejects(approve(82),/SIGNATURE_REISSUE_PENDING/);
    sendFailure=false;
  });
  await t.test("fallo previo al envío permite solo otro intento explícito y audita ambos",async()=>{
    await seed(83);prepareFailure=true;const request=await requestInput(83),before=sentCount;
    assert.equal((await service.requestCreditApprovalReissue(83,request,actor)).operation.status,"FAILED_SAFE");
    assert.equal(sentCount,before);prepareFailure=false;
    assert.equal((await service.requestCreditApprovalReissue(83,await requestInput(83),actor)).operation.status,"AWAITING_SIGNATURE");
    assert.equal(sentCount,before+1);
  });
  await t.test("términos cambiados y contratos históricos se rechazan antes de reservar o enviar",async()=>{
    await seed(84);await db.query('UPDATE "Credito" SET "montoCredito"="montoCredito"+1000 WHERE "id"=84');
    await assert.rejects(service.requestCreditApprovalReissue(84,await requestInput(84),actor),e=>e.code==="FROZEN_TERMS_UNAVAILABLE");
    await seed(85);await db.query('UPDATE "Credito" SET "createdAt"=\'2020-01-01\' WHERE "id"=85');
    await assert.rejects(service.requestCreditApprovalReissue(85,await requestInput(85),actor),e=>e.status===409);
    assert.equal((await db.query('SELECT COUNT(*)::integer count FROM "CreditApprovalReissue" WHERE "creditoId" IN (84,85)')).rows[0].count,0);
  });
  await t.test("varias firmas vigentes se rechazan sin alterar originales ni enviar",async()=>{
    const f=await seed(86);const before=sentCount;
    await db.query(`INSERT INTO "FirmaSeguroProcess"("creditoId","processUuid","createdAt","status","signedDocumentBase64","completedAt") VALUES (86,'ambiguous-process','2100-01-01','COMPLETED',$1,CURRENT_TIMESTAMP)`,[f.signedPdf]);
    const input={...await requestInput(86),expectedProcessUuid:"ambiguous-process"};
    await assert.rejects(service.requestCreditApprovalReissue(86,input,actor),e=>e.code==="SIGNATURE_VERSION_AMBIGUOUS");
    assert.equal(sentCount,before);
    assert.equal((await db.query('SELECT COUNT(*)::integer count FROM "FirmaSeguroProcess" WHERE "creditoId"=86 AND "supersededAt" IS NULL')).rows[0].count,2);
  });
  await t.test("callback concurrente espera Crédito antes de la fila de firma y no pierde el ACK",async()=>{
    const f=await seed(87),input=await requestInput(87),before=sentCount;
    let releaseBinding,enteredBinding,armed=false;
    const bindingHold=new Promise(resolve=>{releaseBinding=resolve;});
    const bindingEntered=new Promise(resolve=>{enteredBinding=resolve;});
    onSent=()=>{armed=true;};
    afterQuery=async sql=>{
      if(armed && sql.includes('FROM "CreditApprovalReview"') && sql.includes('FOR UPDATE')){
        armed=false;enteredBinding();await bindingHold;
      }
    };
    const request=service.requestCreditApprovalReissue(87,input,actor);
    await bindingEntered;
    const callback=historicStorage.updateFirmaSeguroProcess(f.process.processUuid,{status:"SIGNED",statusPayload:{event:"concurrent callback"}});
    try {
      let waiting=false;
      for(let attempt=0;attempt<100 && !waiting;attempt++){
        const rows=await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE 'SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE%'`);
        waiting=rows.rows.length>0;
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true,"The callback waits on Credit, without taking the process row first");
    } finally { releaseBinding(); }
    const [completedRequest,updatedOriginal]=await Promise.all([request,callback]);
    afterQuery=null;onSent=null;
    assert.equal(completedRequest.operation.status,"AWAITING_SIGNATURE");
    assert.equal(sentCount,before+1,"Provider POST is never repeated");
    assert.equal(updatedOriginal.status,"COMPLETED");
    assert.equal(updatedOriginal.signedDocumentBase64,f.signedPdf);
    const operation=(await db.query('SELECT "newProcessUuid","status" FROM "CreditApprovalReissue" WHERE "id"=$1',[input.idempotencyKey])).rows[0];
    assert.ok(operation.newProcessUuid);
    assert.equal(operation.status,"AWAITING_SIGNATURE");
    assert.equal((await db.query('SELECT "processUuid" FROM "FirmaSeguroProcess" WHERE "creditoId"=87 AND "supersededAt" IS NULL')).rows[0].processUuid,operation.newProcessUuid);
  });
  await t.test("reemisión compartida audita grant y sesión y conserva ACK aun si revocan tras el POST",async()=>{
    await seed(89);const input=await requestInput(89),before=sentCount;
    const grant=await api.$transaction(tx=>sharedAccess.changeSharedApprovalLink(tx,1,null,"https://example.invalid"));
    const access=await api.$transaction(tx=>sharedAccess.exchangeSharedApprovalLink(tx,new URL(grant.accessUrl).hash.slice(8)));
    const sharedActor={kind:"SHARED_LINK",id:null,nombre:"Acceso compartido",grantId:access.grantId,sessionId:access.sessionId};
    let release;gate=new Promise(resolve=>{release=resolve;});
    const started=new Promise(resolve=>{onSent=resolve;});
    const running=service.requestCreditApprovalReissue(89,input,sharedActor);
    await started;
    await api.$transaction(tx=>sharedAccess.changeSharedApprovalLink(tx,1,grant.grantId,"https://example.invalid",true));
    await assert.rejects(api.$transaction(tx=>sharedActorModule.assertApprovalActorActive(tx,sharedActor)),error=>error.status===401);
    release();const result=await running;gate=null;onSent=null;
    assert.equal(result.operation.status,"AWAITING_SIGNATURE");assert.equal(sentCount,before+1);
    const audit=(await db.query('SELECT "requestedByUserId","requestedByName","requestedByKind","requestedByGrantId","requestedBySessionId","newProcessUuid" FROM "CreditApprovalReissue" WHERE "id"=$1',[input.idempotencyKey])).rows[0];
    assert.equal(audit.requestedByUserId,null);assert.equal(audit.requestedByName,"Acceso compartido");assert.equal(audit.requestedByKind,"SHARED_LINK");assert.equal(audit.requestedByGrantId,grant.grantId);assert.equal(audit.requestedBySessionId,access.sessionId);assert.ok(audit.newProcessUuid);
  });
  await t.test("instalación repetible agrega checks Prisma-first y conserva corte/UTC",async()=>{
    const constraints=await db.query(`SELECT conname FROM pg_constraint WHERE conrelid='public."CreditApprovalReissue"'::regclass AND contype='c'`);
    for(const {conname} of constraints.rows)await db.query('ALTER TABLE "CreditApprovalReissue" DROP CONSTRAINT "'+conname+'"');
    await db.query(`ALTER TABLE "CreditApprovalReissue" ALTER COLUMN "requestedAt" SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE "CreditApprovalReissueEvent" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP`);
    await installCreditApprovalReissueSchema(db);
    assert.equal((await db.query('SELECT "activatedAt"::text FROM "CreditApprovalPolicy"')).rows[0].activatedAt,activation);
    const installed=await db.query(`SELECT conname FROM pg_constraint WHERE conrelid='public."CreditApprovalReissue"'::regclass AND contype='c'`);
    assert.equal(installed.rows.length,9);
    await seed(88);
    await assert.rejects(db.query(`INSERT INTO "CreditApprovalReissue"
      ("id","creditoId","previousProcessUuid","sourceRevision","reason","requestedByUserId","requestedByName",
       "frozenCredit","originalContractSnapshot","originalSignedDocumentBase64","originalDocumentHash","sourceTermsHash",
       "documentBase64","documentHash","status")
      SELECT $1::uuid,88,'old-process-88',1,'Firma ilegible',1,'Analista prueba',
        "frozenCredit","originalContractSnapshot","originalSignedDocumentBase64","originalDocumentHash","sourceTermsHash",
        'JVBERi0=',NULL,'PREPARING' FROM "CreditApprovalReissue" WHERE "creditoId"=81 LIMIT 1`,[randomUUID()]),
      error=>error.code==="23514" && error.constraint==="CreditApprovalReissue_document_check",
      "Prisma-first tables reject a PDF with a null hash instead of accepting SQL UNKNOWN");
    const times=await db.query(`SELECT ABS(EXTRACT(EPOCH FROM ("createdAt"-(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))<60 utc FROM "CreditApprovalReissueEvent"`);
    assert.ok(times.rows.every(row=>row.utc));
  });
});
