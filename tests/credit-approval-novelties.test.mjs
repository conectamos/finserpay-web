import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import pg from "pg";
import sharp from "sharp";
import { installCreditApprovalSchema } from "../scripts/credit-approval-schema.mjs";
import { installCreditApprovalNoveltiesSchema } from "../scripts/credit-approval-novelties-schema.mjs";
const require = createRequire(import.meta.url);
const modules = new Map();
const approvalStub = {
  async getCreditApprovalDetail(db,id) {
    const rows=await db.$queryRawUnsafe('SELECT "revision" FROM "CreditApprovalReview" WHERE "creditoId"=$1',id);
    const credit=(await db.$queryRawUnsafe('SELECT "estado" FROM "Credito" WHERE "id"=$1',id))[0];
    return {capabilities:{canCorrectEvidence:!['ANULADO','CANCELADO'].includes(credit.estado)},review:{revision:rows[0].revision,reviewHash:'a'.repeat(64)}};
  },
  approvalImage(value) { if(!value?.startsWith('data:image/png;base64,')) return null; return {bytes:Buffer.from(value.split(',')[1],'base64'),mime:'image/png'}; },
};
function load(path) {
  if(modules.has(path)) return modules.get(path);
  const source=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const loadedModule={exports:{}};modules.set(path,loadedModule.exports);
  runInNewContext(output,{module:loadedModule,exports:loadedModule.exports,Buffer,Uint8Array,Date,URL,console,require(name){
    if(name==='server-only') return {};
    if(name==='@/lib/credit-approval') return approvalStub;
    if(name.startsWith('@/lib/')) return load(name.slice(2)+'.ts');
    if(name.startsWith('./')) return load('lib/'+name.slice(2)+'.ts');
    return require(name);
  }},{filename:path}); return loadedModule.exports;
}
const service=load('lib/credit-approval-novelties.ts');
const state=load('lib/credit-approval-novelty-state.ts');
const history=load('lib/credit-approval-evidence-history.ts');
const queue=load('lib/credit-approval-queue.ts');
const plain=value=>JSON.parse(JSON.stringify(value));
const actor={id:1,nombre:'Analista sintetico'};
const ally={id:2,nombre:'Admin aliado sintetico',aliadoId:10};
const other={id:3,nombre:'Admin otro aliado',aliadoId:30};
const hash='a'.repeat(64);
const createInput=(keys=[])=>({keys,reason:'Fotografía ilegible',revision:1,reviewHash:hash,idempotencyKey:randomUUID()});

test('validación exacta de novedades, respuesta y paginación',async()=>{
  assert.deepEqual(plain(service.parseCreateNovelty(createInput()).keys),['GENERAL']);
  for(const bad of [createInput(['GENERAL']),createInput(['foto-entrega','foto-entrega']),{...createInput(),montoCredito:1},{...createInput(),reason:'abcd'},{...createInput(),revision:0}]) assert.throws(()=>service.parseCreateNovelty(bad));
  const input={noveltyId:randomUUID(),itemId:randomUUID(),expectedVersion:1,idempotencyKey:randomUUID(),text:'Resuelto con soporte'};
  assert.equal(service.parseNoveltyResponse(input,false).text,input.text);
  assert.throws(()=>service.parseNoveltyResponse({...input,key:'GENERAL'},false));
  assert.throws(()=>service.parseNoveltyResponse({...input,text:'x'.repeat(2001)},false));
  await assert.rejects(queue.listCreditApprovalQueue({$queryRawUnsafe:async()=>[]}),error=>error.code==='APPROVAL_UNAVAILABLE');
  await assert.rejects(service.listPendingAllyCredits({$queryRawUnsafe:async()=>[]},ally,{}),error=>error.code==='APPROVAL_UNAVAILABLE');
  const page=queue.approvalQueuePage([{id:1,createdAt:'2026-09-09T00:00:00.000Z'},{id:2,createdAt:'2026-09-09T00:00:00.000Z'}],1);
  assert.deepEqual(plain(queue.parseApprovalQueueCursor(page.nextCursor)),{id:1,createdAt:'2026-09-09T00:00:00.000Z'});
  for(const invalid of ['garbage','%%%%',Buffer.from(JSON.stringify({id:1,createdAt:'invalid'})).toString('base64url')]) assert.throws(()=>queue.parseApprovalQueueCursor(invalid));
  assert.throws(()=>queue.approvalQueueLimit(101));
  await assert.rejects(service.prepareNoveltyResponse({...input,text:undefined,dataUrl:'data:image/svg+xml;base64,AAAA',expectedPhotoHash:null},true));
});

