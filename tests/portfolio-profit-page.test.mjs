import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
const root=fileURLToPath(new URL("../",import.meta.url));
const jiti=createJiti(import.meta.url,{alias:{"@":root}});
const modules=Object.fromEntries(await Promise.all(["portfolio-profit","credit-payment-plan","credit-outstanding-balance","ally-payments-core","credit-factory","cartera-access","credit-display-number"].map(async n=>[`@/lib/${n}`,await jiti.import(`../lib/${n}.ts`)])));
const source=readFileSync(new URL("../app/dashboard/cartera/page.tsx",import.meta.url),"utf8");
const output=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const now=new Date("2026-09-26T17:00:00Z");
class FixedDate extends Date { constructor(...args){super(...(args.length?args:[now]));} }
const allies=[{id:1,nombre:"Aliado uno",codigo:"UNO",redescuentoPorcentaje:10,redescuentoAndroidPorcentaje:10,redescuentoIphonePorcentaje:10},{id:2,nombre:"Aliado dos",codigo:"DOS",redescuentoPorcentaje:10,redescuentoAndroidPorcentaje:10,redescuentoIphonePorcentaje:10}];
function credit(id,{paid=false,historical=false,late=false,ally=1,platform="IPHONE",annulled=false}={}){
 const capital=historical?1_000_000:2_000_000,total=capital*1.2;
 return {id,folio:`QA-${id}`,clienteNombre:`Cliente ${id}`,clienteDocumento:String(id),estado:annulled?"ANULADO":"ACTIVO",referenciaEquipo:`Equipo ${id}`,equipoMarca:platform==="IPHONE"?"Apple":"Samsung",contratoSnapshot:{equipo:{plataforma:platform}},cuotaInicial:0,saldoBaseFinanciado:capital,valorEquipoTotal:capital,valorFianza:0,valorInteres:capital*.2,montoCredito:total,valorCuota:total,plazoMeses:1,frecuenciaPago:"MENSUAL",fechaPrimerPago:late?"2026-09-01":"2026-10-26",fechaProximoPago:late?"2026-09-01":"2026-10-26",pazYSalvoEmitidoAt:paid?now:null,abonos:paid?[{valor:total,fechaAbono:now}]:historical?[]:[{valor:200_000,fechaAbono:now}],sede:{nombre:"Sede",aliado:allies[ally-1]},liquidacionAliadoCredito:historical?null:{valorPagar:paid?1_700_000:1_800_000,valorIntermediacion:paid?300_000:200_000,estado:"PAGADO",liquidacion:{estado:"PAGADA",saldoNeto:100}},vendedor:null};
}
async function render({rows,params={},central=true,ownAlly=1}={}){
 const calls={};const captured={};
 const fits=(row,where)=>!where||(!where.sede||row.sede.aliado.id===where.sede.aliadoId)&&(!where.id||where.id.in.includes(row.id))&&(!where.AND||where.AND.every(w=>fits(row,w)));
 const prisma={aliado:{findMany:async()=>central?allies:allies.filter(x=>x.id===ownAlly)},credito:{findMany:async args=>{if(args.include)calls.credit=args;return rows.filter(r=>fits(r,args.where));}},gastoCartera:{findMany:async args=>{calls.expense=args;return [{valor:100_000}];}}};
 const Empty=()=>null;const Icon=()=>jsxRuntime.jsx("svg",{});
 const deps={...modules,"react/jsx-runtime":jsxRuntime,"next/link":{default:({children,href})=>jsxRuntime.jsx("a",{href,children})},"next/navigation":{redirect:()=>{throw Error("redirect");}},"lucide-react":new Proxy({},{get:()=>Icon}),"@/lib/prisma":{default:prisma},"@/lib/credit-assigned-seller":{resolveCreditAssignedAdministrator:()=>null},"@/lib/dashboard-access":{requireAdminDashboardAccess:async()=>({session:{aliadoAccesoCodigo:central?"FINSERPAY":"UNO",aliadoAccesoId:ownAlly,nombre:"Prueba"}})},"@/lib/credit-display-number-server":{getCreditDisplayNumbers:async()=>new Map(),withCreditDisplayNumber:x=>x},"@/lib/aliados":{ALIADO_FINSER_PAY:{codigo:"FINSERPAY"},ensureAliadoSchema:async()=>{},isFinserPayCentralAlly:x=>x==="FINSERPAY",resolveRedescuentoPercentageByPlatform:(ally,platform)=>platform==="IPHONE"?ally.redescuentoIphonePorcentaje:ally.redescuentoAndroidPorcentaje},"@/app/_components/finser-ui":{Select:({children,...props})=>jsxRuntime.jsx("select",{...props,children})},"../_components/admin-sidebar":{default:Empty},"./push-massive-panel":{default:Empty},"./portfolio-profit-breakdown":{default:props=>{Object.assign(captured,props);return null;}}};
 const loaded={exports:{}};runInNewContext(output,{module:loaded,exports:loaded.exports,require:name=>{assert.ok(name in deps,`Missing dependency ${name}`);return deps[name];},Date:FixedDate,Intl,URLSearchParams});
 const element=await loaded.exports.default({searchParams:Promise.resolve(params)});
 const html=renderToStaticMarkup(element);
 return {captured,calls,html};
}
const fixtures=()=>[credit(1),credit(2,{paid:true}),credit(3,{historical:true,late:true,ally:2,platform:"ANDROID"}),credit(4,{annulled:true})];

