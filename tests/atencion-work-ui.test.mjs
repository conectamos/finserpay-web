import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx=(type,props,key)=>({type,props:props||{},key});
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==="object"?[tree,...nodes(tree.props?.children)]:[];
const text=tree=>Array.isArray(tree)?tree.map(text).join(""):tree&&typeof tree==="object"?text(tree.props?.children):typeof tree==="string"?tree:"";
function mount(){
  let cursor=0,dirty=false,effects=[],tree,clockId=0;
  const slots=[],requests=[],timers=new Map();
  const changed=(a,b)=>!a||!b||a.length!==b.length||b.some((v,i)=>!Object.is(v,a[i]));
  const react={
    useState(value){const n=cursor++;slots[n]??={value:typeof value==="function"?value():value};return[slots[n].value,next=>{slots[n].value=typeof next==="function"?next(slots[n].value):next;dirty=true;}];},
    useRef(value){const n=cursor++;slots[n]??={current:value};return slots[n];},
    useCallback(fn,deps){const n=cursor++;if(!slots[n]||changed(slots[n].deps,deps))slots[n]={fn,deps};return slots[n].fn;},
    useEffect(fn,deps){const n=cursor++;if(!slots[n]||changed(slots[n].deps,deps))effects.push(()=>{slots[n]?.cleanup?.();slots[n]={deps,cleanup:fn()};});},
  };
  const component=name=>Object.defineProperty(()=>null,"name",{value:name});
  const source=readFileSync(new URL("../app/dashboard/atencion/attention-work-queues.tsx",import.meta.url),"utf8");
  const loaded={exports:{}};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    module:loaded,exports:loaded.exports,Error,FormData,AbortController,URLSearchParams,
    crypto:{randomUUID:()=>"00000000-0000-4000-8000-000000000001"},
    document:{visibilityState:"visible"},window:{addEventListener(){},removeEventListener(){}},
    setTimeout:fn=>{timers.set(++clockId,fn);return clockId;},clearTimeout:id=>timers.delete(id),setInterval:()=>++clockId,clearInterval(){},
    fetch:(url,init)=>new Promise((resolve,reject)=>requests.push({url,init,done:false,respond(body,status=200){this.done=true;resolve({ok:status<400,status,json:async()=>body});},fail(error){this.done=true;reject(error);}})),
    require(name){
      if(name==="react")return react;
      if(name==="react/jsx-runtime")return{jsx,jsxs:jsx};
      if(name==="@/lib/atencion-work-types")return{attentionWorkKinds:{enrollment:"Enrolamiento iPhone",welcome:"Aprobación · bienvenida"},attentionWorkStates:{pending:"Pendiente"}};
      if(name.endsWith(".css"))return{default:new Proxy({},{get:(_,key)=>String(key)})};
      if(name==="lucide-react"||name==="@/app/_components/finser-ui")return new Proxy({},{get:(_,key)=>component(String(key))});
      return{default:component(name)};
    },
  });
  function render(){cursor=0;dirty=false;effects=[];tree=loaded.exports.default({kind:"enrollment",mode:"seller",sellerId:7});for(const run of effects)run();}
  async function flush(){for(let i=0;i<25;i++){await Promise.resolve();if(dirty)render();}}
  const all=()=>nodes(tree),button=label=>all().find(n=>n.type?.name==="Button"&&(text(n)===label||n.props["aria-label"]===label));
  render();
  return{requests,flush,all,button,get tree(){return tree;},query:()=>all().find(n=>n.type?.name==="Input"&&!n.props.type),unmount(){for(const slot of slots)slot?.cleanup?.();}};
}

test("asesor autorizado puede escribir con bandeja vacía y seleccionar su venta",async()=>{
  const f=mount();f.requests[0].respond({items:[],total:0});await f.flush();
  assert.equal(f.query().props.disabled,false);f.query().props.onChange({target:{value:"Cliente de prueba"}});await f.flush();assert.equal(f.query().props.value,"Cliente de prueba");
  assert.match(text(f.tree),/Busca y selecciona una venta/);assert.equal(f.button("Crear solicitud").props.disabled,true);
  f.all().find(n=>n.type==="form").props.onSubmit({preventDefault(){}});await f.flush();
  const request=f.requests.at(-1);assert.match(request.url,/\/api\/solicitudes\?/);assert.equal(f.button("Buscando venta…").props.disabled,true);
  request.respond({items:[{id:"D-12",numero:"Prueba",clienteNombre:"Cliente de prueba",plataforma:"IPHONE",source:"DRAFT",estadoLabel:"En proceso",asesor:{id:7}}]});await f.flush();
  f.all().find(n=>n.type?.name==="Select").props.onChange({target:{value:"D-12"}});await f.flush();assert.equal(f.button("Crear solicitud").props.disabled,false);f.unmount();
});

test("acceso rechazado muestra recuperación fuera del chat móvil y mantiene bloqueados los envíos",async()=>{
  const f=mount();f.requests[0].respond({error:"Acceso denegado"},403);await f.flush();
  const feedback=f.tree.props.children.find(n=>n?.props?.className==="feedback");assert.ok(feedback,"El aviso está al nivel de la bandeja, fuera del chat ocultable");
  assert.match(text(feedback),/Vuelve a iniciar sesión/);assert.ok(nodes(feedback).some(n=>n.props.href==="/aliados"));
  assert.equal(f.query().props.disabled,true);assert.equal(f.button("Crear solicitud").props.disabled,true);assert.equal(f.button("Actualizar solicitudes").props.disabled,true);
  f.all().find(n=>n.type==="form").props.onSubmit({preventDefault(){}});await f.flush();assert.equal(f.requests.length,1);assert.equal(f.requests.some(r=>r.init.method==="POST"),false);f.unmount();
});

test("error temporal de lectura desaparece al recuperar la bandeja y el timeout es legible",async()=>{
  const f=mount();f.requests[0].fail(Object.assign(new Error("aborted"),{name:"AbortError"}));await f.flush();assert.match(text(f.tree),/La consulta tardó demasiado/);
  f.button("Actualizar solicitudes").props.onClick();await f.flush();f.requests.at(-1).respond({items:[],total:0});await f.flush();assert.doesNotMatch(text(f.tree),/La consulta tardó demasiado/);assert.equal(f.query().props.disabled,false);f.unmount();
});

test("lectura recuperada conserva la advertencia y el UUID de un envío sin confirmar",async()=>{
  const f=mount();f.requests[0].respond({items:[],total:0});await f.flush();
  f.all().find(n=>n.type?.name==="Select").props.onChange({target:{value:"D-12"}});await f.flush();f.button("Crear solicitud").props.onClick();await f.flush();
  const sent=f.requests.find(r=>r.init.method==="POST"),body=sent.init.body;sent.respond({error:"No se confirmó el cambio"},500);await f.flush();
  f.requests.filter(r=>!r.done).forEach(r=>r.respond({items:[],total:0}));await f.flush();
  assert.match(text(f.tree),/No se confirmó el cambio/);assert.match(text(f.tree),/Los campos permanecerán bloqueados/);assert.equal(f.query().props.disabled,true);
  f.button("Consultar / reintentar mismo intento").props.onClick();await f.flush();assert.equal(f.requests.filter(r=>r.init.method==="POST").at(-1).init.body,body);f.unmount();
});
