import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const jiti = createJiti(import.meta.url,{alias:{"@":projectRoot}});
const { createCommissionStore } = await jiti.import("../lib/commissions-storage.ts");
const migration = await readFile(new URL("../scripts/setup-commissions.sql",import.meta.url),"utf8");
const fixtureSql = `
CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);
CREATE TABLE "Aliado"(id integer PRIMARY KEY,codigo text,nombre text,activo boolean DEFAULT true);
CREATE TABLE "Sede"(id integer PRIMARY KEY,nombre text,"aliadoId" integer);
CREATE TABLE "SedeVendedor"("sedeId" integer,"vendedorId" integer,activo boolean);
CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,activo boolean,"rolId" integer,"sedeId" integer);
CREATE TABLE "Vendedor"(id integer PRIMARY KEY,nombre text,activo boolean);
CREATE TABLE "Credito"(id serial PRIMARY KEY,folio text,"clienteNombre" text,"clienteDocumento" text,imei text,
  "vendedorId" integer,"sedeId" integer,"createdAt" timestamp,"fechaCredito" timestamp,"contratoAceptadoAt" timestamp,"pagareAceptadoAt" timestamp,
  "deliverableReady" boolean,"montoCredito" float,estado text,"contratoSnapshot" jsonb,"observacionAdmin" text,
  "planCapitalVigente" jsonb,"fechaPrimerPago" timestamp DEFAULT '2026-11-30T12:00:00Z',"fechaProximoPago" timestamp,
  "frecuenciaPago" text DEFAULT 'MENSUAL',"plazoMeses" integer DEFAULT 1,"valorCuota" float DEFAULT 0,"pazYSalvoEmitidoAt" timestamp);
CREATE TABLE "CreditoAbono"(id serial PRIMARY KEY,"creditoId" integer,valor float,estado text,"fechaAbono" timestamp DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'VENDEDOR');
INSERT INTO "Aliado"(id,codigo,nombre) VALUES(1,'FINSERPAY','FINSER PAY'),(2,'ALIADO','Aliado comercial'),(3,'SIN_CREDITOS','Aliado sin créditos');
INSERT INTO "Sede" VALUES(1,'Sede central',1),(2,'Sede Aliado',2);
INSERT INTO "Usuario" VALUES(1,'Administrador central',true,1,1),(2,'Admin de aliado',true,1,2),(3,'Asesor',true,2,1);
INSERT INTO "Vendedor" VALUES(1,'Ana',true),(2,'Luis',true);
INSERT INTO "SedeVendedor" VALUES(1,1,true),(1,2,true);`;

function adapter(pg) {
  return {
    $queryRawUnsafe: async (sql,...args)=>(await pg.query(sql,args)).rows,
    $executeRawUnsafe: async (sql,...args)=>(await pg.query(sql,args)).affectedRows || 0,
    $transaction: async callback=>pg.transaction(tx=>callback(adapter(tx))),
  };
}
let requestSequence=0;
const requestInput=(amount,period="2026-10")=>({period,amount,nequi:"3124085562",idempotencyKey:`request-key-${++requestSequence}`.padEnd(20,"0")});
const receipt=(label="a")=>({fileName:"comprobante.pdf",mimeType:"application/pdf",base64:Buffer.from(`%PDF-1.7\nrealistic-local-fixture-${label}\n%%EOF`).toString("base64")});

