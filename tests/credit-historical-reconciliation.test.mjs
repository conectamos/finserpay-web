import assert from "node:assert/strict";
import test from "node:test";
import {createJiti} from "jiti";
const jiti=createJiti(import.meta.url,{alias:{"@":new URL('../',import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/,'')}});
const {validateHistoricalSource,historicalSnapshot}=await jiti.import('../lib/credit-historical-reconciliation.ts');
const {buildCreditPaymentPlan}=await jiti.import('../lib/credit-payment-plan.ts');
const source=()=>({documento:'12345678',folioFinser:'TEST-ONLY',fuente:'Documento de prueba conciliado',capitalInicial:1000,capitalExtraordinario:180,tasaPeriodo:.01,numeroUltimaCuotaPagada:1,saldoCapitalTrasUltimoAbono:720,
 cuotas:[{numero:1,fechaVencimiento:'2026-07-17',capital:100,interes:20,otros:60,seguro:0,totalCuota:180,saldoCapital:900},{numero:2,fechaVencimiento:'2026-08-02',capital:400,interes:8,otros:60,seguro:0,totalCuota:468,saldoCapital:320},{numero:3,fechaVencimiento:'2026-08-17',capital:320,interes:4,otros:60,seguro:0,totalCuota:384,saldoCapital:0},{numero:4,fechaVencimiento:'2026-09-02',capital:0,interes:0,otros:0,seguro:0,totalCuota:0,saldoCapital:0}],
 abonos:[{fecha:'2026-07-17',total:400,capital:280,interes:20,mora:0,otros:100,seguro:0,saldoCapital:720,documento:'TEST-RECIBO'}]});
test('conserva exactamente capital, calendario, abonos y cuotas eliminadas sin inventar recaudos',()=>{
 const s=validateHistoricalSource(source());const snapshot=historicalSnapshot(s,[{id:42,valor:400}]);
 const plan=buildCreditPaymentPlan({montoCredito:1252,valorCuota:468,plazoMeses:4,frecuenciaPago:'QUINCENAL',fechaPrimerPago:new Date('2026-07-17T12:00:00Z'),planCapitalVigente:snapshot,abonos:[{valor:400}],today:new Date('2026-07-20T12:00:00Z')});
 assert.equal(plan.saldoPendiente,852);assert.equal(plan.overdueCount,0);assert.equal(plan.paidCount,1);assert.equal(plan.nextInstallment.fechaVencimiento,'2026-08-02');assert.equal(snapshot.totalAbonadoAlCorte,400);assert.equal(snapshot.saldoCapitalAlCorte,720);assert.equal(snapshot.cuotas.at(-1).eliminada,true);
});
test('rechaza errores en componentes, capital, comprobantes y fechas antes de escribir',()=>{
 for(const mutate of [s=>s.cuotas[1].capital++,s=>s.cuotas[1].saldoCapital++,s=>s.cuotas[1].fechaVencimiento='2026-07-17',s=>s.abonos[0].total++,s=>s.abonos[0].saldoCapital++,s=>s.abonos.push({...s.abonos[0]}),s=>s.numeroUltimaCuotaPagada=2,s=>s.capitalExtraordinario++]) {const s=source();mutate(s);assert.throws(()=>validateHistoricalSource(s));}
});
test('rechaza IDs o importes de recaudos que no coinciden con la conciliación',()=>{
 const s=validateHistoricalSource(source());assert.throws(()=>historicalSnapshot(s,[]));assert.throws(()=>historicalSnapshot(s,[{id:42,valor:401}]));
});

