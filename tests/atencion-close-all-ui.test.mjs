import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
const source=readFileSync(new URL("../app/dashboard/atencion/attention-close-all.tsx",import.meta.url),"utf8");
const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}});
const nodes=t=>Array.isArray(t)?t.flatMap(nodes):t&&typeof t==="object"?[t,...nodes(t.props?.children)]:[];
const text=t=>Array.isArray(t)?t.map(text).join(""):t&&typeof t==="object"?text(t.props?.children):typeof t==="string"||typeof t==="number"?String(t):"";
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const review={reviewToken:uuid(1),cutoff:"2026-10-30T21:19:13.000Z",expiresAt:"2026-10-30T22:10:00Z",totalCount:100,openCount:80,closeCount:75,unreadCount:120,skippedCount:5};
function mount(storage=new Map()){
  let cursor=0,dirty=false,tree,effects=[],seq=10,saved=0,denied=0;const slots=[],requests=[],timers=new Map(),busy=[];
  const react={
    useState(initial){const n=cursor++;slots[n]??={value:typeof initial==="function"?initial():initial};return[slots[n].value,next=>{slots[n].value=typeof next==="function"?next(slots[n].value):next;dirty=true;}];},
    useRef(value){const n=cursor++;slots[n]??={current:value};return slots[n];},
    useEffect(fn,deps){const n=cursor++;if(!slots[n]||deps.some((v,i)=>!Object.is(v,slots[n].deps[i])))effects.push(()=>{slots[n]?.cleanup?.();slots[n]={deps,cleanup:fn()};});},
  };
  const loaded={exports:{}};
  runInNewContext(outputText,{module:loaded,exports:loaded.exports,AbortController,Intl,Date,URLSearchParams,
    crypto:{randomUUID:()=>uuid(++seq)},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    setTimeout:fn=>{const k=++seq;timers.set(k,fn);return k;},clearTimeout:k=>timers.delete(k),
    require(name){if(name==="react")return react;if(name==="react/jsx-runtime")return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name.endsWith(".css"))return{default:new Proxy({},{get:(_,key)=>key})};if(name.includes("finser-confirm-dialog"))return{default:"ConfirmDialog"};return new Proxy({},{get:(_,key)=>key});},
  });
  function render(){cursor=0;effects=[];dirty=false;tree=loaded.exports.default({actorKey:"admin:1",request:(url,init={})=>new Promise((resolve,reject)=>requests.push({url,init,resolve,reject})),onDone:()=>saved++,busyChanged:value=>busy.push(value),accessDenied:error=>{if([401,403].includes(error.status)){denied++;return true;}return false;}});for(const f of effects)f();}
  async function flush(){for(let i=0;i<15;i++){await Promise.resolve();for(const[k,fn]of [...timers]){timers.delete(k);fn();}if(dirty)render();}}
  render();
  return{requests,flush,storage,busy,counts:()=>({saved,denied}),all:()=>nodes(tree),text:()=>text(tree),button:label=>nodes(tree).find(n=>n.type==="Button"&&text(n)===label),dialog:()=>nodes(tree).find(n=>n.type==="ConfirmDialog"),input:()=>nodes(tree).find(n=>n.type==="Input"),unmount(){slots.forEach(s=>s?.cleanup?.());}};
}
async function reviewed(f){await f.flush();f.input().props.onChange({target:{value:"2026-10-30T16:19:13"}});await f.flush();f.button("Revisar cierre de chats").props.onClick();await f.flush();assert.match(f.requests[0].url,/cutoff=2026-10-30T21%3A19%3A13.000Z$/);f.requests[0].resolve(review);await f.flush();}

test("edición nativa de fecha usa el corte escrito antes de perder el foco",async()=>{const f=mount();await f.flush();f.input().props.onInput({currentTarget:{value:"2026-10-30T16:19:13"}});await f.flush();f.button("Revisar cierre de chats").props.onClick();await f.flush();assert.match(f.requests[0].url,/cutoff=2026-10-30T21%3A19%3A13.000Z$/);f.unmount();});
test("revisión usa corte Bogotá y sólo confirmación explícita envía una intención",async()=>{const f=mount();await reviewed(f);assert.equal(f.requests.length,1);assert.equal(f.dialog().props.open,true);assert.match(f.dialog().props.description,/75 chats/);assert.match(f.dialog().props.description,/120 mensajes/);f.dialog().props.onConfirm();f.dialog().props.onConfirm();await f.flush();assert.equal(f.requests.length,2);const input=JSON.parse(f.requests[1].init.body);assert.equal(input.reviewToken,review.reviewToken);assert.equal(input.confirmed,true);assert.ok(f.storage.size);f.requests[1].resolve({closedCount:74,readCount:120,skippedCount:6,cutoff:review.cutoff});await f.flush();assert.match(f.text(),/74 chats finalizados/);assert.equal(f.storage.size,0);assert.equal(f.counts().saved,1);f.unmount();});
test("fallo incierto conserva UUID y la comprobación repite únicamente la misma solicitud",async()=>{const f=mount();await reviewed(f);f.dialog().props.onConfirm();await f.flush();const sent=f.requests[1].init.body;f.requests[1].reject(new Error("Conexión interrumpida"));await f.flush();assert.equal(f.input().props.disabled,true);f.button("Comprobar cierre pendiente").props.onClick();await f.flush();assert.equal(f.requests[2].init.body,sent);f.requests[2].resolve({closedCount:75,readCount:120,skippedCount:5,cutoff:review.cutoff});await f.flush();assert.equal(f.counts().saved,1);f.unmount();});
test("remontar recupera intento sin POST automático; conflicto exige nueva revisión",async()=>{const storage=new Map(),a=mount(storage);await reviewed(a);a.dialog().props.onConfirm();await a.flush();a.requests[1].reject(new Error("Sin respuesta"));await a.flush();const sent=a.requests[1].init.body;a.unmount();const b=mount(storage);await b.flush();assert.equal(b.requests.length,0);b.button("Comprobar cierre pendiente").props.onClick();await b.flush();assert.equal(b.requests[0].init.body,sent);b.requests[0].reject(Object.assign(new Error("Revisión vencida"),{status:409}));await b.flush();assert.equal(b.storage.size,0);assert.ok(b.button("Revisar cierre de chats"));b.unmount();});
test("permisos revocados y resultados tardíos no producen confirmaciones ni más solicitudes",async()=>{const a=mount();await a.flush();a.button("Revisar cierre de chats").props.onClick();await a.flush();a.requests[0].reject(Object.assign(new Error("No autorizado"),{status:403}));await a.flush();assert.equal(a.counts().denied,1);assert.equal(a.dialog().props.open,false);a.unmount();const b=mount();await reviewed(b);b.dialog().props.onConfirm();await b.flush();b.unmount();b.requests[1].resolve({closedCount:75,readCount:120,skippedCount:5,cutoff:review.cutoff});await b.flush();assert.equal(b.counts().saved,0);assert.equal(b.requests.length,2);});