async function fixture(t) {
  const pg=new PGlite();
  await pg.exec(fixtureSql);
  await pg.exec(migration);
  t.after(()=>pg.close());
  let now=new Date("2026-10-20T12:00:00Z");
  const store=createCommissionStore(adapter(pg),()=>new Date(now));
  let sequence=0;
  async function credit(input={}) {
    const sequenceId=++sequence;
    const time=input.time || "2026-10-02T12:00:00Z";
    const snapshot=input.snapshot || {comisiones:{isTest:false,solicitudId:`operation-${sequenceId}`}};
    const rows=await pg.query(`INSERT INTO "Credito"(folio,"clienteNombre","clienteDocumento",imei,"vendedorId","sedeId","createdAt","fechaCredito",
      "contratoAceptadoAt","pagareAceptadoAt","deliverableReady","montoCredito",estado,"contratoSnapshot")
      VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$8,$9,500000,$10,$11::jsonb) RETURNING id`,[
      input.folio||`CREDIT-${sequenceId}`,input.name||`Cliente ${sequenceId}`,input.document||`${1000000+sequenceId}`,
      input.imei||`${350000000000000+sequenceId}`,input.sellerId||1,time,input.creditDate||time,input.unsigned?null:time,
      input.ready!==false,input.state||"ENTREGABLE",JSON.stringify(snapshot),
    ]);
    const id=rows.rows[0].id;
    // Fixture-only clock simulation: the production trigger uses DB time; the
    // journal is seeded to the fixture's declared original completion instant.
    if (!input.unsigned && input.ready!==false) await pg.query(`UPDATE "CommissionCreditSource" SET "finalizedAt"=$2::timestamptz WHERE "creditId"=$1`,[id,time]);
    return id;
  }
  async function credits(count,input={}) { const ids=[];for(let i=0;i<count;i++) ids.push(await credit(input));return ids; }
  return {pg,store,credit,credits,setNow:value=>{now=new Date(value);}};
}

test("prelanzamiento no consulta base de datos aunque todavía no exista esquema",async()=>{
  const unavailable = new Proxy({}, { get() { throw new Error("No database access permitted"); } });
  const store = createCommissionStore(unavailable,()=>new Date("2026-10-01T04:59:59.999Z"));
  const dashboard = await store.getSellerCommissionDashboard(1);
  assert.equal(dashboard.active,false); assert.deepEqual(dashboard.periods,[]); assert.deepEqual(dashboard.requests,[]);
});

test("sin saldos antes del 1 de octubre; a las 00:00 ya activo",async t=>{
  const f=await fixture(t);await f.credits(15);
  f.setNow("2026-10-01T04:59:59.999Z");
  const before=await f.store.getSellerCommissionDashboard(1);
  assert.equal(before.active,false);assert.deepEqual(before.periods,[]);assert.deepEqual(before.requests,[]);
  await assert.rejects(f.store.createCommissionRequest(1,requestInput(1)),/comienzan/);
  f.setNow("2026-10-01T05:00:00Z");
  const after=await f.store.getSellerCommissionDashboard(1);
  assert.equal(after.active,true);assert.equal(after.periods[0].validCreditCount,0);
});

test("14/15/16/20/21/29/30/31 créditos reales, sin límite tras 30",async t=>{
  const f=await fixture(t);let count=0;
  for(const [target,total] of [[14,0],[15,300000],[16,320000],[20,400000],[21,525000],[29,725000],[30,900000],[31,930000]]){
    await f.credits(target-count);count=target;
    const dashboard=await f.store.getSellerCommissionDashboard(1);
    assert.equal(dashboard.periods[0].validCreditCount,count);assert.equal(dashboard.periods[0].generated,total);
  }
  const audits=await f.pg.query(`SELECT action FROM "CommissionAudit" WHERE action='RATE_CHANGED'`);
  assert.equal(audits.rows.length,3);
  const oldCount=(await f.pg.query(`SELECT count(*)::integer n FROM "CommissionAudit"`)).rows[0].n;
  await f.store.getSellerCommissionDashboard(1);
  assert.equal((await f.pg.query(`SELECT count(*)::integer n FROM "CommissionAudit"`)).rows[0].n,oldCount,"lectura sin cambios no duplica auditoría");
});

test("excluye septiembre, pendientes, pruebas y duplicados incluso después de anular canónico",async t=>{
  const f=await fixture(t);await f.credits(15);
  const sept=await f.credit({time:"2026-09-30T23:00:00Z"});
  await f.credit({creditDate:"2026-09-20T12:00:00Z"});
  await f.credit({unsigned:true,state:"PENDIENTE"});await f.credit({ready:false});
  await f.credit({snapshot:{testMode:true}});await f.credit({name:"CLIENTE PRUEBA"});
  const originalTest=await f.credit({snapshot:{comisiones:{isTest:true}}});
  await f.pg.query(`UPDATE "Credito" SET "contratoSnapshot"='{}'::jsonb WHERE id=$1`,[originalTest]);
  const canonical=await f.credit({snapshot:{solicitudId:"shared-operation"}});
  await f.credit({sellerId:2,snapshot:{solicitudId:"shared-operation"}});
  let dashboard=await f.store.getSellerCommissionDashboard(1);
  assert.equal(dashboard.periods[0].validCreditCount,16);
  await f.pg.query(`UPDATE "Credito" SET estado='ANULADO' WHERE id=$1`,[canonical]);
  await f.pg.query(`UPDATE "Credito" SET "observacionAdmin"='Corrección histórica' WHERE id=$1`,[sept]);
  dashboard=await f.store.getSellerCommissionDashboard(1);
  assert.equal(dashboard.periods[0].validCreditCount,15);
  assert.equal((await f.store.getSellerCommissionDashboard(2)).periods[0].validCreditCount,0);
});