// PostgreSQL naive timestamps use the same UTC convention as Prisma.
pg.types.setTypeParser(1114,value=>new Date(value.replace(' ','T')+'Z'));
const connectionString=process.env.CREDIT_NOVELTIES_TEST_DATABASE_URL;
test('PostgreSQL aislado: novedades, permisos, respuestas independientes e historial', {skip:connectionString?false:'Requiere CREDIT_NOVELTIES_TEST_DATABASE_URL en approval_novelties_test local'},async t=>{
  const url=new URL(connectionString);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/approval_novelties_test');
  const db=new pg.Client({connectionString});await db.connect();t.after(()=>db.end());
  const tables=['CreditApprovalNoveltyEvent','CreditApprovalNoveltyItem','CreditApprovalNovelty','CreditApprovalReissue','CreditApprovalEvent','CreditApprovalReview','CreditApprovalPolicy','LiquidacionAliadoCredito','Credito','Usuario','Rol','Sede','Aliado'];
  const existing=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
  assert.ok(existing.every(row=>tables.includes(row.tablename)),'No borrar tablas ajenas');
  for(const table of tables) await db.query('DROP TABLE IF EXISTS public."'+table+'" CASCADE');
  await db.query(`
    CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY,"nombre" TEXT); INSERT INTO "Rol" VALUES (1,'ADMIN'),(2,'VENDEDOR');
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY,"codigo" TEXT,"nombre" TEXT,"activo" BOOLEAN DEFAULT true,
      "redescuentoPorcentaje" FLOAT DEFAULT 10,"redescuentoAndroidPorcentaje" FLOAT DEFAULT 10,"redescuentoIphonePorcentaje" FLOAT DEFAULT 15);
    INSERT INTO "Aliado" ("id","codigo","nombre") VALUES (10,'ALLY','Aliado sintetico'),(20,'FINSERPAY','Central'),(30,'OTHER','Otro aliado');
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER,"nombre" TEXT DEFAULT 'Sede test',"activa" BOOLEAN DEFAULT true); INSERT INTO "Sede" ("id","aliadoId") VALUES (10,10),(20,20),(30,30);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY,"sedeId" INTEGER,"rolId" INTEGER,"activo" BOOLEAN DEFAULT true); INSERT INTO "Usuario" ("id","sedeId","rolId") VALUES (1,20,1),(2,10,1),(3,30,1),(4,10,2);
    CREATE TABLE "Credito" ("id" SERIAL PRIMARY KEY,"folio" TEXT DEFAULT 'TEST',"clienteNombre" TEXT DEFAULT 'Cliente sintetico',
      "clienteDocumento" TEXT DEFAULT '1000000000',"fechaCredito" TIMESTAMP DEFAULT '2026-09-09T12:00:00',
      "createdAt" TIMESTAMP(3) DEFAULT '2099-01-01',"updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"estado" TEXT DEFAULT 'INSCRITO',
      "sedeId" INTEGER DEFAULT 10,"imei" TEXT DEFAULT '123456789012345',"deviceUid" TEXT DEFAULT 'device-test',
      "referenciaEquipo" TEXT DEFAULT 'Equipo test',"equipoMarca" TEXT DEFAULT 'Samsung',"equipoModelo" TEXT DEFAULT 'Test',
      "valorEquipoTotal" FLOAT DEFAULT 1000000,"cuotaInicial" FLOAT DEFAULT 200000,"saldoBaseFinanciado" FLOAT DEFAULT 800000,"montoCredito" FLOAT DEFAULT 800000,
      "equalityService" TEXT,"observacionAdmin" TEXT,"contratoSnapshot" JSONB DEFAULT '{"equipo":{"plataforma":"ANDROID"},"financiero":{"immutable":123}}',
      "contratoCedulaFrenteDataUrl" TEXT,"contratoCedulaRespaldoDataUrl" TEXT,"iphoneSelfieCedulaDataUrl" TEXT,"fotoEntregaDataUrl" TEXT,"fotoRemisionDataUrl" TEXT);
    CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER UNIQUE REFERENCES "Credito"("id"));
    CREATE TABLE "CreditApprovalReissue" ("id" UUID PRIMARY KEY,"creditoId" INTEGER,"status" TEXT,"reason" TEXT,"requestedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"lastCheckedAt" TIMESTAMP,"completedAt" TIMESTAMP,"newProcessUuid" TEXT);
  `);
  await installCreditApprovalSchema(db); const activated=(await db.query('SELECT "activatedAt"::text FROM "CreditApprovalPolicy"')).rows[0].activatedAt;
  await installCreditApprovalNoveltiesSchema(db);
  const adapter=client=>({$queryRawUnsafe:async(sql,...params)=>(await client.query(sql,params)).rows,$executeRawUnsafe:async(sql,...params)=>(await client.query(sql,params)).rowCount});
  const api=adapter(db);
  const transaction=async(fn,client=db)=>{await client.query('BEGIN');try{const out=await fn(adapter(client));await client.query('COMMIT');return out;}catch(error){await client.query('ROLLBACK');throw error;}};
  const create=async(overrides={})=>{const values={createdAt:'2099-01-01',...overrides};const keys=Object.keys(values);return(await db.query('INSERT INTO "Credito" ('+keys.map(k=>'"'+k+'"').join(',')+') VALUES ('+keys.map((_,i)=>'$'+(i+1)).join(',')+') RETURNING "id"',Object.values(values))).rows[0].id;};
  const review=async id=>(await db.query('SELECT * FROM "CreditApprovalReview" WHERE "creditoId"=$1',[id])).rows[0];
  const approve=async(id,client=db)=>{await client.query(`UPDATE "CreditApprovalReview" SET "status"='APPROVED',"approvedRevision"="revision","approvedByUserId"=1,"approvedByName"='Analista',"approvedAt"=CURRENT_TIMESTAMP,"reviewHash"=$2 WHERE "creditoId"=$1`,[id,hash]);};
  const report=async(id,keys=[])=>{const input=service.parseCreateNovelty({...createInput(keys),revision:(await review(id)).revision});await transaction(tx=>service.createCreditApprovalNovelty(tx,id,input,actor));return input;};
  const detail=id=>service.getPendingAllyCredit(api,id,ally);
  const responseInput=(item,noveltyId,extra)=>({noveltyId,itemId:item.id,expectedVersion:item.version,idempotencyKey:randomUUID(),...extra});
  const photo=async color=>'data:image/png;base64,'+(await sharp({create:{width:2,height:2,channels:3,background:color}}).png().toBuffer()).toString('base64');
  const red=await photo('red'),blue=await photo('blue'),green=await photo('green');

  await t.test('instalación repetible Prisma-first, UTC e historia sin tocar',async()=>{
    await db.query('ALTER TABLE "CreditApprovalNovelty" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP');
    await db.query('ALTER TABLE "CreditApprovalNoveltyItem" DROP CONSTRAINT "CreditApprovalNoveltyItem_response_check"');
    await installCreditApprovalNoveltiesSchema(db);
    assert.equal((await db.query('SELECT "activatedAt"::text FROM "CreditApprovalPolicy"')).rows[0].activatedAt,activated);
    const id=await create();await db.query("SET TIME ZONE 'America/Bogota'");await report(id);
    assert.equal((await db.query(`SELECT ABS(EXTRACT(EPOCH FROM("createdAt"-(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))<5 AS utc FROM "CreditApprovalNovelty" WHERE "creditoId"=$1`,[id])).rows[0].utc,true);
    await db.query("SET TIME ZONE 'UTC'");
    const historical=await create({createdAt:'2020-01-01'});assert.equal(await review(historical),undefined);
    await assert.rejects(db.query('INSERT INTO "CreditApprovalNovelty" ("id","creditoId") VALUES ($1,$2)',[randomUUID(),historical]),/NOVELTY_CREDIT_NOT_ELIGIBLE/);
    assert.equal((await db.query('SELECT "estado" FROM "Credito" WHERE "id"=$1',[historical])).rows[0].estado,'INSCRITO');
  });
  await t.test('reportar varias fotos invalida OK; repetir operación conserva un solo evento',async()=>{
    const id=await create();await approve(id);const before=await review(id);const input=await report(id,['foto-entrega','foto-remision']);
    const after=await review(id);assert.equal(after.status,'PENDING');assert.ok(after.revision>before.revision);
    const repeated=await transaction(tx=>service.createCreditApprovalNovelty(tx,id,input,actor));assert.equal(repeated.unchanged,true);
    const item=await detail(id);assert.equal(item.novelty.pendingCount,2);assert.equal(item.canRespond,true);
    await assert.rejects(approve(id),/NOVELTY_PENDING/);
    await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)',[id]),/CREDIT_APPROVAL_REQUIRED|NOVELTY_PENDING/);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM "CreditApprovalNoveltyEvent" WHERE "requestKey"=$1',[input.idempotencyKey])).rows[0].n,1);
  });
  await t.test('foto exacta, hash y versión; guarda cada respuesta y preserva valores/documentos',async()=>{
    const id=await create({fotoEntregaDataUrl:red,fotoRemisionDataUrl:red});await report(id,['foto-entrega','foto-remision']);
    let item=await detail(id);const delivery=item.novelty.items.find(i=>i.key==='foto-entrega');
    const same=await service.prepareNoveltyResponse(responseInput(delivery,item.novelty.id,{dataUrl:red,expectedPhotoHash:delivery.evidence.sha256}),true);
    assert.equal((await transaction(tx=>service.respondCreditApprovalNovelty(tx,id,same,ally))).unchanged,true);
    assert.equal((await detail(id)).novelty.pendingCount,2);
    const input=await service.prepareNoveltyResponse(responseInput(delivery,item.novelty.id,{dataUrl:blue,expectedPhotoHash:delivery.evidence.sha256}),true);
    await assert.rejects(transaction(tx=>service.respondCreditApprovalNovelty(tx,id,input,other)),/Crédito no encontrado/);
    await transaction(tx=>service.respondCreditApprovalNovelty(tx,id,input,ally));
    assert.equal((await transaction(tx=>service.respondCreditApprovalNovelty(tx,id,input,ally))).unchanged,true);
    item=await detail(id);assert.equal(item.novelty.pendingCount,1);assert.equal(item.novelty.status,'WAITING_ALLY');
    const old=await db.query('SELECT "payload" FROM "CreditApprovalNoveltyEvent" WHERE "requestKey"=$1',[input.idempotencyKey]);assert.equal(old.rows[0].payload.previousDataUrl,red);
    const stored=(await db.query('SELECT * FROM "Credito" WHERE "id"=$1',[id])).rows[0];assert.equal(stored.fotoRemisionDataUrl,red);assert.equal(stored.estado,'INSCRITO');assert.equal(stored.montoCredito,800000);assert.equal(stored.contratoSnapshot.financiero.immutable,123);
    await assert.rejects(transaction(tx=>service.respondCreditApprovalNovelty(tx,id,{...input,idempotencyKey:randomUUID()},ally)),/novedad cambió/);
    const remission=item.novelty.items.find(i=>i.key==='foto-remision');const second=await service.prepareNoveltyResponse(responseInput(remission,item.novelty.id,{dataUrl:green,expectedPhotoHash:remission.evidence.sha256}),true);
    await transaction(tx=>service.respondCreditApprovalNovelty(tx,id,second,ally));item=await detail(id);assert.equal(item.novelty.status,'RESPONDED');assert.equal(item.canRespond,false);
    assert.equal((await state.getCreditApprovalNoveltyState(api,id)).blocksApproval,false);assert.equal((await state.getCreditApprovalNoveltyState(api,id)).blocksSettlement,true);
    await assert.rejects(approve(id),/NOVELTY_PENDING/);
    await transaction(async tx=>{await tx.$queryRawUnsafe('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE',id);await state.resolveCreditApprovalNoveltyForApproval(tx,id,actor);await approve(id);});
    assert.equal((await state.getCreditApprovalNoveltyState(api,id)).novelty.status,'RESOLVED');assert.equal((await review(id)).status,'APPROVED');
    const publicHistory=await service.getCreditApprovalNoveltyHistory(api,id);assert.ok(publicHistory.history.every(e=>!('previousDataUrl'in e.payload)));
    await db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)',[id]);
    await assert.rejects(report(id),/ya fue liquidado/);
  });
  await t.test('general respondida admite nuevo rechazo sin borrar motivo/respuesta anterior',async()=>{
    const id=await create();await report(id);let item=await detail(id);const first=item.novelty.items[0];
    const input=await service.prepareNoveltyResponse(responseInput(first,item.novelty.id,{text:'Ya validamos la información solicitada'}),false);
    await transaction(tx=>service.respondCreditApprovalNovelty(tx,id,input,ally));const before=await review(id);
    await report(id);item=await detail(id);assert.equal(item.novelty.id,input.noveltyId);assert.equal(item.novelty.items[0].id,first.id);assert.equal(item.novelty.items[0].status,'OPEN');assert.ok((await review(id)).revision>before.revision);
    const audit=await service.getCreditApprovalNoveltyHistory(api,id);assert.equal(audit.history.filter(e=>e.type==='GENERAL_RESPONDED').length,1);assert.ok(audit.history.some(e=>e.payload.changes?.some(c=>c.previousResponse===input.text)));
    await assert.rejects(db.query('DELETE FROM "CreditApprovalNoveltyEvent" WHERE "noveltyId"=$1',[input.noveltyId]),/HISTORY_IMMUTABLE/);
    await assert.rejects(db.query('DELETE FROM "CreditApprovalNoveltyItem" WHERE "id"=$1',[first.id]),/HISTORY_IMMUTABLE/);
    await assert.rejects(transaction(tx=>state.resolveCreditApprovalNoveltyForApproval(tx,id,actor)),/sin responder/);
  });
  await t.test('corrección del analista responde solo la foto OPEN y no otorga OK',async()=>{
    const id=await create();await report(id,['foto-entrega','foto-remision']);
    await transaction(async tx=>{await tx.$queryRawUnsafe('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE',id);await tx.$executeRawUnsafe('UPDATE "Credito" SET "fotoEntregaDataUrl"=$2 WHERE "id"=$1',id,blue);assert.equal(await state.markNoveltyPhotoCorrected(tx,id,'foto-entrega',history.evidenceSha256(blue),actor),true);});
    assert.equal((await detail(id)).novelty.pendingCount,1);assert.equal((await review(id)).status,'PENDING');assert.equal(await transaction(tx=>state.markNoveltyPhotoCorrected(tx,id,'foto-entrega',history.evidenceSha256(blue),actor)),false);
  });
  await t.test('scope normal por aliado y rol: no históricas, pagadas, canceladas ni otro aliado',async()=>{
    const id=await create();await report(id);
    await assert.rejects(service.getPendingAllyCredit(api,id,other),/Crédito no encontrado/);
    await assert.rejects(service.getPendingAllyCredit(api,id,{id:4,nombre:'Vendedor',aliadoId:10}),/Crédito no encontrado/);
    const list=await service.listPendingAllyCredits(api,ally,{limit:100});assert.ok(list.items.some(row=>row.id===id));
    assert.equal((await service.listPendingAllyCredits(api,other,{limit:100})).items.some(row=>row.id===id),false);
    await db.query('UPDATE "Credito" SET "estado"=\'CANCELADO\' WHERE "id"=$1',[id]);assert.equal((await service.listPendingAllyCredits(api,ally,{limit:100})).items.some(row=>row.id===id),false);assert.equal((await detail(id)).canRespond,false);
    await assert.rejects(db.query('INSERT INTO "CreditApprovalNovelty" ("id","creditoId") VALUES ($1,$2)',[randomUUID(),id]),/NOVELTY_CREDIT_NOT_ELIGIBLE/);
  });
  await t.test('cola global pagina sin blobs y oculta OK vigentes conservando pendientes',async()=>{
    const id=await create();const approved=await create();await approve(approved);const historic=await create({createdAt:'2020-01-01'});const central=await create({sedeId:20});
    const oldReview=await create({createdAt:'2020-01-01'});
    const importedReview=await create({equalityService:'IMPORTACION_MASIVA',contratoSnapshot:{origen:{tipo:'IMPORTACION_MASIVA'}}});
    await db.query('INSERT INTO "CreditApprovalReview" ("creditoId") VALUES ($1),($2)',[oldReview,importedReview]);
    for(const residual of [oldReview,importedReview]) {
      await assert.rejects(report(residual),/reglas anteriores/);
      await assert.rejects(db.query('INSERT INTO "CreditApprovalNovelty" ("id","creditoId") VALUES ($1,$2)',[randomUUID(),residual]),/NOVELTY_CREDIT_NOT_ELIGIBLE/);
    }
    let cursor=null,seen=[];do{const page=await queue.listCreditApprovalQueue(api,{limit:2,cursor});seen.push(...page.items);cursor=page.nextCursor;}while(cursor);
    assert.ok(seen.some(row=>row.id===id));for(const excluded of [approved,historic,central,oldReview,importedReview]) assert.equal(seen.some(row=>row.id===excluded),false);
    assert.equal(new Set(seen.map(row=>row.id)).size,seen.length);assert.ok(seen.every(row=>!('contratoSnapshot'in row)&&!('fotoEntregaDataUrl'in row)));
  });
  await t.test('dos respuestas simultáneas independientes conservan ambas y bloquean pago',async()=>{
    const id=await create();await report(id,['foto-entrega','foto-remision']);const item=await detail(id);
    const inputs=await Promise.all(item.novelty.items.map((i,index)=>service.prepareNoveltyResponse(responseInput(i,item.novelty.id,{dataUrl:index?blue:green,expectedPhotoHash:i.evidence.sha256}),true)));
    const peer=new pg.Client({connectionString});await peer.connect();try{await Promise.all([transaction(tx=>service.respondCreditApprovalNovelty(tx,id,inputs[0],ally)),transaction(tx=>service.respondCreditApprovalNovelty(tx,id,inputs[1],ally),peer)]);}finally{await peer.end();}
    assert.equal((await detail(id)).novelty.status,'RESPONDED');assert.equal((await detail(id)).novelty.answeredCount,2);assert.equal((await review(id)).status,'PENDING');
  });
  await t.test('misma respuesta simultánea es idempotente y cambio de pertenencia se revalida',async()=>{
    const id=await create();await report(id);const item=await detail(id);const input=await service.prepareNoveltyResponse(responseInput(item.novelty.items[0],item.novelty.id,{text:'Respuesta única concurrente'}),false);
    const peer=new pg.Client({connectionString});await peer.connect();try{const out=await Promise.all([transaction(tx=>service.respondCreditApprovalNovelty(tx,id,input,ally)),transaction(tx=>service.respondCreditApprovalNovelty(tx,id,input,ally),peer)]);assert.equal(out.filter(value=>value.unchanged).length,1);}finally{await peer.end();}
    await report(id);await db.query('UPDATE "Credito" SET "sedeId"=30 WHERE "id"=$1',[id]);await assert.rejects(transaction(tx=>service.respondCreditApprovalNovelty(tx,id,{...input,idempotencyKey:randomUUID()},ally)),/Crédito no encontrado/);
  });
  await t.test('respuesta obsoleta, foto ajena a la novedad y firma incierta no escriben',async()=>{
    const id=await create({fotoEntregaDataUrl:red});await report(id,['foto-entrega']);const item=await detail(id);const evidence=item.novelty.items[0];
    const input=await service.prepareNoveltyResponse(responseInput(evidence,item.novelty.id,{dataUrl:blue,expectedPhotoHash:hash}),true);
    await assert.rejects(transaction(tx=>service.respondCreditApprovalNovelty(tx,id,input,ally)),/fotografía cambió/);
    await assert.rejects(service.getPendingAllyEvidence(api,id,'cedula-frente',ally),/Fotografía no disponible/);
    await db.query('INSERT INTO "CreditApprovalReissue" ("id","creditoId","status","reason") VALUES ($1,$2,$3,$4)',[randomUUID(),id,'UNCERTAIN','Espera prueba']);
    assert.equal((await detail(id)).canRespond,false);
    await assert.rejects(transaction(tx=>service.respondCreditApprovalNovelty(tx,id,{...input,expectedPhotoHash:evidence.evidence.sha256},ally)),/firma está pendiente/);
    assert.equal((await detail(id)).novelty.items[0].status,'OPEN');
  });
  await t.test('pago que gana el bloqueo impide abrir novedades después, sin daño histórico',async()=>{
    const id=await create();await approve(id);const input=service.parseCreateNovelty({...createInput(),revision:(await review(id)).revision});
    const peer=new pg.Client({connectionString});await peer.connect();
    try{
      await db.query('BEGIN');await db.query('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE',[id]);
      let settled=false;const pending=transaction(tx=>service.createCreditApprovalNovelty(tx,id,input,actor),peer).finally(()=>{settled=true;});
      await new Promise(resolve=>setTimeout(resolve,40));assert.equal(settled,false);
      await db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)',[id]);await db.query('COMMIT');
      await assert.rejects(pending,/ya fue liquidado/);
      assert.equal((await state.getCreditApprovalNoveltyState(api,id)).novelty,null);assert.equal((await review(id)).status,'APPROVED');
    }finally{await db.query('ROLLBACK');await peer.end();}
  });
  await t.test('novedad que gana el bloqueo invalida el pago concurrente',async()=>{
    const id=await create();await approve(id);const input=service.parseCreateNovelty({...createInput(),revision:(await review(id)).revision});
    const peer=new pg.Client({connectionString});await peer.connect();
    try{
      await db.query('BEGIN');await service.createCreditApprovalNovelty(api,id,input,actor);
      let settled=false;const payment=peer.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)',[id]).finally(()=>{settled=true;});
      await new Promise(resolve=>setTimeout(resolve,40));assert.equal(settled,false);await db.query('COMMIT');
      await assert.rejects(payment,/CREDIT_APPROVAL_REQUIRED|NOVELTY_PENDING/);assert.equal((await review(id)).status,'PENDING');
    }finally{await db.query('ROLLBACK');await peer.end();}
  });
  await t.test('esquema impide respuestas incompletas y no permite más de una novedad activa',async()=>{
    const id=await create();await report(id);const item=await detail(id);
    await assert.rejects(db.query(`UPDATE "CreditApprovalNoveltyItem" SET "status"='RESPONDED',"respondedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,[item.novelty.items[0].id]),/response_check/);
    await assert.rejects(db.query('INSERT INTO "CreditApprovalNovelty" ("id","creditoId") VALUES ($1,$2)',[randomUUID(),id]),/one_active/);
    await assert.rejects(db.query('TRUNCATE "CreditApprovalNoveltyEvent"'),/HISTORY_IMMUTABLE/);
    await installCreditApprovalNoveltiesSchema(db);assert.equal((await detail(id)).novelty.id,item.novelty.id);
  });
});
