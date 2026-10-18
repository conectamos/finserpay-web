import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { load, nodes, ui } from "./cartera-ui-harness.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
const jiti=createJiti(import.meta.url,{alias:{"@":root}});
const modules=Object.fromEntries(await Promise.all(["portfolio-profit","credit-capital","credit-payment-plan","credit-outstanding-balance","ally-payments-core","credit-factory","cartera-access","credit-display-number"].map(async n=>[`@/lib/${n}`,await jiti.import(`../lib/${n}.ts`)])));
const source=readFileSync(new URL("../app/dashboard/cartera/page.tsx",import.meta.url),"utf8");
const output=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const now=new Date("2026-09-26T17:00:00Z");
class FixedDate extends Date { constructor(...args){super(...(args.length?args:[now]));} }
const allies=[{id:1,nombre:"Aliado uno",codigo:"UNO",redescuentoPorcentaje:10,redescuentoAndroidPorcentaje:10,redescuentoIphonePorcentaje:10},{id:2,nombre:"Aliado dos",codigo:"DOS",redescuentoPorcentaje:10,redescuentoAndroidPorcentaje:10,redescuentoIphonePorcentaje:10}];
const styles = new Proxy({}, { get: (_, name) => String(name) });
const Link = ({ children, href, ...props }) => jsxRuntime.jsx("a", { ...props, href, children });
const Icon = () => jsxRuntime.jsx("svg", {});
const FinserNavigation = load("../app/dashboard/_components/finser-navigation.tsx", {
 "next/link": { default: Link },
 "lucide-react": new Proxy({}, { get: () => Icon }),
 "@/app/_components/finser-brand": { default: () => jsxRuntime.jsx("span", { children: "FINSER PAY" }) },
 "./central-dashboard-menu": { default: ({ children, label }) => jsxRuntime.jsxs("details", { children: [jsxRuntime.jsx("summary", { children: label }), children] }) },
 "./logout-button": { default: () => jsxRuntime.jsx("button", { children: "Cerrar sesión" }) },
 "./finser-navigation.module.css": { default: styles },
}).default;
function credit(id,{paid=false,historical=false,late=false,ally=1,platform="IPHONE",annulled=false}={}){
 const capital=historical?1_000_000:2_000_000,total=capital*1.2;
 return {id,folio:`QA-${id}`,clienteNombre:`Cliente ${id}`,clienteDocumento:String(id),estado:annulled?"ANULADO":"ACTIVO",referenciaEquipo:`Equipo ${id}`,equipoMarca:platform==="IPHONE"?"Apple":"Samsung",contratoSnapshot:{equipo:{plataforma:platform}},cuotaInicial:0,saldoBaseFinanciado:capital,valorEquipoTotal:capital,valorFianza:0,valorInteres:capital*.2,montoCredito:total,valorCuota:total,plazoMeses:1,frecuenciaPago:"MENSUAL",fechaPrimerPago:late?"2026-09-01":"2026-10-26",fechaProximoPago:late?"2026-09-01":"2026-10-26",pazYSalvoEmitidoAt:paid?now:null,abonos:paid?[{valor:total,fechaAbono:now}]:historical?[]:[{valor:200_000,fechaAbono:now}],sede:{nombre:"Sede",aliado:allies[ally-1]},liquidacionAliadoCredito:historical?null:{valorPagar:paid?1_700_000:1_800_000,valorIntermediacion:paid?300_000:200_000,estado:"PAGADO",liquidacion:{estado:"PAGADA",saldoNeto:100}},vendedor:null};
}
async function render({rows,params={},central=true,ownAlly=1}={}){
 const calls={};const captured={};let navigation;
 const fits=(row,where)=>!where||(!where.sede||row.sede.aliado.id===where.sede.aliadoId)&&(!where.id||where.id.in.includes(row.id))&&(!where.AND||where.AND.every(w=>fits(row,w)));
 const prisma={aliado:{findMany:async()=>central?allies:allies.filter(x=>x.id===ownAlly)},credito:{findMany:async args=>{if(args.include)calls.credit=args;return rows.filter(r=>fits(r,args.where));}},gastoCartera:{findMany:async args=>{calls.expense=args;return [{valor:100_000}];}}};
 const deps={...modules,"react/jsx-runtime":jsxRuntime,"next/link":{default:Link},"next/navigation":{redirect:()=>{throw Error("redirect");}},"lucide-react":new Proxy({},{get:()=>Icon}),"@/lib/prisma":{default:prisma},"@/lib/credit-assigned-seller":{resolveCreditAssignedAdministrator:()=>null},"@/lib/dashboard-access":{requireAdminDashboardAccess:async()=>({session:{aliadoAccesoCodigo:central?"FINSERPAY":"UNO",aliadoAccesoId:ownAlly,nombre:"Prueba",rolNombre:"ADMIN"}})},"@/lib/credit-display-number-server":{getCreditDisplayNumbers:async()=>new Map(),withCreditDisplayNumber:x=>x},"@/lib/aliados":{ALIADO_FINSER_PAY:{codigo:"FINSERPAY"},ensureAliadoSchema:async()=>{},isFinserPayCentralAlly:x=>x==="FINSERPAY",resolveRedescuentoPercentageByPlatform:(ally,platform)=>platform==="IPHONE"?ally.redescuentoIphonePorcentaje:ally.redescuentoAndroidPorcentaje},"@/app/_components/finser-ui":ui,"../_components/finser-navigation":{default:props=>{navigation=props;return jsxRuntime.jsx(FinserNavigation,props);}},"./cartera.module.css":{default:styles},"./push-massive-panel":{default:()=>jsxRuntime.jsx("section",{"aria-label":"Gestión masiva",children:"PUSH_DE_PRUEBA"})},"./cuotavencida-whatsapp-button":{default:()=>jsxRuntime.jsx("button",{children:"WHATSAPP_DE_PRUEBA"})},"./portfolio-profit-breakdown":{default:props=>{Object.assign(captured,props);return null;}}};
 const loaded={exports:{}};runInNewContext(output,{module:loaded,exports:loaded.exports,require:name=>{assert.ok(name in deps,`Missing dependency ${name}`);return deps[name];},Date:FixedDate,Intl,URLSearchParams});
 const element=await loaded.exports.default({searchParams:Promise.resolve(params)});
 const html=renderToStaticMarkup(element);
 return {captured,calls,html,element,navigation,investment:findMetric(element,"Inversión acumulada")};
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

function linksIn(html) {
 return [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map(match => match[1].replaceAll("&amp;", "&"));
}

test("central recibe navegación de cartera, exportación filtrada y acciones financieras autorizadas",async()=>{
 const rendered=await render({rows:fixtures(),params:{aliadoId:"1",plataforma:"IPHONE"}});
 assert.deepEqual({...rendered.navigation},{admin:true,variant:"requests",activeSection:"portfolio",adminCentral:true,nombreUsuario:"Prueba",rolUsuario:"ADMIN"});
 const links=linksIn(rendered.html);
 for (const href of ["/dashboard/cartera","/dashboard/cartera/detalle-mora","/dashboard/riesgo-referencia","/dashboard/financiero/cartera","/dashboard/financiero/cartera/detalle"]) {
  assert.ok(links.includes(href),`Acceso vigente: ${href}`);
 }
 assert.ok(links.includes("/api/dashboard/cartera/export?aliadoId=1&plataforma=IPHONE"));
 assert.match(rendered.html,/PUSH_DE_PRUEBA/);
 assert.match(rendered.html,/WHATSAPP_DE_PRUEBA/);
 assert.match(rendered.html,/<h1>Cartera<\/h1>/);
 assert.match(rendered.html,/Perfil de Prueba/);
});

test("aliado conserva su Excel y navegación sin recibir acciones ni información reservada a central",async()=>{
 const rendered=await render({rows:fixtures(),central:false,params:{aliadoId:"2",plataforma:"IPHONE"}});
 assert.equal(rendered.navigation.adminCentral,false);
 assert.equal(rendered.navigation.activeSection,"portfolio");
 const links=linksIn(rendered.html);
 assert.ok(links.includes("/api/dashboard/cartera/export?aliadoId=1&plataforma=IPHONE"),"el Excel debe quedar limitado al aliado de la sesión");
 assert.ok(links.includes("/dashboard/cartera/detalle-mora"));
 assert.ok(links.includes("/dashboard/reportes/recaudo-por-corte"));
 assert.ok(!links.includes("/dashboard/financiero/cartera"));
 assert.ok(!links.includes("/dashboard/financiero/cartera/detalle"));
 assert.doesNotMatch(rendered.html,/PUSH_DE_PRUEBA|WHATSAPP_DE_PRUEBA|Ganancia estimada|Saldo por cobrar/);
 assert.equal(nodes(rendered.element,node=>node.type===ui.Select&&node.props.name==="aliadoId").length,0);
 const product=nodes(rendered.element,node=>node.type===ui.Select&&node.props.name==="plataforma")[0];
 assert.equal(product.props.defaultValue,"IPHONE");
});

test("ambos alcances conservan tabla completa desplazable por teclado y métricas adaptables",async()=>{
 for(const central of [true,false]) {
  const rendered=await render({rows:[credit(1,{late:true})],central});
  const container=nodes(rendered.element,node=>node.type==="main")[0];
  assert.equal(container.props.className,"content");
  const metrics=nodes(rendered.element,node=>node.props?.["aria-label"]==="Resumen de cartera")[0];
  assert.equal(metrics.props.className,`metrics ${central?"centralMetrics":"allyMetrics"}`);
  const tableRegion=nodes(rendered.element,node=>node.props?.role==="region"&&node.props?.["aria-label"]?.startsWith("Créditos en mora"))[0];
  assert.equal(tableRegion.props.tabIndex,0,"en móvil y teclado se puede consultar todo el detalle horizontal");
  assert.equal(tableRegion.props.className,"tableScroll");
  const headers=nodes(tableRegion,node=>node.type==="th");
  assert.equal(headers.length,12);
  for(const label of ["Documento","Celular","Ref. familiar","Número crédito","Equipo","Capital pendiente","Cuota"]) {
   assert.ok(headers.some(node=>node.props.children===label),`Columna preservada: ${label}`);
  }
  assert.match(rendered.html,/Cliente 1/);
  assert.ok(linksIn(rendered.html).some(href=>href.startsWith("/api/dashboard/cartera/export?")&&new URL(href,"https://finserpay.test").searchParams.get("scope")==="mora"));
  assert.doesNotMatch(rendered.html,/<aside/);
 }
});