test("pago parcial + salto a 21 recalcula todo el mes; noviembre reinicia y conserva octubre",async t=>{
  const f=await fixture(t);await f.credits(20);
  const request=await f.store.createCommissionRequest(1,requestInput(100000));
  assert.equal((await f.store.getSellerCommissionDashboard(1)).periods[0].available,300000);
  await f.store.confirmCommissionPayment(request.id,1,receipt());
  await f.credits(1);
  const october=(await f.store.getSellerCommissionDashboard(1)).periods[0];
  assert.equal(october.generated,525000);assert.equal(october.paid,100000);assert.equal(october.available,425000);
  f.setNow("2026-11-01T05:00:00Z");
  const dashboard=await f.store.getSellerCommissionDashboard(1);
  assert.equal(dashboard.currentPeriod,"2026-11");assert.equal(dashboard.periods[0].generated,0);
  assert.equal(dashboard.periods.find(p=>p.period==="2026-10").available,425000);
  assert.equal(dashboard.requests[0].receiptUrl,`/api/comisiones/solicitudes/${request.id}/comprobante`);
});

test("saldo disponible, reservas parciales, solicitudes simultáneas e idempotencia",async t=>{
  const f=await fixture(t);await f.credits(15);
  const paid=await f.store.createCommissionRequest(1,requestInput(200000));await f.store.confirmCommissionPayment(paid.id,1,receipt("paid"));
  const input=requestInput(50000);
  const [first,retry]=await Promise.all([f.store.createCommissionRequest(1,input),f.store.createCommissionRequest(1,input)]);
  assert.equal(first.id,retry.id);
  let period=(await f.store.getSellerCommissionDashboard(1)).periods[0];
  assert.equal(period.reserved,50000);assert.equal(period.available,50000);
  await assert.rejects(f.store.createCommissionRequest(1,requestInput(50001)),/saldo disponible/);
  const concurrent=await Promise.allSettled([f.store.createCommissionRequest(1,requestInput(40000)),f.store.createCommissionRequest(1,requestInput(40000))]);
  assert.equal(concurrent.filter(r=>r.status==="fulfilled").length,1);
  period=(await f.store.getSellerCommissionDashboard(1)).periods[0];assert.equal(period.available,10000);
  await assert.rejects(f.store.createCommissionRequest(1,{...input,amount:1}),/otros datos/);
});

test("rechazo libera reserva; comprobante obligatorio, acceso y confirmación central idempotente",async t=>{
  const f=await fixture(t);await f.credits(15);
  const rejected=await f.store.createCommissionRequest(1,requestInput(50000));
  await assert.rejects(f.store.rejectCommissionRequest(rejected.id,2,"No aprobado"),/administrador central/);
  await f.store.rejectCommissionRequest(rejected.id,1,"Número Nequi equivocado");
  assert.equal((await f.store.getSellerCommissionDashboard(1)).periods[0].available,300000);
  const request=await f.store.createCommissionRequest(1,requestInput(100000));
  await assert.rejects(f.store.confirmCommissionPayment(request.id,1,null),/comprobante/);
  await assert.rejects(f.store.confirmCommissionPayment(request.id,1,{...receipt(),base64:Buffer.from("not pdf").toString("base64")}),/comprobante/);
  await assert.rejects(f.store.confirmCommissionPayment(request.id,2,receipt()),/administrador central/);
  const [first,second]=await Promise.all([f.store.confirmCommissionPayment(request.id,1,receipt()),f.store.confirmCommissionPayment(request.id,1,receipt())]);
  assert.equal(first.status,"PAID");assert.equal(second.status,"PAID");
  assert.equal((await f.pg.query(`SELECT count(*)::integer n FROM "CommissionPayment"`)).rows[0].n,1);
  const file=await f.store.getCommissionReceipt(request.id,{sellerId:1});assert.equal(file.mimeType,"application/pdf");assert.ok(file.bytes.length>0);
  await assert.rejects(f.store.getCommissionReceipt(request.id,{sellerId:2}),/no encontrado/);
  await assert.rejects(f.store.getCommissionReceipt(request.id,{adminUserId:2}),/administrador central/);
  const secondRequest=await f.store.createCommissionRequest(1,requestInput(1));
  await assert.rejects(f.store.confirmCommissionPayment(secondRequest.id,1,receipt()),/otro pago/);
  const rows=await f.store.listAdminCommissionRequests(1);
  assert.equal(rows.find(r=>r.id===request.id).credits.length,15);
  assert.ok(rows.find(r=>r.id===request.id).audit.some(event=>event.action==="PAYMENT_CONFIRMED"));
});

