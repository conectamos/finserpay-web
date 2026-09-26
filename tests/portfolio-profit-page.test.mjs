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
const modules=Object.fromEntries(await Promise.all(["portfolio-profit","credit-capital","credit-payment-plan","credit-outstanding-balance","ally-payments-core","credit-factory","cartera-access","credit-display-number"].map(async n=>[`@/lib/${n}`,await jiti.import(`../lib/${n}.ts`)])));
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
 return {captured,calls,html,investment:findMetric(element,"Inversión acumulada")};
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


function findMetric(element,label){
 if(!element||typeof element!=="object") return null;
 if(element.props?.label===label) return element.props;
 for(const child of [element.props?.children].flat(Infinity)){
  const found=findMetric(child,label);if(found)return found;
 }
 return null;
}
const money=value=>new Intl.NumberFormat("es-CO",{style:"currency",currency:"COP",maximumFractionDigits:0}).format(value);
function expectInvestment(rendered,amount,detail){
 assert.ok(rendered.investment,"La tarjeta de inversión debe existir en el árbol renderizado");
 assert.equal(rendered.investment.value,money(amount));
 assert.equal(rendered.investment.detail,detail);
 assert.ok(rendered.html.includes(money(amount)),"El monto calculado debe aparecer en el HTML SSR");
 assert.match(rendered.html,/Inversión acumulada/);
 assert.doesNotMatch(rendered.html,/estimada ·|créditos sin liquidación/);
}

test("el aliado ve capital original de activos, pagados e históricos sin restar netos ni redescuentos",async()=>{
 const rows=[credit(1),credit(2,{paid:true}),credit(3,{historical:true,ally:1})];
 const rendered=await render({rows,central:false});
 expectInvestment(rendered,5_000_000,"Capital original · activos y pagados");
 assert.equal(rendered.captured.input,undefined);
 // Changing settlement net amounts must not change historical funded capital.
 rows[0].liquidacionAliadoCredito.valorPagar=1;
 rows[1].liquidacionAliadoCredito.valorPagar=10_000_000;
 rows[0].sede={...rows[0].sede,aliado:{...rows[0].sede.aliado,redescuentoIphonePorcentaje:75}};
 const changed=await render({rows,central:false});
 expectInvestment(changed,5_000_000,"Capital original · activos y pagados");
});

test("el capital original usa saldo base, equipo menos inicial y obligación menos cargos según disponibilidad",async()=>{
 const rows=[credit(1,{historical:true}),credit(2,{historical:true}),credit(3,{historical:true})];
 Object.assign(rows[0],{saldoBaseFinanciado:0,valorEquipoTotal:900_000,cuotaInicial:100_000,montoCredito:1_200_000,valorInteres:200_000,valorFianza:100_000});
 Object.assign(rows[1],{saldoBaseFinanciado:0,valorEquipoTotal:0,cuotaInicial:0,montoCredito:1_500_000,valorInteres:300_000,valorFianza:200_000});
 Object.assign(rows[2],{saldoBaseFinanciado:850_000,valorEquipoTotal:2_000_000,cuotaInicial:500_000,montoCredito:2_000_000,valorInteres:900_000,valorFianza:100_000});
 const rendered=await render({rows,central:false});
 expectInvestment(rendered,2_650_000,"Capital original · activos y pagados");
});

test("la inversión del aliado respeta producto y todas sus sedes e ignora un aliado solicitado ajeno",async()=>{
 const rows=[credit(1),credit(2,{paid:true}),credit(3,{historical:true,ally:1,platform:"ANDROID"}),credit(4,{historical:true,ally:2})];
 rows[1].sede={...rows[1].sede,nombre:"Segunda sede"};
 const all=await render({rows,central:false,params:{aliadoId:"2"}});
 expectInvestment(all,5_000_000,"Capital original · activos y pagados");
 assert.equal(all.calls.credit.where.sede.aliadoId,1);
 const iphone=await render({rows,central:false,params:{plataforma:"IPHONE"}});
 expectInvestment(iphone,4_000_000,"Capital original · activos y pagados");
 assert.equal(iphone.calls.credit.where.AND[0].sede.aliadoId,1);
 const android=await render({rows,central:false,params:{plataforma:"ANDROID"}});
 expectInvestment(android,1_000_000,"Capital original · activos y pagados");
});

test("los anulados y cancelados no aumentan inversión original del aliado",async()=>{
 const rows=[credit(1),...["ANULADO","ANULADA","CANCELADO","CANCELADA"].map((estado,index)=>({...credit(index+2),estado}))];
 const rendered=await render({rows,central:false});
 expectInvestment(rendered,2_000_000,"Capital original · activos y pagados");
});

test("central conserva inversión neta de ganancia y detalle sin texto de estimación en la tarjeta",async()=>{
 const rendered=await render({rows:fixtures()});
 expectInvestment(rendered,4_400_000,"Neto por crédito · activos y pagados");
 assert.equal(rendered.captured.input.accumulatedInvestment,4_400_000);
 assert.equal(rendered.captured.total,100_000);
 assert.equal(rendered.captured.estimatedInvestment,900_000);
 assert.equal(rendered.captured.estimatedCount,1);
});

test("el aliado conserva capital original histórico cuando supera mil registros",async()=>{
 const rows=Array.from({length:1001},(_,index)=>credit(index+1,{historical:true,paid:true}));
 const rendered=await render({rows,central:false,params:{plataforma:"IPHONE"}});
 expectInvestment(rendered,1_001_000_000,"Capital original · activos y pagados");
 assert.equal(rendered.calls.credit.take,undefined);
});