import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const lib=await jiti.import('../lib/credit-historical-reconciliation.ts');
const code=ts.transpileModule(readFileSync(new URL('../app/api/creditos/[id]/conciliacion-historica/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness({role='ADMIN',central=true,user=true}={}){
 const credit={id:7,clienteDocumento:'12345678',clienteNombre:'CLIENTE PRUEBA',folio:'TEST-ONLY',equalityService:'IMPORTACION_MASIVA',contratoSnapshot:{origen:{tipo:'IMPORTACION_MASIVA'}},estado:'GENERADO',sedeId:9,planCapitalVigente:null,montoCredito:1500,valorCuota:468,plazoMeses:4,frecuenciaPago:'QUINCENAL',fechaPrimerPago:new Date('2026-07-17T12:00:00Z')};
 const payments=[{id:99,valor:400,metodoPago:'EFECTIVO',fechaAbono:new Date('2026-07-17T12:00:00Z'),estado:'ACTIVO'}],writes=[],cash=[];let revision=null;
 const tx={$queryRaw:async()=>[],credito:{findUnique:async()=>({...credit}),update:async({data})=>{writes.push('credit');Object.assign(credit,data);}},creditoAbono:{findMany:async()=>payments.filter(p=>p.estado!=='ANULADO'),update:async({where,data})=>{writes.push('annul');Object.assign(payments.find(p=>p.id===where.id),data);},create:async({data})=>{writes.push('payment');const p={id:100+payments.length,estado:'ACTIVO',...data};payments.push(p);return p;}},wompiPaymentIntent:{count:async()=>0},cajaMovimiento:{findMany:async()=>[{descripcion:'ABONO_CREDITO_ID:99 | original',valor:400,sedeId:9},{descripcion:'ABONO_CREDITO_ID:999 | distinto',valor:999,sedeId:9}],create:async({data})=>{writes.push('cash');cash.push(data);}}};
 const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const deps={'next/server':{NextResponse:{json:Response.json}},'@/lib/prisma':{default:{$transaction:async cb=>cb(tx)}},'@/lib/auth':{getSessionUser:async()=>user?{id:5,rolNombre:role,aliadoAccesoCodigo:central?'FINSERPAY':'ALLY'}:null},'@/lib/roles':{isAdminRole:r=>r==='ADMIN'},'@/lib/aliados':{isFinserPayCentralAlly:c=>c==='FINSERPAY'},'@/lib/credit-abono-audit':{ensureCreditAbonoAuditColumns:async()=>{}},'@/lib/credit-historical-reconciliation':lib,'@/lib/credit-payment-plan':{buildCreditPaymentPlan},'@/lib/credit-principal-payment-storage':{hashPrincipalPayment:hash,findPrincipalPaymentRevision:async()=>revision,persistPrincipalPaymentRevision:async(_,data)=>{writes.push('audit');revision={resultado:data.resultado};}},'@/lib/credit-factory':{CREDIT_ABONO_CAJA_MARKER:'ABONO_CREDITO_ID:',creditCajaDescription:p=>`ABONO_CREDITO_ID:${p.id}`}};
 const loaded={exports:{}};runInNewContext(code,{module:loaded,exports:loaded.exports,require:n=>{assert.ok(n in deps,n);return deps[n];},Request,Response,URL,Date,console});
 return {writes,cash,payments,credit,call:body=>loaded.exports.POST(new Request('https://finserpay.com/api/creditos/7/conciliacion-historica',{method:'POST',headers:{origin:'https://finserpay.com'},body:JSON.stringify({source:source(),accion:'PREVISUALIZAR',...body})}),{params:Promise.resolve({id:'7'})})};
}
test('sin sesión, aliado y vendedor no pueden consultar ni escribir conciliaciones',async()=>{
 for(const options of [{user:false},{central:false},{role:'VENDEDOR'}]){const f=harness(options),r=await f.call();assert.ok([401,403].includes(r.status));assert.equal(f.writes.length,0);}
});
test('previsualización no escribe y un hash obsoleto no aplica el ajuste',async()=>{
 const f=harness(),r=await f.call();assert.equal(r.status,200);assert.equal(f.writes.length,0);const failed=await f.call({accion:'CONFIRMAR',previewHash:'stale'});assert.equal(failed.status,400);assert.equal(f.writes.length,0);
});
test('confirma con reversa exacta, conserva originales y auditoría; reintentar no duplica',async()=>{
 const f=harness(),preview=await (await f.call()).json();const applied=await f.call({accion:'CONFIRMAR',previewHash:preview.previewHash});assert.equal(applied.status,200);const body=await applied.json();assert.equal(body.aplicado,true);assert.equal(f.payments[0].estado,'ANULADO');assert.equal(f.payments.filter(p=>p.estado==='ACTIVO').length,1);assert.equal(f.cash.filter(p=>p.tipo==='EGRESO').length,1);assert.equal(f.cash.find(p=>p.tipo==='EGRESO').valor,400);assert.ok(f.writes.includes('audit'));const count=f.writes.length;const retry=await f.call({accion:'CONFIRMAR',previewHash:preview.previewHash});assert.equal(retry.status,200);assert.equal(f.writes.length,count);
});
