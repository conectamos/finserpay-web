import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {createJiti} from "jiti";
import {PGlite} from "@electric-sql/pglite";

const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createAttentionBoardStore}=await jiti.import("../lib/atencion-board-storage.ts");
const {createAttentionMetaStore}=await jiti.import("../lib/atencion-meta-storage.ts");
const {parseAttentionBoardMove,parseAttentionBoardMutation,parseAttentionBoardCards}=await jiti.import("../lib/atencion-board-core.ts");
const migration=readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8");
const central={userId:1,sellerId:null,key:"admin:1",name:"Central",central:true,admin:true,analyst:false,supervisor:false,aliadoId:1,sedeId:10};
const analyst={...central,userId:5,key:"analyst:5",name:"Analista A",central:false,admin:false,analyst:true};
const other={...analyst,userId:6,key:"analyst:6",name:"Analista B"};
const scope={phoneNumberId:"1162059967000416",wabaId:"2148284059050848"};
const instant="2026-10-30T15:00:00.000Z";
function adapter(db){return {$queryRawUnsafe:async(sql,...values)=>(await db.query(sql,values)).rows,$transaction:fn=>db.transaction(tx=>fn(adapter(tx)))};}
async function fixture(t){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);
    CREATE TABLE "Aliado"(id integer PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id integer PRIMARY KEY,nombre text,"aliadoId" integer,activa boolean);
    CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,activo boolean,"sedeId" integer,"rolId" integer);
    CREATE TABLE "Vendedor"(id integer PRIMARY KEY);
    CREATE TABLE "Credito"(id integer PRIMARY KEY,"clienteTelefono" text,"clienteNombre" text,"clienteDocumento" text,estado text DEFAULT 'ACTIVO');
    CREATE TABLE "CreditoBorrador"(id integer PRIMARY KEY,"clienteNombre" text,"clienteTelefono" text);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(3,'ANALISTA_APROBACION');
    INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true);INSERT INTO "Sede" VALUES(10,'Central',1,true);
    INSERT INTO "Usuario" VALUES(1,'Central',true,10,1),(5,'Analista A',true,10,3),(6,'Analista B',true,10,3);`);
  await db.exec(migration);const database=adapter(db),store=createAttentionBoardStore(database);
  const sections=(await db.query('SELECT * FROM "AttentionBoardSection" ORDER BY position')).rows;
  const chat=async(owner=analyst,data={})=>{
    const id=randomUUID();await db.query(`INSERT INTO "AttentionConversation"(id,channel,name,phone,"assigneeKey","assigneeUserId","assigneeName",status,mode,tags,version,"lastContactAt","sectionId")
      VALUES($1,'whatsapp',$2,$3,$4,$5,$6,'open','human_requested','["Etiqueta propia"]'::jsonb,7,$7,$8)`,
      [id,data.name??"Contacto",data.phone??null,owner?.key??null,owner?.userId??null,owner?.name??null,data.at??instant,data.sectionId??null]);return id;
  };
  return {db,database,store,sections,chat};
}
const request=(data={})=>({requestId:randomUUID(),...data});
const move=(sectionId,boardVersion=1)=>request({sectionId,boardVersion});

test("validación estricta separa boardVersion, colores compartidos y Sin sección permanente",()=>{
  assert.equal(parseAttentionBoardMutation(request({action:"create",name:"  Mi   sección ",color:"navy"})).name,"Mi sección");
  for(const body of [request({action:"create",name:"Sin sección",color:"green"}),request({action:"create",name:"X",color:"purple"}),request({action:"create",name:"X",color:"green",userId:6}),request({action:"archive",id:null,version:1}),request({action:"reorder",ordered:[{id:randomUUID(),version:0}]})])assert.throws(()=>parseAttentionBoardMutation(body),{status:400});
  for(const body of [request({sectionId:null,version:7}),move("invalid"),{...move(null),boardVersion:0},{...move(null),status:"closed"}])assert.throws(()=>parseAttentionBoardMove(body),{status:400});
  for(const query of ['sectionId=none&page=1&page=2','sectionId=none&search=a&search=b','sectionId=none&page=-1','sectionId=invalid','page=1'])assert.throws(()=>parseAttentionBoardCards(new URLSearchParams(query)),{status:400});
});

test("columnas iniciales exactas, conteos aislados, páginas20 y búsqueda no convierten sección en clasificación",async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.sections.map(s=>s.name),['FINSER PAY','SUMASPAY','BOGOTA','ADDI','OTROS']);
  for(let i=0;i<25;i++)await f.chat(analyst,{name:`Propio ${String(i).padStart(2,'0')}`});
  await f.chat(other,{name:'Ajeno'});await f.chat(null,{name:'Sin asignar'});
  const board=await f.store.get(analyst);assert.equal(board.sections[0].count,25);assert.equal(board.permissions.manage,false);
  assert.equal((await f.store.get(central)).sections[0].count,27);
  const search=await f.store.get(analyst,'Propio 0');assert.equal(search.sections[0].count,10);assert.equal(search.sections[0].totalCount,25);
  const page1=await f.store.cards(analyst,{sectionId:null,search:'',page:1}),page2=await f.store.cards(analyst,{sectionId:null,search:'',page:2});
  assert.equal(page1.total,25);assert.equal(page1.conversations.length,20);assert.equal(page2.conversations.length,5);
  assert.equal(new Set([...page1.conversations,...page2.conversations].map(c=>c.id)).size,25);
  assert.ok(page1.conversations.every(c=>c.assigneeKey===analyst.key&&c.boardVersion===1&&c.sectionId===null));
  const id=page1.conversations[0].id;await f.store.move(analyst,id,move(f.sections[0].id));
  const card=(await f.store.cards(analyst,{sectionId:f.sections[0].id,search:'',page:1})).conversations[0];
  assert.deepEqual(card.autoTags,[]);assert.deepEqual(card.tags,['Etiqueta propia']);assert.equal(card.creditClassification.status,'unverified');
  assert.equal((await f.store.get(other,'Propio')).sections.reduce((n,s)=>n+s.count,0),0);
});

test("búsqueda de nombre financiero usa únicamente vínculo permitido al analista",async t=>{
  const f=await fixture(t),id=await f.chat(analyst,{phone:'+573001234567'});
  await f.db.query(`INSERT INTO "Credito" VALUES(1,'3001234567','Nombre financiero','123','PAGADO')`);
  assert.equal((await f.store.get(analyst,'Nombre financiero')).sections[0].count,0);
  assert.equal((await f.store.get(central,'Nombre financiero')).sections[0].count,1);
  await f.db.query('UPDATE "AttentionConversation" SET "linkedCreditId"=1 WHERE id=$1',[id]);
  const result=await f.store.cards(analyst,{sectionId:null,search:'Nombre financiero',page:1});assert.equal(result.total,1);assert.deepEqual(result.conversations[0].autoTags,['FINSERPAY']);
});

test("movimiento tiene versión e idempotencia propias y conserva negocio y envío humano reservado",async t=>{
  const f=await fixture(t),id=await f.chat(analyst,{phone:'+573001234567'});
  const meta=createAttentionMetaStore(f.database,{scope,sendingEnabled:true,cutoverConfirmed:true,now:()=>new Date(instant)});
  await meta.ingest({scope,messages:[{id:'wamid.inbound',from:'573001234567',phone:'+573001234567',name:'Contacto',timestamp:instant,type:'text',text:'Consulta'}],statuses:[],ignored:0});
  const before=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[id])).rows[0];
  const queued=await meta.queueReply(analyst,id,request({version:before.version,text:'Respuesta'}));
  const claim=await meta.claimReply(analyst,id,queued.requestId);assert.equal(claim.claimed,true);
  const input=move(f.sections[1].id),moved=await f.store.move(analyst,id,input);
  assert.equal(moved.boardVersion,2);assert.equal(moved.unchanged,false);
  assert.equal((await f.store.move(analyst,id,input)).unchanged,true);
  await assert.rejects(f.store.move(analyst,id,{...input,sectionId:null}),{status:409});
  await assert.rejects(f.store.move(analyst,id,move(null)),{status:409});
  await assert.rejects(f.store.move(analyst,id,{...move(null,2),requestId:queued.requestId}),{status:409});
  const after=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[id])).rows[0];
  for(const key of ['version','status','mode','assigneeKey','assigneeUserId','lastContactAt','metaLastInboundAt','tags'])assert.deepEqual(after[key],before[key],key);
  await meta.beforeSend(analyst,queued.id,claim.reply.leaseToken);
  assert.equal((await f.db.query('SELECT status FROM "AttentionMetaOutbox" WHERE id=$1',[queued.id])).rows[0].status,'sending');
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionAudit" WHERE action='BOARD_CONVERSATION_MOVED'`)).rows[0].n,1);
  const noop=await f.store.move(analyst,id,move(f.sections[1].id,2));assert.equal(noop.unchanged,true);assert.equal(noop.boardVersion,2);
});

