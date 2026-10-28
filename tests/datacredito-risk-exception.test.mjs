import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
const require=createRequire(import.meta.url);
const jiti=createJiti(import.meta.url,{alias:{"@":fileURLToPath(new URL("..",import.meta.url))}});
const policyModule=await jiti.import('../lib/datacredito/policy.ts');
const termsModule=await jiti.import('../lib/credit-current-origination-terms.ts');
const code=readFileSync(new URL('../lib/datacredito/risk-exception.ts',import.meta.url),'utf8');
const setup=readFileSync(new URL('../scripts/setup-datacredito.sql',import.meta.url),'utf8');
const schema=setup.slice(setup.indexOf('-- BEGIN SINGLE CASE INTERNAL RISK EXCEPTION'),setup.indexOf('-- END SINGLE CASE INTERNAL RISK EXCEPTION'));
const sourceId='4d14cb36-dec9-4b08-9532-ed0739bdcbc4';
const revision='11111111-1111-4111-8111-111111111111';
const profile='22222222-2222-4222-8222-222222222222';
const offerSettings=policyModule.DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS;
const prismaSchema=readFileSync(new URL('../prisma/schema.prisma',import.meta.url),'utf8');
const solicitudStorage=readFileSync(new URL('../lib/solicitudes-storage.ts',import.meta.url),'utf8');
const firmaStorage=readFileSync(new URL('../lib/firmaseguro-storage.ts',import.meta.url),'utf8');
function realScalarColumns(table){
 const model=prismaSchema.match(new RegExp(`^model ${table} \\{([\\s\\S]*?)^\\}`,'m'));
 if(model)return new Set([...model[1].matchAll(/^\s+(\w+)\s+(?:String|Int|BigInt|Float|Boolean|DateTime|Json|Decimal|Bytes)\??(?:\s|$)/gm)].map(m=>m[1]));
 const ddlSource=table==='DataCreditoAssessment'?setup:table==='CreditoBorrador'?solicitudStorage:firmaStorage;
 const block=ddlSource.match(new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(([\\s\\S]*?)\\n\\s*\\)`));
 assert.ok(block,`No official DDL for ${table}`);
 const names=new Set([...block[1].matchAll(/^\s*"([^"]+)"\s+/gm)].map(m=>m[1]));
 if(table==='CreditoBorrador'){
  for(const source of [solicitudStorage,setup])for(const m of source.matchAll(/ADD COLUMN IF NOT EXISTS "([^"]+)"/g))names.add(m[1]);
 }
 return names;
}
async function assertFixtureMatchesRealSchema(pg){
 const tables=['Rol','Aliado','Sede','Usuario','DataCreditoPolicyProfile','DataCreditoPolicyRevision','CreditoBorrador','DataCreditoAssessment','FirmaSeguroProcess','Credito','CreditoAbono'];
 const columns=(await pg.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`,[tables])).rows;
 const expected=new Map(tables.map(table=>[table,realScalarColumns(table)]));
 for(const column of columns)assert.ok(expected.get(column.table_name).has(column.column_name),`Fixture inventa ${column.table_name}.${column.column_name}; debe coincidir con Prisma/DDL real`);
}
async function fixture(){
 const pg=new PGlite();
 await pg.exec(`
 CREATE TABLE "Rol"("id" integer PRIMARY KEY,"nombre" text);
 CREATE TABLE "Aliado"("id" integer PRIMARY KEY,"codigo" text,"activo" boolean DEFAULT TRUE,"dataCreditoPolicyId" uuid);
 CREATE TABLE "Sede"("id" integer PRIMARY KEY,"aliadoId" integer,"activa" boolean DEFAULT TRUE);
 CREATE TABLE "Usuario"("id" integer PRIMARY KEY,"rolId" integer,"sedeId" integer,"activo" boolean DEFAULT TRUE);
 CREATE TABLE "DataCreditoPolicyProfile"("id" uuid PRIMARY KEY,"active" boolean DEFAULT TRUE);
 CREATE TABLE "DataCreditoPolicyRevision"("id" uuid PRIMARY KEY,"profileId" uuid,"version" integer);
 CREATE TABLE "CreditoBorrador"("id" integer PRIMARY KEY,"estado" text DEFAULT 'ABIERTO',"creditoId" integer,"usuarioId" integer,"vendedorId" integer,"sedeId" integer,"clienteDocumento" text,"plataforma" text,"dataCreditoAssessmentId" uuid,"dataCreditoStatus" text,"dataCreditoErrorCode" text,"payload" jsonb DEFAULT '{}',"expiresAt" timestamptz DEFAULT CURRENT_TIMESTAMP+INTERVAL '10 days',"createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP,"updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE "DataCreditoAssessment"("id" uuid PRIMARY KEY,"documentHash" text,"surnameHash" text,"platform" text,"providerEnvironment" text,"userId" integer,"sellerId" integer,"sedeId" integer,"aliadoId" integer,"status" text,"errorCode" text,"providerStatus" text,"transactionCode" text,"policyVersion" integer DEFAULT 3,"policyRevisionId" uuid DEFAULT '11111111-1111-4111-8111-111111111111',"score" integer,"decision" text,"offer" jsonb,"reusedFromAssessmentId" uuid,"consumedAt" timestamptz,"creditId" integer,"claimTokenHash" text,"claimExpiresAt" timestamptz,"expiresAt" timestamptz DEFAULT CURRENT_TIMESTAMP+INTERVAL '8 days',"retainedUntil" timestamptz DEFAULT CURRENT_TIMESTAMP+INTERVAL '90 days');
 CREATE TABLE "FirmaSeguroProcess"("id" integer PRIMARY KEY,"draftId" integer);
 CREATE TABLE "Credito"("id" integer PRIMARY KEY,"estado" text DEFAULT 'GENERADO',"clienteDocumento" text,"usuarioId" integer,"sedeId" integer,"montoCredito" numeric DEFAULT 1000000);
 CREATE TABLE "CreditoAbono"("creditoId" integer,"valor" numeric,"estado" text);
 INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'USUARIO');
 INSERT INTO "Aliado" VALUES(1,'FINSERPAY',TRUE,NULL),(2,'ALIADO',TRUE,'${profile}');
 INSERT INTO "Sede" VALUES(1,1,TRUE),(3,2,TRUE);
 INSERT INTO "Usuario" VALUES(1,1,1,TRUE),(2,2,3,TRUE);
 INSERT INTO "DataCreditoPolicyProfile" VALUES('${profile}',TRUE);
 INSERT INTO "DataCreditoPolicyRevision" VALUES('${revision}','${profile}',3);
 INSERT INTO "DataCreditoAssessment"("id","documentHash","surnameHash","platform","providerEnvironment","userId","sellerId","sedeId","aliadoId","status","errorCode","providerStatus","transactionCode") VALUES('${sourceId}','document:1234567','surname:PRUEBA','IPHONE','production',2,NULL,3,2,'NO_EVALUADO','NO_EVALUABLE_INFORMATION','ACCEPTED','07');
 INSERT INTO "CreditoBorrador"("id","usuarioId","sedeId","clienteDocumento","plataforma","dataCreditoAssessmentId","dataCreditoStatus","dataCreditoErrorCode") VALUES(4098,2,3,'1234567','IPHONE','${sourceId}','NO_EVALUADO','NO_EVALUABLE_INFORMATION');
 `);
 await pg.exec(schema);
 await assertFixtureMatchesRealSchema(pg);
 const calls=[];
 const db={
  $queryRawUnsafe:async(sql,...args)=>{calls.push(sql);return (await pg.query(sql,args)).rows},
  $executeRawUnsafe:async(sql,...args)=>{calls.push(sql);return (await pg.query(sql,args)).affectedRows},
  $transaction:async callback=>{await pg.exec('BEGIN');try{const result=await callback(db);await pg.exec('COMMIT');return result;}catch(e){await pg.exec('ROLLBACK');throw e;}}
 };
 const policy={version:3,profileId:profile,revisionId:revision,financialSettings:offerSettings,bands:[{id:'none-iphone',platform:'IPHONE',scoreMin:-1,scoreMax:-1,decision:'APROBADO',initialPaymentPercentage:20,suretyPercentage:0,maxFinancedAmount:3500000,installmentCount:48,maxInstallmentAmount:160000}]};
 const savedSource={documentNumber:'1234567',firstSurname:'PRUEBA',providerPayload:{status:'ACCEPTED',content:{infoTransaccion:{codigosRespuesta:[{clave:'HC',valor:'09'},{clave:'TX',valor:'07'}]},respuesta:{}}}};
 const match={solicitudId:4098,assessmentId:sourceId,documentNumber:'1234567',firstSurname:'PRUEBA',platform:'IPHONE',providerEnvironment:'production',userId:2,sellerId:null,sedeId:3,aliadoId:2};
 const getRow=async id=>(await db.$queryRawUnsafe('SELECT * FROM "DataCreditoAssessment" WHERE "id"=$1::uuid',id))[0]??null;
 const storage={ensureDataCreditoSchema:async()=>{},normalizeDataCreditoDocument:v=>String(v||'').replace(/\D/g,''),hmacDataCreditoValue:(label,value)=>`${label}:${value}`,buildDataCreditoIdentityHashes:i=>({documentHash:`document:${i.documentNumber}`,surnameHash:`surname:${i.firstSurname}`,documentLast4:i.documentNumber.slice(-4)}),dataCreditoAssessmentMatchesScope:()=>true,getDataCreditoAssessmentById:getRow,readDataCreditoIdentitySource:async()=>savedSource,getAssignedDataCreditoPolicy:async()=>({kind:'READY',policy}),getApprovedDataCreditoAssessmentForCredit:async i=>{const row=await getRow(i.assessmentId);return row?.status==='APROBADO'?row:null;}};
 let blocked=false;
 const loaded={exports:{}};
 runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:loaded,exports:loaded.exports,require:name=>{
  if(name==='server-only')return{};
  if(name==='@/lib/prisma')return{default:db};
  if(name==='@/lib/document-blacklist')return{assertDocumentNotBlacklisted:async()=>{if(blocked)throw Error('DOCUMENT_BLACKLISTED')}};
  if(name==='./storage')return storage;
  if(name==='./policy')return policyModule;
  if(name==='@/lib/credit-current-origination-terms')return termsModule;
  return require(name);
 },Date,Number,String,Array,Object,Set,JSON,Buffer,Error,RegExp,console});
 const grant={solicitudId:4098,assessmentId:sourceId,documentNumber:'1234567',actorUserId:1,reason:'Autorización interna de prueba sin puntaje disponible',riskAcknowledged:true,mutationId:randomUUID()};
 return{pg,db,calls,policy,savedSource,match,grant,operations:loaded.exports,getRow,setBlacklisted:value=>{blocked=value}};
}
test('autoriza sólo el caso y conserva la respuesta, cupo y oferta original nulos; snapshot y auditoría inmutables',async()=>{
 const f=await fixture();try{
  const before=await f.getRow(sourceId);
  const granted=await f.operations.createSingleCaseCreditRiskException(f.grant);
  assert.equal(granted.idempotent,false);assert.equal(granted.exception.offer.maxFinancedAmount,3500000);
  assert.equal(granted.exception.policyVersion,3);assert.equal(granted.exception.historyCode,'09');
  assert.deepEqual(await f.getRow(sourceId),before);
  const d=(await f.pg.query('SELECT * FROM "CreditoBorrador" WHERE "id"=4098')).rows[0];
  assert.equal(d.creditRiskExceptionId,granted.exception.id);assert.equal(d.payload.creditAuthorizationSource,'INTERNAL_EXCEPTION');assert.equal(d.dataCreditoStatus,'NO_EVALUADO');
  const repeated=await f.operations.createSingleCaseCreditRiskException(f.grant);assert.equal(repeated.idempotent,true);assert.equal(repeated.exception.id,granted.exception.id);
  const authorization=await f.operations.getCreditRiskAuthorizationForDraft(f.match);
  assert.equal(authorization.source,'INTERNAL_EXCEPTION');assert.equal(authorization.assessment.status,'NO_EVALUADO');assert.equal(authorization.assessment.score,null);assert.equal(authorization.assessment.offer,null);
  assert.equal(authorization.offer.maxFinancedAmount,3500000);assert.equal(authorization.exceptionId,granted.exception.id);
  await assert.rejects(f.pg.query('UPDATE "CreditRiskException" SET "offer"=$2 WHERE "id"=$1',[granted.exception.id,JSON.stringify({...granted.exception.offer,maxFinancedAmount:9999999})]),/immutable/);
  await assert.rejects(f.pg.query('DELETE FROM "CreditRiskExceptionAudit"'),/immutable/);
  assert.equal((await f.pg.query('SELECT COUNT(*)::int AS n FROM "CreditRiskExceptionAudit"')).rows[0].n,1);
 }finally{await f.pg.close()}
});
test('rechaza otros casos, actor no central, riesgo no aceptado, HC distinto, score presente y fuente alterada',async()=>{
 for(const variant of ['other-draft','other-assessment','no-risk-ack','wrong-actor','hc','score','source-document','signed','closed','blacklist','reject-band','no-settings','inactive-profile','policy-drift','inactive-central-site','inactive-central-user','inactive-central-ally']){
  const f=await fixture();try{
   const input={...f.grant};
   if(variant==='other-draft')input.solicitudId=4078;
   if(variant==='other-assessment')input.assessmentId=randomUUID();
   if(variant==='no-risk-ack')input.riskAcknowledged=false;
   if(variant==='wrong-actor')input.actorUserId=2;
   if(variant==='hc')f.savedSource.providerPayload.content.infoTransaccion.codigosRespuesta[0].valor='14';
   if(variant==='score')await f.pg.exec(`UPDATE "DataCreditoAssessment" SET "score"=0`);
   if(variant==='source-document')f.savedSource.documentNumber='7654321';
   if(variant==='signed')await f.pg.exec('INSERT INTO "FirmaSeguroProcess" VALUES(1,4098)');
   if(variant==='closed')await f.pg.exec(`UPDATE "CreditoBorrador" SET "estado"='CERRADO'`);
   if(variant==='blacklist')f.setBlacklisted(true);
   if(variant==='reject-band')f.policy.bands[0].decision='RECHAZADO';
   if(variant==='no-settings')f.policy.financialSettings=null;
   if(variant==='inactive-profile')await f.pg.exec('UPDATE "DataCreditoPolicyProfile" SET "active"=FALSE');
   if(variant==='policy-drift')await f.pg.query('INSERT INTO "DataCreditoPolicyRevision" VALUES($1,$2,4)',[randomUUID(),profile]);
   if(variant==='inactive-central-site')await f.pg.exec('UPDATE "Sede" SET "activa"=FALSE WHERE "id"=1');
   if(variant==='inactive-central-user')await f.pg.exec('UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=1');
   if(variant==='inactive-central-ally')await f.pg.exec('UPDATE "Aliado" SET "activo"=FALSE WHERE "id"=1');
   await assert.rejects(f.operations.createSingleCaseCreditRiskException(input),undefined,variant);
   assert.equal((await f.pg.query('SELECT COUNT(*)::int AS n FROM "CreditRiskException"')).rows[0].n,0,variant);
  }finally{await f.pg.close()}
 }
});
test('lectura autoritativa rechaza documento, alcance, solicitud, proveedor, campos forjados y revocación/vencimiento',async()=>{
 const f=await fixture();try{
  const {exception}=await f.operations.createSingleCaseCreditRiskException(f.grant);
  for(const change of [{documentNumber:'7654321'},{firstSurname:'OTRO'},{solicitudId:4078},{assessmentId:randomUUID()},{userId:999},{sellerId:999},{sedeId:99},{aliadoId:99},{platform:'ANDROID'},{providerEnvironment:'uat'}]){
   assert.equal(await f.operations.getActiveCreditRiskExceptionForDraft({...f.match,...change}),null,JSON.stringify(change));
  }
  await f.pg.exec(`UPDATE "CreditoBorrador" SET "payload"='{"creditRiskExceptionId":"${randomUUID()}"}'`);
  assert.equal((await f.operations.getActiveCreditRiskExceptionForDraft(f.match)).id,exception.id,'payload cannot replace authoritative column');
  await f.pg.exec(`UPDATE "CreditoBorrador" SET "creditRiskExceptionId"=NULL`);
  assert.equal(await f.operations.getActiveCreditRiskExceptionForDraft(f.match),null);
  await f.pg.query('UPDATE "CreditoBorrador" SET "creditRiskExceptionId"=$1',[exception.id]);
  await f.pg.exec(`UPDATE "DataCreditoAssessment" SET "expiresAt"=CURRENT_TIMESTAMP-INTERVAL '1 second'`);
  assert.equal(await f.operations.getActiveCreditRiskExceptionForDraft(f.match),null);
  await f.pg.exec(`UPDATE "DataCreditoAssessment" SET "expiresAt"=CURRENT_TIMESTAMP+INTERVAL '1 day'`);
  await f.pg.exec(`UPDATE "CreditRiskException" SET "revokedAt"=CURRENT_TIMESTAMP`);
  assert.equal(await f.operations.getActiveCreditRiskExceptionForDraft(f.match),null);
 }finally{await f.pg.close()}
});
test('reserva, libera y consume una sola vez; no crea aprobación de proveedor ni acepta tokens/scope distintos',async()=>{
 const f=await fixture();try{
  const {exception}=await f.operations.createSingleCaseCreditRiskException(f.grant);
  const input={...f.match,exceptionId:exception.id,actorUserId:1};
  const claim=await f.operations.claimCreditRiskException(input);assert.ok(claim?.claimToken);
  assert.equal(await f.operations.claimCreditRiskException(input),null);
  await f.operations.releaseCreditRiskException({...input,claimToken:'wrong'});
  assert.equal(await f.operations.claimCreditRiskException(input),null);
  await f.operations.releaseCreditRiskException({...input,userId:999,claimToken:claim.claimToken});
  assert.equal(await f.operations.claimCreditRiskException(input),null,'wrong scope cannot release a claim');
  await f.operations.releaseCreditRiskException({...input,claimToken:claim.claimToken});
  const claim2=await f.operations.claimCreditRiskException(input);assert.ok(claim2);
  await f.pg.exec(`INSERT INTO "Credito"("id","clienteDocumento","usuarioId","sedeId") VALUES(100,'1234567',2,3)`);
  assert.equal(await f.db.$transaction(tx=>f.operations.consumeCreditRiskException({...input,claimToken:'wrong',creditId:100},tx)),false);
  assert.equal(await f.db.$transaction(tx=>f.operations.consumeCreditRiskException({...input,claimToken:claim2.claimToken,creditId:100},tx)),true);
  assert.equal(await f.db.$transaction(tx=>f.operations.consumeCreditRiskException({...input,claimToken:claim2.claimToken,creditId:100},tx)),false);
  await f.operations.releaseCreditRiskException({...input,claimToken:claim2.claimToken});
  const row=(await f.pg.query('SELECT * FROM "CreditRiskException"')).rows[0];assert.equal(row.creditId,100);assert.ok(row.consumedAt);assert.equal(row.claimTokenHash,null);
  const original=await f.getRow(sourceId);assert.equal(original.status,'NO_EVALUADO');assert.equal(original.score,null);assert.equal(original.consumedAt,null);assert.equal(original.creditId,null);
  assert.deepEqual((await f.pg.query('SELECT "action" FROM "CreditRiskExceptionAudit" ORDER BY "id"')).rows.map(r=>r.action),['AUTHORIZED','CLAIMED','RELEASED','CLAIMED','CONSUMED']);
 }finally{await f.pg.close()}
});
test('una reserva, rechazo vigente o consumo ordinario impide usar la excepción; no omite competencia documental',async()=>{
 for(const state of ['CLAIM','REJECT','CONSUMED']){
  const f=await fixture();try{
   const {exception}=await f.operations.createSingleCaseCreditRiskException(f.grant);
   const competing=randomUUID();
   await f.pg.query(`INSERT INTO "DataCreditoAssessment"("id","documentHash","surnameHash","platform","providerEnvironment","userId","sedeId","aliadoId","status","score","offer") VALUES($1,'document:1234567','surname:PRUEBA','IPHONE','production',2,3,2,$2,800,'{}')`,[competing,state==='REJECT'?'RECHAZADO':'APROBADO']);
   if(state==='CLAIM')await f.pg.query(`UPDATE "DataCreditoAssessment" SET "claimTokenHash"='occupied',"claimExpiresAt"=CURRENT_TIMESTAMP+INTERVAL '1 minute' WHERE "id"=$1`,[competing]);
   if(state==='CONSUMED'){await f.pg.exec(`INSERT INTO "Credito"("id","clienteDocumento","usuarioId","sedeId") VALUES(101,'1234567',2,3)`);await f.pg.query(`UPDATE "DataCreditoAssessment" SET "consumedAt"=CURRENT_TIMESTAMP,"creditId"=101 WHERE "id"=$1`,[competing]);}
   assert.equal(await f.operations.claimCreditRiskException({...f.match,exceptionId:exception.id}),null,state);
  }finally{await f.pg.close()}
 }
});
test('no hay consultas pagadas ni mutación del resultado del proveedor y el esquema es repetible',async()=>{
 const f=await fixture();try{await f.pg.exec(schema);await f.operations.createSingleCaseCreditRiskException(f.grant);assert.ok(!f.calls.some(sql=>/UPDATE\s+"DataCreditoAssessment"|DataCreditoDailyQuotaUsage/i.test(sql)));assert.doesNotMatch(code,/queryDataCreditoNaturalPerson|resolveDataCreditoDecision\(/);}
 finally{await f.pg.close()}
});
test('una aprobación ordinaria conserva su fuente y admite vínculo histórico sólo en payload',async()=>{
 const f=await fixture();try{
  const offer=f.operations.buildInternalExceptionOffer(f.policy,'IPHONE');
  await f.pg.query(`UPDATE "DataCreditoAssessment" SET "status"='APROBADO',"score"=800,"decision"='APROBADO',"offer"=$1`,[JSON.stringify(offer)]);
  const normal=await f.operations.getCreditRiskAuthorizationForDraft(f.match);
  assert.equal(normal.source,'DATACREDITO');assert.equal(normal.exceptionId,null);assert.equal(normal.assessment.status,'APROBADO');
  await f.pg.exec(`UPDATE "CreditoBorrador" SET "dataCreditoAssessmentId"=NULL,"payload"='{"dataCreditoAssessmentId":"${sourceId}"}'`);
  assert.equal((await f.operations.getCreditRiskAuthorizationForDraft(f.match)).source,'DATACREDITO');
  await f.pg.exec(`UPDATE "CreditoBorrador" SET "payload"='{"dataCreditoAssessmentId":"${randomUUID()}"}'`);
  assert.equal(await f.operations.getCreditRiskAuthorizationForDraft(f.match),null);
 }finally{await f.pg.close()}
});
test('la autorización y el token vencidos fallan cerrados; el lector interno exige el caso nominal',async()=>{
 const f=await fixture();try{
  const {exception}=await f.operations.createSingleCaseCreditRiskException(f.grant);
  const input={...f.match,exceptionId:exception.id};
  const claim=await f.operations.claimCreditRiskException(input);assert.ok(claim);
  await f.pg.exec(`UPDATE "CreditRiskException" SET "claimExpiresAt"=clock_timestamp()-INTERVAL '1 second'`);
  await f.pg.exec(`INSERT INTO "Credito"("id","clienteDocumento","usuarioId","sedeId") VALUES(102,'1234567',2,3)`);
  assert.equal(await f.db.$transaction(tx=>f.operations.consumeCreditRiskException({...input,claimToken:claim.claimToken,creditId:102},tx)),false);
  const next=await f.operations.claimCreditRiskException(input);assert.ok(next);assert.notEqual(next.claimToken,claim.claimToken);
  await f.operations.releaseCreditRiskException({...input,claimToken:claim.claimToken});
  assert.equal(await f.operations.claimCreditRiskException(input),null,'obsolete token cannot release rotated claim');
  await f.pg.exec(`UPDATE "CreditoBorrador" SET "expiresAt"=clock_timestamp()-INTERVAL '1 second'`);
  assert.equal(await f.operations.getActiveCreditRiskExceptionForDraft(f.match),null);
  assert.match(code,/input\.assessmentId !== SINGLE_CASE_RISK_ASSESSMENT_ID/);
  assert.match(code,/input\.solicitudId !== SINGLE_CASE_RISK_SOLICITUD_ID/);
 }finally{await f.pg.close()}
});
