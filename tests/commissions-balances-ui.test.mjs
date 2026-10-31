import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx=(type,props,key)=>({type,props:props||{},key});
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==="object"?[tree,...nodes(tree.props?.children)]:[];
const text=tree=>Array.isArray(tree)?tree.map(text).join(""):tree&&typeof tree==="object"?text(tree.props?.children):typeof tree==="string"||typeof tree==="number"?String(tree):"";
const row=(id=1,patch={})=>({sellerId:id,sellerName:`Asesor de prueba ${id}`,sellerActive:true,period:"2026-10",branches:[{id:3,name:"Sede de origen"}],validCreditCount:15,rate:20_000,generated:300_000,paid:100_000,reserved:40_000,available:160_000,adjustment:0,outstanding:200_000,payoutsPaused:false,...patch});
const totals={sellers:2,validCreditCount:50,generated:1_734_567,paid:500_000,reserved:434_567,available:800_000,adjustment:0,outstanding:1_234_567};
const payload=(patch={})=>({currentPeriod:"2026-11",serverNow:"2026-11-01T06:00:00.000Z",periods:["2026-11","2026-10"],rows:[row()],total:1,page:1,pageSize:40,totals,...patch});

function mount(options={}){
  let cursor=0,dirty=false,effects=[],tree,now=0,timerId=0,props={revision:0};
  const slots=[],requests=[],timers=new Map(),events=new Map();
  const changed=(a,b)=>!a||!b||a.length!==b.length||b.some((value,index)=>!Object.is(value,a[index]));
  const react={useState(value){const index=cursor++;slots[index]??={value:typeof value==="function"?value():value};return[slots[index].value,next=>{const result=typeof next==="function"?next(slots[index].value):next;if(!Object.is(result,slots[index].value)){slots[index].value=result;dirty=true;}}];},useRef(value){const index=cursor++;slots[index]??={current:value};return slots[index];},useEffect(fn,deps){const index=cursor++;if(!slots[index]||changed(slots[index].deps,deps))effects.push(()=>{slots[index]?.cleanup?.();slots[index]={deps,cleanup:fn()};});}};
  const component=name=>Object.defineProperty(()=>null,"name",{value:name}),schedule=(fn,delay=0,interval=0)=>{const id=++timerId;timers.set(id,{fn,at:now+delay,interval});return id;};
  const source=readFileSync(new URL("../app/dashboard/comisiones/commission-balances.tsx",import.meta.url),"utf8"),loaded={exports:{}};
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true});assert.equal(compiled.diagnostics.length,0);
  runInNewContext(compiled.outputText,{
    module:loaded,exports:loaded.exports,Error,AbortController,URLSearchParams,document:{visibilityState:"visible"},window:{addEventListener(name,fn){if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);},removeEventListener(name,fn){events.get(name)?.delete(fn);}},
    setTimeout:(fn,delay)=>schedule(fn,delay),clearTimeout:id=>timers.delete(id),setInterval:(fn,delay)=>schedule(fn,delay,delay),clearInterval:id=>timers.delete(id),
    fetch:(url,init)=>new Promise((resolve,reject)=>{const request={url,init,done:false,respond(body,status=200){if(this.done)return;this.done=true;resolve({ok:status>=200&&status<300,status,json:async()=>body});},fail(error=new Error("Falla temporal")){if(this.done)return;this.done=true;reject(error);}};requests.push(request);init.signal.addEventListener("abort",()=>{if(!options.ignoreAbort)request.fail(Object.assign(new Error("abort"),{name:"AbortError"}));},{once:true});}),
    require(name){if(name==="react")return react;if(name==="react/jsx-runtime")return{jsx,jsxs:jsx};if(name==="@/lib/commissions")return{COMMISSION_TIME_ZONE:"America/Bogota"};if(name.endsWith(".css"))return{default:new Proxy({},{get:(_,key)=>String(key)})};if(name==="lucide-react"||name==="@/app/_components/finser-ui")return new Proxy({},{get:(_,key)=>component(String(key))});throw new Error(`Unexpected dependency ${name}`);},
  });
  function render(){cursor=0;dirty=false;effects=[];tree=loaded.exports.default(props);for(const run of effects)run();}
  async function flush(){for(let index=0;index<30;index++){await Promise.resolve();if(dirty)render();}}
  const all=()=>nodes(tree),button=label=>all().find(node=>node.type?.name==="Button"&&(text(node)===label||node.props["aria-label"]===label));
  render();
  return{requests,all,button,flush,get tree(){return tree;},month:()=>all().find(node=>node.props["aria-label"]==="Mes de los saldos"),search:()=>all().find(node=>node.props["aria-label"]==="Buscar asesor o sede"),setProps(patch){props={...props,...patch};render();},async focus(){for(const fn of events.get("focus")||[])fn();await flush();},async advance(ms){const until=now+ms;for(;;){const next=[...timers].filter(([,entry])=>entry.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const[id,entry]=next;now=entry.at;if(entry.interval)entry.at+=entry.interval;else timers.delete(id);entry.fn();await flush();}now=until;await flush();},unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
async function respond(f,data=payload()){f.requests.filter(request=>!request.done).at(-1).respond(data);await f.flush();}
const params=request=>new URL(request.url,"https://finserpay.test").searchParams;

test("saldos abre todos los pendientes con meses reales, totales globales y ninguna acción de pago",async()=>{
  const f=mount();assert.equal(params(f.requests[0]).get("period"),"all_pending");assert.equal(params(f.requests[0]).get("page"),"1");assert.equal(f.requests[0].init.credentials,"same-origin");await respond(f);
  assert.equal(f.month().props.value,"all_pending");const months=nodes(f.month()).filter(node=>node.type==="option").map(node=>node.props.value);assert.deepEqual(months,["all_pending","2026-11","2026-10"]);assert.match(text(f.tree),/1\.234\.567/);assert.match(text(f.tree),/800\.000/);assert.match(text(f.tree),/434\.567/);
  assert.ok(f.all().some(node=>node.type==="th"&&node.props.scope==="row"&&/Sede de origen/.test(text(node))));const region=f.all().find(node=>node.props["aria-label"]==="Tabla de saldos por asesor");assert.equal(region.props.role,"region");assert.equal(region.props.tabIndex,0);
  for(const label of["Generado","Pagado","En trámite","Sin solicitar","Total pendiente"]){assert.ok(f.all().some(node=>node.type==="th"&&text(node)===label));}
  assert.equal(f.button("Confirmar pago"),undefined);assert.equal(f.button("Rechazar"),undefined);assert.equal(f.requests.some(request=>request.init.method),false);f.unmount();
});

test("pausas, asesores inactivos y ajustes reales conservan sus importes y muestran la revisión aparte",async()=>{
  const f=mount();await respond(f,payload({rows:[row(2,{sellerActive:false,payoutsPaused:true,generated:0,paid:50_000,reserved:25_000,available:0,adjustment:75_000,outstanding:0})],totals:{...totals,adjustment:75_000}}));
  assert.match(text(f.tree),/Inactivo/);assert.match(text(f.tree),/En pausa/);assert.match(text(f.tree),/Revisión/);assert.match(text(f.tree),/Ajuste en revisión/);assert.match(text(f.tree),/75\.000/);assert.match(text(f.tree),/no se suman al total pendiente; requieren revisión del respaldo/);assert.match(text(f.tree),/validaciones y pausas/);assert.equal(f.requests.length,1);f.unmount();
});

test("página de 40 filas y búsqueda/mes se consultan globalmente sin sumar las filas visibles",async()=>{
  const f=mount();await respond(f,payload({rows:Array.from({length:40},(_,index)=>row(index+1)),total:85}));assert.equal(f.all().find(node=>node.type==="tbody").props.children.length,40);assert.match(text(f.tree),/1–40 de 85/);
  f.button("Página siguiente de saldos").props.onClick();await f.flush();assert.equal(params(f.requests.at(-1)).get("page"),"2");assert.equal(f.all().some(node=>node.type==="tbody"),false);await respond(f,payload({rows:[row(41)],total:85,page:2}));assert.match(text(f.tree),/41–80 de 85/);assert.match(text(f.tree),/1\.234\.567/);
  f.search().props.onChange({target:{value:"Sede exacta"}});await f.flush();assert.equal(f.all().some(node=>node.type==="tbody"),false);await f.advance(300);assert.equal(params(f.requests.at(-1)).get("search"),"Sede exacta");assert.equal(params(f.requests.at(-1)).get("page"),"1");assert.equal(params(f.requests.at(-1)).get("period"),"all_pending");await respond(f);
  f.month().props.onChange({target:{value:"2026-10"}});await f.flush();assert.equal(params(f.requests.at(-1)).get("period"),"2026-10");assert.equal(params(f.requests.at(-1)).get("search"),"Sede exacta");assert.equal(params(f.requests.at(-1)).get("page"),"1");f.unmount();
});

test("revision, foco y sondeo actualizan meses al cambiar el calendario sin restablecer filtros",async()=>{
  const f=mount();await respond(f);f.month().props.onChange({target:{value:"2026-10"}});await f.flush();await respond(f);f.search().props.onChange({target:{value:"Asesor"}});await f.flush();await f.advance(300);await respond(f);
  const before=f.requests.length;f.setProps({revision:1});await f.flush();assert.equal(f.requests.length,before+1);assert.equal(f.all().some(node=>node.type==="tbody"),false);await respond(f);await f.focus();await respond(f);await f.advance(60_000);assert.equal(params(f.requests.at(-1)).get("period"),"2026-10");assert.equal(params(f.requests.at(-1)).get("search"),"Asesor");
  await respond(f,payload({currentPeriod:"2026-12",periods:["2026-12","2026-11","2026-10"]}));assert.equal(f.month().props.value,"2026-10");assert.equal(f.search().props.value,"Asesor");assert.ok(nodes(f.month()).some(node=>node.type==="option"&&node.props.value==="2026-12"));f.unmount();
});

test("una respuesta anterior 403 no borra los saldos revalidados del filtro vigente",async()=>{
  const f=mount({ignoreAbort:true});await respond(f);await f.focus();const old=f.requests.at(-1);f.setProps({revision:2});await f.flush();const fresh=f.requests.at(-1);fresh.respond(payload({rows:[row(9,{sellerName:"Asesor vigente"})]}));await f.flush();old.respond({error:"Permiso de una consulta anterior"},403);await f.flush();assert.match(text(f.tree),/Asesor vigente/);assert.doesNotMatch(text(f.tree),/Permiso de una consulta anterior/);assert.equal(f.search().props.disabled,false);f.unmount();
});

test("un rechazo de acceso vigente retira filas y totales y detiene consultas automáticas",async()=>{
  for(const status of[401,403]){const f=mount();await respond(f);f.setProps({revision:1});await f.flush();f.requests.at(-1).respond({error:"Acceso no autorizado"},status);await f.flush();assert.equal(f.all().some(node=>node.type==="tbody"),false);assert.doesNotMatch(text(f.tree),/1\.234\.567/);assert.equal(f.search().props.disabled,true);assert.equal(f.month().props.disabled,true);assert.ok(f.all().some(node=>node.type==="a"&&node.props.href===(status===401?"/aliados":"/dashboard")));const count=f.requests.length;await f.focus();await f.advance(60_000);assert.equal(f.requests.length,count);f.unmount();}
});

test("un timeout o falla temporal no muestra valores viejos y permite volver a consultar",async()=>{
  const f=mount();await respond(f);f.setProps({revision:1});await f.flush();const hung=f.requests.at(-1);await f.advance(20_000);assert.equal(hung.init.signal.aborted,true);assert.match(text(f.tree),/tardó demasiado/);assert.equal(f.all().some(node=>node.type==="tbody"),false);f.button("Volver a consultar saldos").props.onClick();await f.flush();await respond(f,payload({rows:[row(4)]}));assert.match(text(f.tree),/Asesor de prueba 4/);assert.doesNotMatch(text(f.tree),/tardó demasiado/);
  f.month().props.onChange({target:{value:"2027-01"}});await f.flush();f.requests.at(-1).respond({error:"El mes solicitado todavía no está disponible"},400);await f.flush();assert.equal(f.all().some(node=>node.type==="tbody"),false);assert.doesNotMatch(text(f.tree),/Asesor de prueba 4/);assert.equal(f.month().props.disabled,false);assert.ok(f.button("Volver a consultar saldos"));f.button("Volver a consultar saldos").props.onClick();await f.flush();assert.equal(params(f.requests.at(-1)).get("period"),"2027-01");f.requests.at(-1).respond({error:"El mes solicitado todavía no está disponible"},400);await f.flush();
  f.month().props.onChange({target:{value:"2026-10"}});await f.flush();await respond(f,payload({rows:[row(5)]}));assert.match(text(f.tree),/Asesor de prueba 5/);assert.doesNotMatch(text(f.tree),/todavía no está disponible/);f.unmount();
});

test("un total que disminuye vuelve a la última página válida con otro GET autorizado",async()=>{
  const f=mount();await respond(f,payload({total:81}));f.button("Página siguiente de saldos").props.onClick();await f.flush();await respond(f,payload({total:81,page:2}));f.button("Página siguiente de saldos").props.onClick();await f.flush();await respond(f,payload({total:81,page:3}));await f.focus();await respond(f,payload({rows:[],total:40,page:3}));assert.equal(params(f.requests.at(-1)).get("page"),"1");await respond(f,payload({total:40,page:1}));assert.match(text(f.tree),/1–40 de 40/);assert.equal(f.button("Página siguiente de saldos").props.disabled,true);f.unmount();
});

test("cero saldos es un vacío real y la búsqueda conserva texto escapado",async()=>{
  const f=mount();await respond(f,payload({rows:[],total:0,totals:{sellers:0,validCreditCount:0,generated:0,paid:0,reserved:0,available:0,adjustment:0,outstanding:0}}));assert.ok(f.all().some(node=>node.type?.name==="EmptyState"&&node.props.title==="No hay saldos para estos filtros"));assert.match(text(f.tree),/0–0 de 0/);
  f.search().props.onChange({target:{value:'<img src=x onerror="pagar()">'}});await f.flush();await f.advance(300);assert.equal(params(f.requests.at(-1)).get("search"),'<img src=x onerror="pagar()">');assert.equal(f.all().some(node=>node.type==="img"||node.props.dangerouslySetInnerHTML),false);assert.equal(f.requests.some(request=>request.init.method),false);f.unmount();
});