test("anulación cancela reserva sin saldo negativo y detecta déficit de pagos previos",async t=>{
  const f=await fixture(t);const credits=await f.credits(15);
  const paid=await f.store.createCommissionRequest(1,requestInput(100000));await f.store.confirmCommissionPayment(paid.id,1,receipt());
  const pending=await f.store.createCommissionRequest(1,requestInput(150000));
  await f.pg.query(`UPDATE "Credito" SET estado='ANULADO' WHERE id=$1`,[credits[0]]);
  const dashboard=await f.store.getSellerCommissionDashboard(1);
  assert.equal(dashboard.periods[0].available,0);assert.equal(dashboard.periods[0].reserved,0);assert.equal(dashboard.periods[0].adjustment,100000);
  assert.equal(dashboard.requests.find(r=>r.id===pending.id).status,"REJECTED");
  await assert.rejects(f.store.confirmCommissionPayment(pending.id,1,receipt("two")),/no está en trámite/);
  await assert.rejects(f.store.createCommissionRequest(1,requestInput(1)),/saldo disponible/);
  await assert.rejects(f.pg.query(`UPDATE "CommissionPayment" SET amount=1`),/immutable/);
  await assert.rejects(f.pg.query(`DELETE FROM "CommissionAudit"`),/immutable/);
});

test("mora, robo y paz y salvo no eliminan una venta finalizada; vendedor inactivo no bloquea bandeja",async t=>{
  const f=await fixture(t);const credits=await f.credits(15);
  const request=await f.store.createCommissionRequest(1,requestInput(50000));
  for(const state of ["MORA_BLOQUEADO","ROBO_BLOQUEADO","PAZ_Y_SALVO","GENERADO","INSCRITO"]){
    await f.pg.query(`UPDATE "Credito" SET estado=$2,"deliverableReady"=false WHERE id=$1`,[credits[0],state]);
    assert.equal((await f.store.getSellerCommissionDashboard(1)).periods[0].generated,300000);
  }
  await f.pg.query(`UPDATE "Vendedor" SET activo=false WHERE id=1`);
  assert.equal((await f.store.listAdminCommissionRequests(1)).length,1);
  assert.equal((await f.store.confirmCommissionPayment(request.id,1,receipt())).status,"PAID");
});

