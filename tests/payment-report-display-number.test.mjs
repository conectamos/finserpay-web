import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(file, dependencies = {}, globals = {}, extra = "") {
  const source = readFileSync(new URL("../" + file, import.meta.url), "utf8") + extra;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, URL, Request, Response, Date, Blob, console, ...globals,
    require(name) { assert.ok(name in dependencies, "Unexpected dependency: " + name); return dependencies[name]; },
  }, { filename: file });
  return loaded.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const display = load("lib/credit-display-number.ts");
const roles = load("lib/roles.ts");
const dates = load("lib/colombia-date.ts");
const paymentMethods = load("lib/payment-methods.ts");
const allies = load("lib/aliados.ts");
const factory = load("lib/credit-factory.ts", { "@/lib/colombia-date": dates, "@/lib/payment-methods": paymentMethods });
const site = { id: 10, nombre: "Sede QA", codigo: "QA", aliadoId: 5, aliado: { nombre: "Aliado QA", codigo: "ALIADO" } };
const user = { id: 1, nombre: "Admin aliado", rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO", aliadoAccesoId: 5, sedeId: 10 };
const credit = { id: 31, folio: "FC-ORIGINAL-31", clienteNombre: "Cliente QA", clienteDocumento: "00100031", montoCredito: 1000, cuotaInicial: 200, estado: "INSCRITO", sedeId: 10 };
const payment = { id: 11, credito: credit, valor: 100, metodoPago: "EFECTIVO", observacion: "", estado: "ACTIVO", fechaAbono: new Date("2026-09-17T12:00:00Z"), usuario: { id: 1, nombre: "Recaudador QA", usuario: "qa" }, vendedor: null, sede: site };

test("abonos devuelve número confirmado y busca dentro del aliado autorizado sin cambiar folio o montos", async () => {
  const calls = [];
  const database = {
    credito: { findMany: async query => { calls.push(["credits", plain(query)]); return [credit]; } },
    creditoAbono: {
      findMany: async query => { calls.push(["payments", plain(query)]); return [payment]; },
      groupBy: async () => [{ creditoId: 31, _sum: { valor: 100 }, _count: { _all: 1 } }],
    },
    creditSadminRegistration: { findMany: async query => {
      calls.push(["numbers", plain(query)]);
      return [{ creditoId: 31, numeroCredito: "000031-A", numeroCreditoConfirmado: true }];
    } },
  };
  const displayServer = load("lib/credit-display-number-server.ts", { "server-only": {}, "@/lib/prisma": { default: database }, "@/lib/credit-display-number": display });
  const route = load("app/api/reportes/abonos-credito/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/prisma": { default: database },
    "@/lib/auth": { getSessionUser: async () => user }, "@/lib/seller-auth": { getSellerSessionUser: async () => null },
    "@/lib/roles": roles, "@/lib/aliados": { isFinserPayCentralAlly: () => false },
    "@/lib/credit-factory": factory, "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-display-number-server": displayServer,
    "@/lib/digital-collection-sede": { DIGITAL_COLLECTION_SEDE_CODE: "RECAUDO_DIGITAL", DIGITAL_COLLECTION_SEDE_NAME: "RECAUDO DIGITAL FINSER PAY" },
  });
  const response = await route.GET(new Request("https://finserpay.test/api/reportes/abonos-credito?search=000031-A&aliadoId=99"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items[0].credito.id, 31);
  assert.equal(body.items[0].credito.folio, "FC-ORIGINAL-31");
  assert.equal(body.items[0].credito.numeroCreditoVisible, "000031-A");
  assert.equal(body.items[0].credito.numeroSadmin, "000031-A");
  assert.equal(body.items[0].valor, 100);
  assert.equal(body.summary.totalRecaudadoPeriodo, 100);
  assert.equal(credit.numeroCreditoVisible, undefined);
  const creditQuery = calls.find(([name]) => name === "credits")[1];
  const paymentsQuery = calls.find(([name]) => name === "payments")[1];
  assert.equal(paymentsQuery.take, undefined);
  for (const query of [creditQuery, paymentsQuery]) assert.deepEqual(query.where.sede, { aliadoId: 5 });
  assert.deepEqual(creditQuery.where.OR.find(condition => condition.OR), plain(displayServer.creditNumberSearchWhere("000031-A")));
  assert.deepEqual(paymentsQuery.where.OR.find(condition => condition.credito?.OR), { credito: plain(displayServer.creditNumberSearchWhere("000031-A")) });
  assert.deepEqual(calls.find(([name]) => name === "numbers")[1].where,
    { creditoId: { in: [31] }, numeroCreditoConfirmado: true, numeroCredito: { not: null } });
});


function harness({session=user,seller=null,rows=[payment],credits=[credit],registrations=[],groups=[{creditoId:31,_sum:{valor:100},_count:{_all:1}}]}={}){
 const calls=[];const database={credito:{findMany:async query=>{calls.push(["credits",plain(query)]);return credits;}},creditoAbono:{findMany:async query=>{calls.push(["payments",plain(query)]);return rows;},groupBy:async query=>{calls.push(["groups",plain(query)]);return groups;}},creditSadminRegistration:{findMany:async query=>{calls.push(["numbers",plain(query)]);return registrations.filter(row=>query.where.creditoId.in.includes(row.creditoId)&&row.numeroCreditoConfirmado&&row.numeroCredito!==null);}}};
 const displayServer=load("lib/credit-display-number-server.ts",{"server-only":{},"@/lib/prisma":{default:database},"@/lib/credit-display-number":display});
 const route=load("app/api/reportes/abonos-credito/route.ts",{"next/server":{NextResponse:Response},"@/lib/prisma":{default:database},"@/lib/auth":{getSessionUser:async()=>session},"@/lib/seller-auth":{getSellerSessionUser:async()=>seller},"@/lib/roles":roles,"@/lib/aliados":allies,"@/lib/credit-factory":factory,"@/lib/credit-abono-audit":{ensureCreditAbonoAuditColumns:async()=>{}},"@/lib/credit-display-number-server":displayServer,"@/lib/digital-collection-sede":{DIGITAL_COLLECTION_SEDE_CODE:"RECAUDO_DIGITAL",DIGITAL_COLLECTION_SEDE_NAME:"RECAUDO DIGITAL FINSER PAY"}});
 return{calls,get:(query="")=>route.GET(new Request("https://qa.test/api/reportes/abonos-credito"+query))};
}
test("más de 500 resultados forman el resumen diario completo y excluyen anulados",async()=>{
 const rows=Array.from({length:605},(_,i)=>({...payment,id:i+1,valor:100.25,fechaAbono:new Date("2026-10-07T04:15:00Z")}));
 rows.push({...payment,id:606,valor:300,estado:"ANULADO"},{...payment,id:607,valor:400,credito:{...credit,estado:"ANULADO"}});
 const api=harness({rows});const body=await(await api.get()).json();
 assert.equal(body.items.length,607);assert.equal(body.summary.totalAbonos,605);assert.equal(body.summary.totalRecaudadoPeriodo,60651.25);
 assert.deepEqual(body.byDay,[{fecha:"2026-10-06",cantidad:605,total:60651.25}]);assert.equal(api.calls.find(([name])=>name==="payments")[1].take,undefined);
});
test("fechas solo afectan pagos del período y no redefinen recaudo general ni créditos al día",async()=>{
 const api=harness({session:{...user,aliadoAccesoCodigo:"FINSERPAY"},rows:[{...payment,valor:75.09}],credits:[credit,{...credit,id:32,montoCredito:500}],groups:[{creditoId:31,_sum:{valor:300.25},_count:{_all:3}},{creditoId:32,_sum:{valor:500},_count:{_all:5}}]});
 const body=await(await api.get("?from=2026-10-01&to=2026-10-07")).json();
 assert.equal(body.summary.totalRecaudadoPeriodo,75.09);assert.equal(body.summary.totalRecaudadoGeneral,800.25);assert.equal(body.summary.totalPendientePorCobrar,699.75);assert.equal(body.summary.creditosAlDia,1);
 const credits=api.calls.find(([name])=>name==="credits")[1];assert.equal(credits.where.fechaCredito,undefined);
 const payments=api.calls.find(([name])=>name==="payments")[1];assert.deepEqual(payments.where.fechaAbono,{gte:"2026-10-01T05:00:00.000Z",lte:"2026-10-08T04:59:59.999Z"});
 assert.equal(api.calls.find(([name])=>name==="groups")[1].where.fechaAbono,undefined);
});
test("Sadmin faltante o sin confirmar conserva el estado y el folio",async()=>{
 const api=harness({registrations:[{creditoId:31,numeroCreditoConfirmado:false,numeroCredito:"999999"}]});const body=await(await api.get()).json();
 assert.equal(body.items[0].credito.numeroSadmin,null);assert.equal(body.items[0].credito.folio,credit.folio);assert.equal(body.items[0].estado,"ACTIVO");assert.equal(body.items[0].credito.estado,"INSCRITO");
});
test("permiso y alcance del supervisor, aliado y central permanecen separados",async()=>{
 for(const [session,seller,status]of [[null,null,401],[{...user,rolNombre:"VENDEDOR"},{tipoPerfil:"VENDEDOR"},403],[{...user,rolNombre:"ANALISTA"},null,403]]){const api=harness({session,seller});assert.equal((await api.get()).status,status);assert.equal(api.calls.length,0);}
 const api=harness({session:{...user,rolNombre:"VENDEDOR"},seller:{tipoPerfil:"SUPERVISOR"}});assert.equal((await api.get("?sedeId=99&aliadoId=99")).status,200);for(const [name,query]of api.calls.filter(([name])=>["credits","payments"].includes(name))){assert.equal(query.where.sedeId,10,name);assert.equal(query.where.sede,undefined);}
 const central=harness({session:{...user,aliadoAccesoCodigo:"FINSERPAY"}});await central.get("?sedeId=20&aliadoId=99");for(const [,query]of central.calls.filter(([name])=>["credits","payments"].includes(name))){assert.deepEqual(query.where.sede,{aliadoId:99});assert.equal(query.where.sedeId,20);}
});

function assertPrivate(response) {
 assert.match(response.headers.get("cache-control"), /private, no-store/);
 assert.equal(response.headers.get("vary"), "Cookie");
 assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("solo admin central recibe los dos totales generales; aliado y supervisor conservan período, registros y alcance", async () => {
 const common = { rows: [{...payment, valor:75.09}], credits:[credit,{...credit,id:32,montoCredito:500}],
   groups:[{creditoId:31,_sum:{valor:300.25},_count:{_all:3}},{creditoId:32,_sum:{valor:500},_count:{_all:5}}] };
 const central = harness({...common, session:{...user,aliadoAccesoCodigo:"FINSERPAY"}});
 const centralResponse = await central.get("?from=2026-10-01&to=2026-10-07&aliadoId=5&sedeId=10");
 assertPrivate(centralResponse);
 const original = await centralResponse.json();
 assert.equal(original.summary.totalPendientePorCobrar,699.75);
 assert.equal(original.summary.totalRecaudadoGeneral,800.25);
 const {totalPendientePorCobrar,totalRecaudadoGeneral,...allowedSummary} = original.summary;
 assert.deepEqual(allowedSummary,{totalAbonos:1,totalRecaudadoPeriodo:75.09,totalCreditos:2,creditosAlDia:1});
 for (const [session,seller,supervisor] of [
   [user,null,false],
   [{...user,rolNombre:"VENDEDOR"},{tipoPerfil:"SUPERVISOR"},true],
   [{...user,rolNombre:"VENDEDOR",aliadoAccesoCodigo:"FINSERPAY"},{tipoPerfil:"SUPERVISOR"},true],
 ]) {
   const api=harness({...common,session,seller});
   const response=await api.get("?from=2026-10-01&to=2026-10-07&aliadoId=99&sedeId="+(supervisor?"99":"10")+
     "&adminCentral=true&central=true&rolNombre=ADMIN&aliadoAccesoCodigo=FINSERPAY&includeFinancial=true");
   assert.equal(response.status,200);assertPrivate(response);
   const body=await response.json();
   assert.deepEqual(body.summary,allowedSummary);
   assert.equal(Object.hasOwn(body.summary,"totalPendientePorCobrar"),false);
   assert.equal(Object.hasOwn(body.summary,"totalRecaudadoGeneral"),false);
   assert.doesNotMatch(JSON.stringify(body),/totalPendientePorCobrar|totalRecaudadoGeneral|699\.75|800\.25/);
   assert.deepEqual(body.items,original.items);assert.deepEqual(body.byDay,original.byDay);
   for(const [,query]of api.calls.filter(([name])=>["credits","payments"].includes(name))) {
     assert.equal(query.where.sedeId,10);
     if(supervisor)assert.equal(query.where.sede,undefined);
     else assert.deepEqual(query.where.sede,{aliadoId:5});
   }
   assert.deepEqual(api.calls.find(([name])=>name==="groups")[1].where,{creditoId:{in:[31,32]},estado:{not:"ANULADO"}});
 }
});

test("respuestas sin sesión o sin permiso también impiden caché compartida",async()=>{
 for(const options of [{session:null},{session:{...user,rolNombre:"VENDEDOR"},seller:{tipoPerfil:"VENDEDOR"}}]) {
   const api=harness(options);const response=await api.get("?adminCentral=true");
   assert.equal(response.status,options.session?403:401);assertPrivate(response);assert.equal(api.calls.length,0);
 }
});
