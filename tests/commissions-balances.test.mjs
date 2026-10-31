import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";
import test from "node:test";
import {createJiti} from "jiti";
import {PGlite} from "@electric-sql/pglite";
import ts from "typescript";

const root=path.resolve(import.meta.dirname,".."),jiti=createJiti(import.meta.url,{alias:{"@":root}}),require=createRequire(import.meta.url);
const {createCommissionStore,parseAdminCommissionBalancesQuery}=await jiti.import("../lib/commissions-storage.ts");
const now=new Date("2026-11-03T12:00:00Z");
const schema=`
CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);CREATE TABLE "Aliado"(id integer PRIMARY KEY,codigo text,nombre text,activo boolean DEFAULT true);
CREATE TABLE "Sede"(id integer PRIMARY KEY,nombre text,"aliadoId" integer,activa boolean DEFAULT true);CREATE TABLE "SedeVendedor"("sedeId" integer,"vendedorId" integer,activo boolean);
CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,activo boolean,"rolId" integer,"sedeId" integer);CREATE TABLE "Vendedor"(id integer PRIMARY KEY,nombre text,activo boolean);
CREATE TABLE "Credito"(id serial PRIMARY KEY,folio text,"clienteNombre" text,"clienteDocumento" text,imei text,"vendedorId" integer,"sedeId" integer,
  "createdAt" timestamp,"fechaCredito" timestamp,"contratoAceptadoAt" timestamp,"pagareAceptadoAt" timestamp,"deliverableReady" boolean,"montoCredito" float,estado text,"contratoSnapshot" jsonb,"observacionAdmin" text,
  "planCapitalVigente" jsonb,"fechaPrimerPago" timestamp DEFAULT '2026-12-01T12:00:00Z',"fechaProximoPago" timestamp,"frecuenciaPago" text DEFAULT 'MENSUAL',"plazoMeses" integer DEFAULT 1,"valorCuota" float DEFAULT 0,"pazYSalvoEmitidoAt" timestamp);
CREATE TABLE "CreditoAbono"(id serial PRIMARY KEY,"creditoId" integer,valor float,estado text,"fechaAbono" timestamp DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'VENDEDOR'),(3,'ANALISTA_APROBACION');INSERT INTO "Aliado"(id,codigo,nombre) VALUES(1,'FINSERPAY','Central local QA'),(2,'LOCAL_QA','Aliado local QA');
INSERT INTO "Sede"(id,nombre,"aliadoId") VALUES(1,'Origen central QA',1),(2,'Sucursal aliada QA',2);
INSERT INTO "Usuario" VALUES(1,'Central QA',true,1,1),(2,'Otra cuenta QA',true,1,2),(3,'Analista QA',true,3,1);
INSERT INTO "Vendedor" VALUES(1,'Asesor Uno QA',true),(2,'Asesor Dos QA',true),(3,'Asesor Inactivo QA',false);
INSERT INTO "SedeVendedor" VALUES(1,1,true),(2,2,true),(1,3,false);`;
function adapter(pg,trace,state,tx=0){return {
  $queryRawUnsafe:async(sql,...args)=>{trace.push({sql,args,tx});return(await pg.query(sql,args)).rows;},
  $executeRawUnsafe:async(sql,...args)=>{trace.push({sql,args,tx});const result=await pg.query(sql,args);if(sql.startsWith("SET TRANSACTION"))state.settings=(await pg.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly")).rows[0];return result.affectedRows||0;},
  $transaction:callback=>pg.transaction(client=>callback(adapter(client,trace,state,++state.tx))),
};}
async function fixture(t){
  const pg=new PGlite(),trace=[],state={tx:0};await pg.exec(schema);await pg.exec(readFileSync(path.join(root,"scripts/setup-commissions.sql"),"utf8"));t.after(()=>pg.close());let clock=new Date(now),seq=0;
  const store=createCommissionStore(adapter(pg,trace,state),()=>new Date(clock));
  async function credit(input={}){
    const n=++seq,time=input.time||"2026-10-02T12:00:00Z",snapshot=input.snapshot||{comisiones:{solicitudId:`local-operation-${n}`}};
    const [row]=(await pg.query(`INSERT INTO "Credito"(folio,"clienteNombre","clienteDocumento",imei,"vendedorId","sedeId","createdAt","fechaCredito","contratoAceptadoAt","pagareAceptadoAt","deliverableReady","montoCredito",estado,"contratoSnapshot") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,500000,$11,$12::jsonb) RETURNING id`,[
      `LOCAL-${n}`,input.name||`Registro artificial ${n}`,input.document||String(1100000+n),input.imei||String(350000000000000+n),input.sellerId??1,input.branchId??1,time,input.creditDate||time,input.unsigned?null:time,input.ready!==false,input.status||"ENTREGABLE",JSON.stringify(snapshot),
    ])).rows;
    if(!input.unsigned&&input.ready!==false)await pg.query('UPDATE "CommissionCreditSource" SET "finalizedAt"=$2::timestamptz WHERE "creditId"=$1',[row.id,time]);return row.id;
  }
  async function credits(n,input={}){const ids=[];for(let i=0;i<n;i++)ids.push(await credit(input));return ids;}
  async function movement({sellerId=1,period="2026-10",amount,status="PENDING",credits=[]}){
    await pg.query('INSERT INTO "CommissionPeriod"("sellerId",period,credits) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[sellerId,period,JSON.stringify(credits)]);
    const id=randomUUID();await pg.query(`INSERT INTO "CommissionRequest"(id,"sellerId",period,amount,nequi,status,"idempotencyKey",credits,"rejectionReason","paidAt") VALUES($1,$2,$3,$4,'3000000000',$5,$6,$7,$8,$9)`,[id,sellerId,period,amount,status,id,JSON.stringify(credits),status==="REJECTED"?"Dato artificial QA":null,status==="PAID"?clock.toISOString():null]);return id;
  }
  async function snapshot(){const values={};for(const table of ["CommissionPeriod","CommissionRequest","CommissionPayment","CommissionAudit","CommissionCreditSource"])values[table]=(await pg.query(`SELECT to_jsonb(t) AS value FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows;return values;}
  return {pg,trace,state,store,credit,credits,movement,snapshot,setNow:value=>{clock=new Date(value);}};
}

test("valida periodo, búsqueda y página sin admitir parámetros duplicados/desconocidos ni meses futuros",()=>{
  assert.deepEqual(parseAdminCommissionBalancesQuery(new URLSearchParams(),now),{period:"all_pending",search:"",page:1});
  assert.deepEqual(parseAdminCommissionBalancesQuery(new URLSearchParams("period=2026-10&search=  Asesor  &page=2"),now),{period:"2026-10",search:"Asesor",page:2});
  for(const query of ["period=","period=2026-09","period=2026-12","period=2026-13","period=all","period=all_pending&period=2026-10","search=a&search=b","search[]=a","search="+"x".repeat(121),"search=%00","page=0","page=-1","page=1e2","page=10001","page=1&page=2","sellerId=1","status=PAID"])
    assert.throws(()=>parseAdminCommissionBalancesQuery(new URLSearchParams(query),now),{status:400},query);
});

test("incluye saldo nunca solicitado ni materializado e inactivos; consulta no escribe y utiliza un snapshot readonly",async t=>{
  const f=await fixture(t);await f.credits(21);await f.credits(14,{sellerId:2,branchId:2});await f.credits(15,{sellerId:3});const before=await f.snapshot();f.trace.length=0;
  const report=await f.store.listAdminCommissionBalances(1);assert.deepEqual(report.periods,["2026-11","2026-10"]);assert.equal(report.total,2);assert.equal(report.rows.find(r=>r.sellerId===1).outstanding,525000);assert.equal(report.rows.find(r=>r.sellerId===3).sellerActive,false);assert.equal(report.totals.outstanding,825000);assert.equal(report.totals.available,825000);assert.equal(report.totals.sellers,2);
  assert.deepEqual(f.state.settings,{isolation:"repeatable read",readonly:"on"});assert.ok(f.trace.every(c=>c.tx>0));assert.match(f.trace[0].sql,/SET TRANSACTION.*REPEATABLE READ, READ ONLY/);assert.ok(f.trace.every(c=>!/^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b|pg_advisory_xact_lock/i.test(c.sql)));
  assert.equal(f.trace.filter(c=>c.sql.includes("WITH candidates AS")).length,1);assert.equal(f.trace.filter(c=>c.sql.includes("WITH selected_allies AS")).length,1);assert.deepEqual(await f.snapshot(),before);
  const month=await f.store.listAdminCommissionBalances(1,{period:"2026-10"});assert.equal(month.total,3);const below=month.rows.find(r=>r.sellerId===2);assert.equal(below.validCreditCount,14);assert.equal(below.generated,0);assert.deepEqual(below.branches,[{id:2,name:"Sucursal aliada QA"}]);
  const serialized=JSON.stringify(report);for(const field of ["nequi","clienteDocumento","clienteNombre","receiptUrl","receiptFileName","PRIVATE"])
    assert.ok(!serialized.includes(field),field);
});

test("pagos parciales, rechazos y todas las reservas reales se proyectan sin liberarlas ni contar deuda dos veces",async t=>{
  const f=await fixture(t);await f.credits(21);await f.movement({amount:100000,status:"PAID"});await f.movement({amount:200000});await f.movement({amount:300000});await f.movement({amount:50000,status:"REJECTED"});const before=await f.snapshot();
  const report=await f.store.listAdminCommissionBalances(1),row=report.rows[0];assert.equal(row.generated,525000);assert.equal(row.paid,100000);assert.equal(row.reserved,500000);assert.equal(row.outstanding,425000);assert.equal(row.available,0);assert.equal(row.adjustment,75000);assert.equal(report.totals.outstanding,425000);assert.deepEqual(await f.snapshot(),before);
  assert.equal((await f.pg.query('SELECT count(*)::int n FROM "CommissionRequest" WHERE status=\'PENDING\'')).rows[0].n,2);
});

test("cambio de mes reinicia créditos y tarifa sin borrar octubre ni mezclar umbrales entre meses",async t=>{
  const f=await fixture(t);await f.credits(21);await f.movement({amount:100000,status:"PAID"});f.setNow("2026-11-01T04:59:59Z");let report=await f.store.listAdminCommissionBalances(1);assert.equal(report.currentPeriod,"2026-10");assert.deepEqual(report.periods,["2026-10"]);
  f.setNow("2026-11-01T05:00:00Z");report=await f.store.listAdminCommissionBalances(1);assert.equal(report.currentPeriod,"2026-11");assert.deepEqual(report.periods,["2026-11","2026-10"]);assert.equal(report.rows[0].outstanding,425000);assert.equal((await f.store.listAdminCommissionBalances(1,{period:"2026-11"})).total,0);
  await f.credits(14,{time:"2026-11-01T05:00:00Z"});let november=await f.store.listAdminCommissionBalances(1,{period:"2026-11"});assert.equal(november.rows[0].validCreditCount,14);assert.equal(november.rows[0].generated,0);
  await f.credit({time:"2026-11-01T05:00:00Z"});report=await f.store.listAdminCommissionBalances(1);assert.equal(report.total,2);assert.equal(report.totals.sellers,1);assert.equal(report.totals.outstanding,725000);november=report.rows.find(r=>r.period==="2026-11");assert.equal(november.rate,20000);assert.equal(november.generated,300000);assert.equal(report.rows.find(r=>r.period==="2026-10").validCreditCount,21);
});

test("sobrepago histórico no compensa automáticamente deuda de otro mes y queda visible como ajuste",async t=>{
  const f=await fixture(t);await f.credits(15);await f.credits(15,{time:"2026-11-02T12:00:00Z"});await f.movement({amount:400000,status:"PAID"});
  const report=await f.store.listAdminCommissionBalances(1);assert.equal(report.total,2);assert.equal(report.totals.generated,600000);assert.equal(report.totals.paid,400000);assert.equal(report.totals.outstanding,300000);assert.equal(report.totals.adjustment,100000);assert.equal(report.totals.available,300000);const october=report.rows.find(r=>r.period==="2026-10");assert.equal(october.outstanding,0);assert.equal(october.adjustment,100000);
});

test("la proyección global preserva elegibilidad y deduplicación canónica entre asesores",async t=>{
  const f=await fixture(t);await f.credits(15);await f.credit({time:"2026-09-30T23:00:00Z"});await f.credit({creditDate:"2026-09-20T12:00:00Z"});await f.credit({unsigned:true,status:"PENDIENTE"});await f.credit({ready:false});await f.credit({name:"CLIENTE PRUEBA"});await f.credit({snapshot:{comisiones:{isTest:true}}});await f.credit({status:"ANULADO"});
  const canonical=await f.credit({snapshot:{solicitudId:"same-local-operation"},document:"12345678",imei:"350000000000099"});await f.credit({sellerId:2,branchId:2,snapshot:{solicitudId:"same-local-operation"}});await f.credit({sellerId:2,branchId:2,document:"12345678",imei:"350000000000099"});
  let report=await f.store.listAdminCommissionBalances(1,{period:"2026-10"});assert.equal(report.total,1);assert.equal(report.rows[0].validCreditCount,16);assert.equal(report.rows[0].generated,320000);
  await f.pg.query('UPDATE "Credito" SET estado=\'ANULADO\' WHERE id=$1',[canonical]);report=await f.store.listAdminCommissionBalances(1,{period:"2026-10"});assert.equal(report.total,1);assert.equal(report.rows[0].validCreditCount,15);assert.equal(report.rows[0].generated,300000);
});

test("pausa usa asignaciones activas y origen impago aunque cambie de sede y nunca materialice el periodo",async t=>{
  const f=await fixture(t);await f.credits(15);await f.credits(15,{sellerId:2,branchId:2});await f.pg.exec('UPDATE "Credito" SET "fechaPrimerPago"=\'2026-10-01T12:00:00Z\',"valorCuota"=500000 WHERE "sedeId"=1;UPDATE "SedeVendedor" SET activo=false WHERE "vendedorId"=1;INSERT INTO "SedeVendedor" VALUES(2,1,true);');
  let report=await f.store.listAdminCommissionBalances(1);assert.equal(report.rows.find(r=>r.sellerId===1).payoutsPaused,true);assert.deepEqual(report.rows.find(r=>r.sellerId===1).branches,[{id:1,name:"Origen central QA"}]);assert.equal(report.rows.find(r=>r.sellerId===2).payoutsPaused,false);
  assert.equal((await f.pg.query('SELECT count(*)::int n FROM "CommissionPeriod"')).rows[0].n,0);await f.pg.exec('INSERT INTO "SedeVendedor" VALUES(1,2,true)');report=await f.store.listAdminCommissionBalances(1);assert.equal(report.rows.find(r=>r.sellerId===2).payoutsPaused,true);
});

test("paginación y totales aplican búsqueda global antes del límite y cartera se consulta una vez",async t=>{
  const f=await fixture(t);await f.pg.exec(`INSERT INTO "Vendedor" SELECT n,'Asesor local '||n,true FROM generate_series(10,50) n;
    INSERT INTO "Credito"(folio,"clienteNombre","clienteDocumento",imei,"vendedorId","sedeId","createdAt","fechaCredito","contratoAceptadoAt","pagareAceptadoAt","deliverableReady","montoCredito",estado,"contratoSnapshot")
    SELECT 'BULK-'||v.id||'-'||n,'Registro local',((v.id*1000+n)::text),(350000000000000::bigint+v.id*1000+n)::text,v.id,2,'2026-10-02','2026-10-02','2026-10-02','2026-10-02',true,500000,'ENTREGABLE',jsonb_build_object('solicitudId','bulk-'||v.id||'-'||n) FROM "Vendedor" v CROSS JOIN generate_series(1,15) n WHERE v.id BETWEEN 10 AND 50;
    UPDATE "CommissionCreditSource" SET "finalizedAt"='2026-10-02T12:00:00Z';`);f.trace.length=0;
  const first=await f.store.listAdminCommissionBalances(1),second=await f.store.listAdminCommissionBalances(1,{page:2});assert.equal(first.total,41);assert.equal(first.rows.length,40);assert.equal(second.rows.length,1);assert.equal(first.totals.sellers,41);assert.equal(first.totals.outstanding,12300000);assert.deepEqual(second.totals,first.totals);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.sellerId)).size,41);
  assert.equal(f.trace.filter(c=>c.sql.includes("WITH candidates AS")).length,2);assert.equal(f.trace.filter(c=>c.sql.includes("WITH selected_allies AS")).length,2);
  const wanted=second.rows[0],search=await f.store.listAdminCommissionBalances(1,{search:wanted.sellerName});assert.equal(search.total,1);assert.equal(search.rows[0].sellerId,wanted.sellerId);assert.equal(search.totals.outstanding,300000);
  await f.pg.query('UPDATE "Vendedor" SET nombre=\'Asesor 100% local\' WHERE id=$1',[wanted.sellerId]);assert.equal((await f.store.listAdminCommissionBalances(1,{search:"%"})).total,1);assert.equal((await f.store.listAdminCommissionBalances(1,{search:"' OR true --"})).total,0);assert.equal((await f.store.listAdminCommissionBalances(1,{search:"Sucursal aliada"})).total,41);
});

test("cada reporte revalida administrador central y alcance activo dentro del snapshot",async t=>{
  const f=await fixture(t);await f.credits(15);for(const id of [2,3,999])await assert.rejects(f.store.listAdminCommissionBalances(id),{status:403});
  for(const [deny,restore] of [
    ['UPDATE "Usuario" SET activo=false WHERE id=1','UPDATE "Usuario" SET activo=true WHERE id=1'],
    ['UPDATE "Usuario" SET "rolId"=3 WHERE id=1','UPDATE "Usuario" SET "rolId"=1 WHERE id=1'],
    ['UPDATE "Sede" SET activa=false WHERE id=1','UPDATE "Sede" SET activa=true WHERE id=1'],
    ['UPDATE "Aliado" SET activo=false WHERE id=1','UPDATE "Aliado" SET activo=true WHERE id=1'],
  ]){await f.pg.exec(deny);await assert.rejects(f.store.listAdminCommissionBalances(1),{status:403});await f.pg.exec(restore);}
  assert.equal((await f.store.listAdminCommissionBalances(1)).total,1);
});

function endpoint(access,storeError){const calls=[],cache=new Map();function load(file){if(cache.has(file))return cache.get(file);const mod={exports:{}},output=ts.transpileModule(readFileSync(path.join(root,file),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function("require","module","exports",output)(name=>{
  if(name==="@/lib/dashboard-access")return {getDashboardAccess:async()=>access};if(name==="@/lib/aliados")return {isFinserPayCentralAlly:code=>code==="FINSERPAY"};if(name==="@/lib/commissions-storage")return {parseAdminCommissionBalancesQuery:params=>parseAdminCommissionBalancesQuery(params,now),listAdminCommissionBalances:async(...args)=>{calls.push(args);if(storeError)throw storeError;return {rows:[],total:0};}};if(name.startsWith("@/"))return load(name.slice(2)+".ts");return require(name);
  },mod,mod.exports);cache.set(file,mod.exports);return mod.exports;}return {...load("app/api/admin/comisiones/saldos/route.ts"),calls};}
const central={admin:true,vendedor:false,seller:null,session:{id:1,aliadoAccesoCodigo:"FINSERPAY"}},req=query=>new Request("https://finser.example/api/admin/comisiones/saldos"+(query?"?"+query:""));
test("GET exige central, valida parámetros y responde privado sin llamar rutas de pago ni sincronización",async()=>{
  for(const access of [null,{...central,admin:false},{...central,session:{id:2,aliadoAccesoCodigo:"OTRO"}}]){const e=endpoint(access);assert.ok([401,403].includes((await e.GET(req())).status));assert.equal(e.calls.length,0);}
  const e=endpoint(central),response=await e.GET(req("period=2026-10&search=Asesor&page=2"));assert.equal(response.status,200);assert.deepEqual(e.calls,[[1,{period:"2026-10",search:"Asesor",page:2}]]);assert.match(response.headers.get("cache-control"),/private, no-store/);assert.equal(response.headers.get("vary"),"Cookie");assert.equal(e.POST,undefined);
  for(const query of ["period=9999-01","period=2026-10&period=2026-10","sellerId=1","page=0","search[]=a"]){const e=endpoint(central);assert.equal((await e.GET(req(query))).status,400);assert.equal(e.calls.length,0);}
});