test("revalida asignación y cuenta para lectura, movimiento y replay; central es único configurador",async t=>{
  const f=await fixture(t),id=await f.chat(other),input=move(f.sections[0].id);
  await assert.rejects(f.store.move(analyst,id,input),{status:404});
  await assert.rejects(f.store.configure(analyst,request({action:'create',name:'Nueva',color:'green'})),{status:403});
  await f.store.move(other,id,input);await f.db.query('UPDATE "AttentionConversation" SET "assigneeUserId"=5,"assigneeKey"=$2 WHERE id=$1',[id,analyst.key]);
  await assert.rejects(f.store.move(other,id,input),{status:404});
  await f.db.query('UPDATE "Usuario" SET activo=false WHERE id=5');
  await assert.rejects(f.store.get(analyst),{status:403});await assert.rejects(f.store.cards(analyst,{sectionId:null,search:'',page:1}),{status:403});
  await assert.rejects(f.store.move(analyst,id,move(null,2)),{status:403});
  assert.equal((await f.store.move(central,id,move(null,2))).boardVersion,3);
});

test("configuración central valida unicidad/versiones, orden completo y archiva solo vacías sin borrar historial",async t=>{
  const f=await fixture(t),first=f.sections[0],input=request({action:'create',name:'Nueva',color:'green'});
  const created=await f.store.configure(central,input);assert.equal(created.section.name,'Nueva');assert.equal((await f.store.configure(central,input)).section.id,created.section.id);
  await assert.rejects(f.store.configure(central,request({action:'create',name:'nueva',color:'amber'})),{status:409});
  await assert.rejects(f.store.configure(central,request({action:'rename',id:first.id,version:1,name:'Nueva'})),{status:409});
  const renamed=await f.store.configure(central,request({action:'rename',id:first.id,version:1,name:'Personalizada'}));assert.equal(renamed.section.version,2);
  await assert.rejects(f.store.configure(central,request({action:'color',id:first.id,version:1,color:'navy'})),{status:409});
  let active=(await f.store.get(central)).sections.filter(s=>s.id);
  await assert.rejects(f.store.configure(central,request({action:'reorder',ordered:active.slice(1).map(({id,version})=>({id,version}))})),{status:409});
  const order=active.reverse().map(({id,version})=>({id,version}));await f.store.configure(central,request({action:'reorder',ordered:order}));
  active=(await f.store.get(central)).sections.filter(s=>s.id);assert.deepEqual(active.map(s=>s.id),order.map(s=>s.id));
  const target=active[0],chat=await f.chat(other,{sectionId:target.id});
  const searched=(await f.store.get(central,'No coincide')).sections.find(s=>s.id===target.id);assert.equal(searched.count,0);assert.equal(searched.totalCount,1);
  await assert.rejects(f.store.configure(central,request({action:'archive',id:target.id,version:target.version})),{status:409});
  await f.store.move(central,chat,move(null));await f.store.configure(central,request({action:'archive',id:target.id,version:target.version}));
  assert.ok((await f.db.query('SELECT "archivedAt" FROM "AttentionBoardSection" WHERE id=$1',[target.id])).rows[0].archivedAt);
  await assert.rejects(f.store.move(central,chat,move(target.id,2)),{status:404});
  await assert.rejects(f.store.cards(central,{sectionId:target.id,search:'',page:1}),{status:404});
  await assert.rejects(f.db.query(`DELETE FROM "AttentionAudit" WHERE action='BOARD_SECTION_CHANGED'`),/append-only/);
});

test("carreras de versión no duplican movimientos ni auditoría y esquema ausente responde503 sin DDL",async t=>{
  const f=await fixture(t),id=await f.chat(analyst);
  const results=await Promise.allSettled([f.store.move(analyst,id,move(f.sections[0].id)),f.store.move(analyst,id,move(f.sections[1].id))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionAudit" WHERE action='BOARD_CONVERSATION_MOVED'`)).rows[0].n,1);
  await f.db.exec('ALTER TABLE "AttentionConversation" DROP COLUMN "sectionId",DROP COLUMN "boardVersion"; DROP TABLE "AttentionBoardSection"');
  await assert.rejects(f.store.get(central),{status:503});await assert.rejects(f.store.move(analyst,id,move(null)),{status:503});
  assert.equal((await f.db.query(`SELECT to_regclass('public."AttentionBoardSection"') AS relation`)).rows[0].relation,null);
});