test("bolsa del aliado: 7.99% habilita, 8% pausa sin alterar saldos y bajar reactiva",async t=>{
  const f=await fixture(t);const creditIds=await f.credits(15);
  await f.pg.query(`UPDATE "Credito" SET "montoCredito"=599250,"fechaPrimerPago"='2026-10-01' WHERE id=$1`,[creditIds[0]]);
  await f.pg.query(`UPDATE "Credito" SET "montoCredito"=400750 WHERE id=$1`,[creditIds[1]]);
  let bag=(await f.store.listAdminCommissionBags(1)).find(item=>item.allyId===1);
  assert.equal(bag.overduePercent,7.99);assert.equal(bag.paused,false);
  const input=requestInput(50000);const request=await f.store.createCommissionRequest(1,input);
  const before=(await f.store.getSellerCommissionDashboard(1)).periods[0];
  await f.pg.query(`UPDATE "Credito" SET "montoCredito"=600000 WHERE id=$1`,[creditIds[0]]);
  await f.pg.query(`UPDATE "Credito" SET "montoCredito"=400000 WHERE id=$1`,[creditIds[1]]);
  bag=(await f.store.listAdminCommissionBags(1)).find(item=>item.allyId===1);
  assert.equal(bag.overduePercent,8);assert.equal(bag.paused,true);
  const paused=await f.store.getSellerCommissionDashboard(1);
  assert.equal(paused.payoutsPaused,true);assert.deepEqual(paused.periods[0],before);
  assert.equal((await f.store.getSellerCommissionDashboard(2)).payoutsPaused,true,"pausa a todos los vendedores del mismo aliado");
  assert.doesNotMatch(JSON.stringify(paused),/overdue|totalBalance|allyName|mora|cartera|8%/i);
  await assert.rejects(f.store.createCommissionRequest(1,requestInput(1)),error=>{
    assert.equal(error.code,"COMMISSION_PAUSED");assert.equal(error.message,"Comisiones temporalmente en pausa");return true;
  });
  assert.equal((await f.store.createCommissionRequest(1,input)).id,request.id,"reintento no crea otra reserva durante pausa");
  assert.equal((await f.store.getSellerCommissionDashboard(1)).periods[0].reserved,50000);
  // An already sent transfer must remain recordable while future withdrawals pause.
  assert.equal((await f.store.confirmCommissionPayment(request.id,1,receipt("pre-pause"))).status,"PAID");
  await f.pg.query(`UPDATE "Credito" SET "montoCredito"=599250 WHERE id=$1`,[creditIds[0]]);
  await f.pg.query(`UPDATE "Credito" SET "montoCredito"=400750 WHERE id=$1`,[creditIds[1]]);
  assert.equal((await f.store.getSellerCommissionDashboard(1)).payoutsPaused,false);
  assert.equal((await f.store.createCommissionRequest(1,requestInput(25000))).status,"PENDING");
  const bags=await f.store.listAdminCommissionBags(1);
  assert.equal(bags.length,3,"admin ve aliados aun sin solicitudes o cartera");
  assert.equal(bags.find(item=>item.allyId===3).paused,false);
  await assert.rejects(f.store.listAdminCommissionBags(2),/administrador central/);
});

test("sin cambios antes del lanzamiento ni fuga de motivo interno de cartera",async t=>{
  const f=await fixture(t);const creditIds=await f.credits(15);
  const request=await f.store.createCommissionRequest(1,requestInput(50000));
  await f.store.rejectCommissionRequest(request.id,1,"Mora 8% del aliado, revisar cartera");
  const dashboard=await f.store.getSellerCommissionDashboard(1);
  assert.doesNotMatch(JSON.stringify(dashboard),/mora|8%|cartera/i);
  assert.equal(dashboard.requests[0].rejectionReason,"La solicitud fue rechazada. Revisa tus datos e intenta nuevamente.");
  assert.match((await f.store.listAdminCommissionRequests(1))[0].rejectionReason,/Mora 8%/);
  await f.pg.query(`UPDATE "Credito" SET "fechaPrimerPago"='2026-09-01' WHERE id=$1`,[creditIds[0]]);
  f.setNow("2026-10-01T04:59:59.999Z");
  const preview=await f.store.getSellerCommissionDashboard(1);
  assert.equal(preview.active,false);assert.equal(preview.payoutsPaused,false);assert.deepEqual(preview.periods,[]);
  assert.deepEqual(await f.store.listAdminCommissionBags(1),[]);
});

test("cambiar asignación de sede no evade pausa del aliado que respalda saldo ganado",async t=>{
  const f=await fixture(t);const creditIds=await f.credits(15);
  await f.pg.query(`UPDATE "Credito" SET "montoCredito"=600000,"fechaPrimerPago"='2026-10-01' WHERE id=$1`,[creditIds[0]]);
  await f.pg.query(`UPDATE "Credito" SET "montoCredito"=400000 WHERE id=$1`,[creditIds[1]]);
  assert.equal((await f.store.getSellerCommissionDashboard(1)).payoutsPaused,true);
  await f.pg.exec(`UPDATE "SedeVendedor" SET activo=false WHERE "vendedorId"=1; INSERT INTO "SedeVendedor" VALUES(2,1,true)`);
  assert.equal((await f.store.getSellerCommissionDashboard(1)).payoutsPaused,true);
  await assert.rejects(f.store.createCommissionRequest(1,requestInput(1)),error=>error.code==="COMMISSION_PAUSED");
});