test("usa netos registrados sin compensar recaudos, conserva pagados y estima históricos",async()=>{
 const {captured,calls,html}=await render({rows:fixtures()});
 assert.deepEqual({...captured.input},{outstandingBalance:3_400_000,accumulatedCollections:2_600_000,accumulatedInvestment:4_400_000,operatingExpenses:100_000,committedCapital:1_000_000,recognizedProfit:400_000});
 assert.equal(captured.total,100_000);assert.equal(captured.estimatedInvestment,900_000);assert.equal(captured.estimatedCount,1);
 assert.equal(calls.credit.include.liquidacionAliadoCredito.select.valorPagar,true);assert.equal(calls.credit.take,undefined);
 assert.match(html,/Inversión acumulada/);assert.doesNotMatch(html,/Inversion activa/);
});
test("los filtros conservan el mismo alcance de créditos e inversión y no omiten gastos por producto",async()=>{
 const {captured,calls}=await render({rows:fixtures(),params:{aliadoId:"1",plataforma:"IPHONE"}});
 assert.equal(calls.credit.where.AND[0].sede.aliadoId,1);assert.equal(calls.expense.where.sede.aliadoId,1);
 assert.equal(captured.input.accumulatedInvestment,3_500_000);assert.equal(captured.input.accumulatedCollections,2_600_000);assert.equal(captured.input.operatingExpenses,100_000);assert.equal(captured.productFiltered,true);assert.equal(captured.estimatedCount,0);
});
test("al normalizar la mora desaparece el descuento preventivo",async()=>{
 const rows=fixtures();rows[2].fechaPrimerPago="2026-10-26";rows[2].fechaProximoPago="2026-10-26";
 const {captured}=await render({rows});assert.equal(captured.input.committedCapital,0);assert.equal(captured.total,1_100_000);
});
test("el administrador aliado no recibe el desglose de ganancia",async()=>{
 const {captured,html}=await render({rows:fixtures(),central:false});assert.equal(captured.input,undefined);assert.doesNotMatch(html,/Ganancia estimada/);
});
test("incluye inversión histórica más allá de los 1000 registros",async()=>{
 const rows=Array.from({length:1001},(_,i)=>credit(i+1,{historical:true,paid:true}));
 const {captured,calls}=await render({rows,params:{plataforma:"IPHONE"}});
 assert.equal(calls.credit.where.AND[1].id.in.length,1001);assert.equal(captured.input.accumulatedInvestment,900_000*1001);assert.equal(captured.estimatedCount,1001);
});