test("durante pausa sigue acumulando y los pagos reales reactivan sin perder la comisión",async t=>{
  const f=await fixture(t);await f.credits(15);
  await f.pg.exec(`UPDATE "Credito" SET "fechaPrimerPago"='2026-10-01'`);
  const paused15=await f.store.getSellerCommissionDashboard(1);
  assert.equal(paused15.payoutsPaused,true);assert.equal(paused15.periods[0].generated,300000);
  const more=await f.credits(6);
  await f.pg.exec(`UPDATE "Credito" SET "fechaPrimerPago"='2026-10-01'`);
  const paused21=await f.store.getSellerCommissionDashboard(1);
  assert.equal(paused21.payoutsPaused,true);assert.equal(paused21.periods[0].validCreditCount,21);
  assert.equal(paused21.periods[0].generated,525000);assert.equal(paused21.periods[0].available,525000);
  await f.credit({state:"ANULADO",time:"2026-09-01T12:00:00Z"});
  await f.pg.exec(`INSERT INTO "CreditoAbono"("creditoId",valor,estado) SELECT id,"montoCredito",'ANULADO' FROM "Credito" WHERE estado<>'ANULADO'`);
  let bag=(await f.store.listAdminCommissionBags(1)).find(item=>item.allyId===1);
  assert.equal(bag.totalBalance,10500000);assert.equal(bag.overduePercent,100);assert.equal(bag.paused,true);
  await f.pg.query(`INSERT INTO "CreditoAbono"("creditoId",valor,estado) SELECT id,"montoCredito",'ACTIVO' FROM "Credito" WHERE estado<>'ANULADO' AND id<>$1`,[more[5]]);
  assert.equal((await f.store.getSellerCommissionDashboard(1)).payoutsPaused,true,"queda un crédito vencido sin pagar");
  await f.pg.query(`UPDATE "Credito" SET estado='PAZ_Y_SALVO',"pazYSalvoEmitidoAt"='2026-10-20T12:00:00Z' WHERE id=$1`,[more[5]]);
  bag=(await f.store.listAdminCommissionBags(1)).find(item=>item.allyId===1);
  assert.equal(bag.totalBalance,0);assert.equal(bag.overdueBalance,0);assert.equal(bag.paused,false);
  const active=await f.store.getSellerCommissionDashboard(1);
  assert.equal(active.payoutsPaused,false);assert.equal(active.periods[0].generated,525000);
  assert.equal((await f.store.createCommissionRequest(1,requestInput(50000))).status,"PENDING");
});

test("reasignar sede del crédito conserva el aliado histórico que respalda la bolsa",async t=>{
  const f=await fixture(t);await f.credits(15);await f.credits(2,{sellerId:2});
  await f.pg.exec(`UPDATE "Credito" SET "fechaPrimerPago"='2026-10-01' WHERE "vendedorId"=2`);
  assert.equal((await f.store.getSellerCommissionDashboard(1)).payoutsPaused,true);
  await f.pg.exec(`UPDATE "SedeVendedor" SET activo=false WHERE "vendedorId"=1; INSERT INTO "SedeVendedor" VALUES(2,1,true); UPDATE "Credito" SET "sedeId"=2 WHERE "vendedorId"=1`);
  const bags=await f.store.listAdminCommissionBags(1);
  assert.equal(bags.find(item=>item.allyId===2).paused,false,"la nueva sede está al día");
  assert.equal(bags.find(item=>item.allyId===1).paused,true,"la cartera del aliado original sigue vencida");
  assert.equal((await f.store.getSellerCommissionDashboard(1)).payoutsPaused,true);
  const period=(await f.pg.query(`SELECT credits FROM "CommissionPeriod" WHERE "sellerId"=1 AND period='2026-10'`)).rows[0];
  assert.ok(period.credits.every(credit=>credit.allyId===1 && credit.branchId===1));
  await assert.rejects(f.store.createCommissionRequest(1,requestInput(1)),error=>error.code==="COMMISSION_PAUSED");
});
