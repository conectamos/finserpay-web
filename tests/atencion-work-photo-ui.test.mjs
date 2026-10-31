import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx=(type,props,key)=>({type,props:props||{},key});
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==="object"?[tree,...nodes(tree.props?.children)]:[];
const text=tree=>Array.isArray(tree)?tree.map(text).join(""):tree&&typeof tree==="object"?text(tree.props?.children):typeof tree==="string"||typeof tree==="number"?String(tree):"";
const capability="ab".repeat(32),sessionId="00000000-0000-4000-8000-000000000071",workId="00000000-0000-4000-8000-000000000081";
function mount(kind="desktop",options={}){
  let cursor=0,dirty=false,effects=[],tree,clockId=0,now=Date.now(),uuid=0,random=0;
  const slots=[],requests=[],timers=new Map(),received=[],closed=[],denied=[],qrs=[],createdUrls=[],revokedUrls=[];
  let props={workId,mode:"seller",version:2,active:true,onReceived:()=>received.push(true),onClose:()=>closed.push(true),onAccessDenied:error=>denied.push(error),...options};
  const changed=(a,b)=>!a||!b||a.length!==b.length||b.some((value,index)=>!Object.is(value,a[index]));
  const react={useState(value){const index=cursor++;slots[index]??={value:typeof value==="function"?value():value};return[slots[index].value,next=>{const result=typeof next==="function"?next(slots[index].value):next;if(!Object.is(result,slots[index].value)){slots[index].value=result;dirty=true;}}];},useRef(value){const index=cursor++;slots[index]??={current:value};return slots[index];},useCallback(fn,deps){const index=cursor++;if(!slots[index]||changed(slots[index].deps,deps))slots[index]={fn,deps};return slots[index].fn;},useEffect(fn,deps){const index=cursor++;if(!slots[index]||changed(slots[index].deps,deps))effects.push(()=>{slots[index]?.cleanup?.();slots[index]={deps,fn,effect:true,cleanup:fn()};});}};
  const schedule=(fn,delay=0,interval=0)=>{const id=++clockId;timers.set(id,{fn,at:now+delay,interval});return id;};
  class ClockDate extends Date{static now(){return now;}}
  const source=readFileSync(new URL(`../app/dashboard/atencion/attention-work-photo-${kind==="desktop"?"capture":"mobile"}.tsx`,import.meta.url),"utf8"),loaded={exports:{}};
  const component=name=>Object.defineProperty(()=>null,"name",{value:name});
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true});assert.equal(compiled.diagnostics.length,0);
  runInNewContext(compiled.outputText,{
    module:loaded,exports:loaded.exports,Error,Date:ClockDate,FormData,AbortController,URLSearchParams,Uint8Array,
    crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,"0")}`,getRandomValues(array){array.fill(++random);return array;}},
    document:{visibilityState:"visible"},window:{location:{origin:"https://finserpay.test",hash:options.hash??`#token=${capability}`}},
    URL:{createObjectURL(file){const url=`blob:photo-${createdUrls.length+1}`;createdUrls.push({file,url});return url;},revokeObjectURL:url=>revokedUrls.push(url)},
    setTimeout:(fn,delay)=>schedule(fn,delay),clearTimeout:id=>timers.delete(id),setInterval:(fn,delay)=>schedule(fn,delay,delay),clearInterval:id=>timers.delete(id),
    fetch:(url,init={})=>new Promise((resolve,reject)=>{const entry={url,init,done:false,aborted:false,respond(body,status=200){if(this.done)return;this.done=true;resolve({ok:status>=200&&status<300,status,json:async()=>body});},fail(error=new Error("Conexión interrumpida")){if(this.done)return;this.done=true;reject(error);}};requests.push(entry);init.signal?.addEventListener("abort",()=>{entry.aborted=true;if(!options.ignoreAbort)entry.fail(Object.assign(new Error("abort"),{name:"AbortError"}));},{once:true});}),
    require(name){if(name==="react")return react;if(name==="react/jsx-runtime")return{jsx,jsxs:jsx};if(name==="qrcode")return{default:{toDataURL:async url=>{qrs.push(url);return"data:image/png;base64,TEST";}}};if(name.endsWith(".css"))return{default:new Proxy({},{get:(_,key)=>String(key)})};if(name==="lucide-react"||name==="@/app/_components/finser-ui")return new Proxy({},{get:(_,key)=>component(String(key))});return{default:component(name)};},
  });
  function render(){cursor=0;dirty=false;effects=[];tree=loaded.exports.default(props);for(const run of effects)run();}
  async function flush(){for(let i=0;i<35;i++){await Promise.resolve();if(dirty)render();}}
  const all=()=>nodes(tree),button=label=>all().find(node=>node.type?.name==="Button"&&text(node)===label),image=()=>all().find(node=>node.type?.name==="next/image");
  const session=(patch={})=>({id:sessionId,expiresAt:new Date(now+20*60_000).toISOString(),state:"open",uploadedCount:0,lastUploadedAt:null,...patch});
  render();
  return{requests,received,closed,denied,qrs,createdUrls,revokedUrls,all,button,image,flush,session,get tree(){return tree;},setProps(patch){props={...props,...patch};render();},replayEffects(){const initial=slots.filter(slot=>slot?.effect);for(const slot of initial){slot.cleanup?.();slot.cleanup=slot.fn();}},async advance(ms){const until=now+ms;for(;;){const next=[...timers].filter(([,entry])=>entry.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const[id,entry]=next;now=entry.at;if(entry.interval)entry.at+=entry.interval;else timers.delete(id);entry.fn();await flush();}now=until;await flush();},unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
async function readyDesktop(f){f.requests.find(r=>r.init.method==="POST"&&!r.done).respond(f.session());await f.flush();}
async function readyMobile(f){f.requests.find(r=>!r.init.method&&!r.done).respond(f.session());await f.flush();}
async function photo(f,name="equipo.jpg"){const target={files:[new File(["imagen artificial"],name,{type:"image/jpeg"})],value:"foto"};f.all().find(node=>node.props["aria-label"]==="Tomar foto con la cámara").props.onChange({target});await f.flush();assert.equal(target.value,"");}

test("PC no muestra QR hasta confirmar creación y conserva su intención entre versiones y StrictMode",async()=>{
  const f=mount();assert.equal(f.image(),undefined);assert.equal(f.qrs.length,0);const first=f.requests[0],body=first.init.body;assert.match(JSON.parse(body).token,/^[a-f0-9]{64}$/);f.replayEffects();await f.flush();const second=f.requests.filter(r=>r.init.method==="POST").at(-1);assert.equal(second.init.body,body);assert.equal(first.aborted,true);second.respond(f.session());await f.flush();assert.ok(f.image());assert.equal(f.qrs.length,1);
  const link=f.all().find(node=>node.type==="a");assert.equal(link.props.href,f.qrs[0]);assert.match(link.props.href,/^https:\/\/finserpay\.test\/atencion-captura#token=/);assert.equal(link.props.rel,"noopener noreferrer");assert.equal(text(f.tree).includes(JSON.parse(body).token),false);
  f.setProps({version:3});await f.flush();assert.equal(f.requests.filter(r=>r.init.method==="POST").length,2);f.unmount();assert.ok(f.requests.some(r=>r.init.method==="DELETE"&&r.init.keepalive));
});

test("PC consulta el conteo real, refresca solo fotos nuevas y cierra después de DELETE confirmado",async()=>{
  const f=mount();await readyDesktop(f);await f.advance(3000);f.requests.find(r=>!r.done&&!r.init.method).respond(f.session({uploadedCount:1,lastUploadedAt:new Date().toISOString()}));await f.flush();assert.equal(f.received.length,1);await f.advance(3000);f.requests.find(r=>!r.done&&!r.init.method).respond(f.session({uploadedCount:1}));await f.flush();assert.equal(f.received.length,1);
  f.button("Cerrar captura").props.onClick();await f.flush();assert.equal(f.closed.length,0);f.requests.find(r=>!r.done&&r.init.method==="DELETE").respond(f.session({state:"revoked",uploadedCount:1}));await f.flush();assert.equal(f.closed.length,1);assert.equal(f.image(),undefined);f.unmount();
});

test("PC reintenta creación y cierre colgados sin cambiar UUID ni token y sin cerrar antes de confirmar",async()=>{
  const f=mount();const body=f.requests[0].init.body;await f.advance(30_000);assert.equal(f.requests[0].aborted,true);assert.ok(f.button("Consultar / reintentar mismo QR"));f.button("Consultar / reintentar mismo QR").props.onClick();await f.flush();const retry=f.requests.filter(r=>r.init.method==="POST").at(-1);assert.equal(retry.init.body,body);retry.respond(f.session());await f.flush();
  f.button("Cerrar captura").props.onClick();await f.flush();const deletion=f.requests.find(r=>!r.done&&r.init.method==="DELETE");await f.advance(30_000);assert.equal(deletion.aborted,true);assert.equal(f.closed.length,0);assert.ok(f.button("Reintentar cierre"));f.button("Reintentar cierre").props.onClick();await f.flush();const retried=f.requests.filter(r=>r.init.method==="DELETE").at(-1);assert.equal(retried.url,deletion.url);retried.respond(f.session({state:"revoked"}));await f.flush();assert.equal(f.closed.length,1);f.unmount();
});

test("cerrar una creación incierta la resuelve con la misma intención antes de revocarla",async()=>{
  const f=mount();const body=f.requests[0].init.body;f.requests[0].fail();await f.flush();f.button("Cerrar captura").props.onClick();await f.flush();const retry=f.requests.filter(r=>r.init.method==="POST").at(-1);assert.equal(retry.init.body,body);retry.respond(f.session());await f.flush();assert.equal(f.image(),undefined);assert.equal(f.closed.length,0);f.requests.find(r=>!r.done&&r.init.method==="DELETE").respond(f.session({state:"revoked"}));await f.flush();assert.equal(f.closed.length,1);f.unmount();
});

test("PC detiene lecturas tardías por cambio de caso y el QR vencido permite una intención nueva",async()=>{
  const f=mount("desktop",{ignoreAbort:true});await readyDesktop(f);await f.advance(3000);const old=f.requests.find(r=>!r.done&&!r.init.method);f.setProps({workId:"00000000-0000-4000-8000-000000000082"});await f.flush();old.respond({error:"Acceso anterior"},403);await f.flush();assert.equal(f.denied.length,0);const create=f.requests.filter(r=>!r.done&&r.init.method==="POST").at(-1);create.respond(f.session({expiresAt:new Date(Date.now()+1000).toISOString()}));await f.flush();await f.advance(2000);assert.equal(f.image(),undefined);assert.ok(f.button("Generar nuevo QR"));const previous=JSON.parse(create.init.body);f.button("Generar nuevo QR").props.onClick();await f.flush();const next=JSON.parse(f.requests.filter(r=>r.init.method==="POST").at(-1).init.body);assert.notEqual(next.token,previous.token);assert.notEqual(next.requestId,previous.requestId);f.unmount();
});

test("la lectura PC colgada se recupera con un error legible y deja actualizar el QR",async()=>{
  const f=mount();await readyDesktop(f);await f.advance(3000);const read=f.requests.find(r=>!r.done&&!r.init.method);await f.advance(20_000);assert.equal(read.aborted,true);assert.match(text(f.tree),/consulta tardó demasiado/);assert.ok(f.button("Actualizar QR"));f.button("Actualizar QR").props.onClick();await f.flush();f.requests.find(r=>!r.done&&!r.init.method).respond(f.session());await f.flush();assert.ok(f.image());f.unmount();
});

test("móvil usa solo Bearer desde el fragmento y no permite capturar antes de confirmar sesión",async()=>{
  const invalid=mount("mobile",{hash:""});await invalid.flush();assert.equal(invalid.requests.length,0);assert.match(text(invalid.tree),/Escanea el QR/);invalid.unmount();
  const f=mount("mobile",{hash:`#token=${capability.toUpperCase()}`});assert.equal(f.button("Tomar foto").props.disabled,true);assert.equal(f.requests[0].url,"/api/atencion/captura");assert.equal(f.requests[0].init.headers.Authorization,`Bearer ${capability}`);assert.equal(f.requests[0].init.credentials,"omit");f.requests[0].respond({error:"Temporal"},503);await f.flush();assert.equal(f.button("Tomar foto").props.disabled,true);assert.equal(f.button("Elegir foto").props.disabled,true);assert.ok(f.button("Volver a consultar"));f.button("Volver a consultar").props.onClick();await f.flush();await readyMobile(f);assert.equal(f.button("Tomar foto").props.disabled,false);f.unmount();
});

test("móvil toma, previsualiza y confirma varias fotos sucesivas en el mismo chat",async()=>{
  const f=mount("mobile");await readyMobile(f);const camera=f.all().find(node=>node.props["aria-label"]==="Tomar foto con la cámara"),gallery=f.all().find(node=>node.props["aria-label"]==="Elegir foto de la galería");assert.equal(camera.props.capture,"environment");assert.equal(gallery.props.capture,undefined);
  for(let index=1;index<=2;index++){await photo(f,`foto-${index}.jpg`);assert.ok(f.image());assert.equal(f.requests.filter(r=>r.init.method==="POST").length,index-1);f.button("Enviar foto").props.onClick();await f.flush();const sent=f.requests.filter(r=>r.init.method==="POST").at(-1);assert.equal(sent.url,"/api/atencion/captura");assert.equal(sent.init.body.get("file").name,`foto-${index}.jpg`);assert.equal(sent.init.headers.Authorization,`Bearer ${capability}`);sent.respond(f.session({uploadedCount:index}));await f.flush();assert.equal(f.image(),undefined);assert.match(text(f.tree),/Foto guardada en la plataforma/);}
  const uploads=f.requests.filter(r=>r.init.method==="POST");assert.notEqual(uploads[0].init.body.get("requestId"),uploads[1].init.body.get("requestId"));assert.equal(f.createdUrls.length,f.revokedUrls.length);f.unmount();
});

test("un envío móvil colgado conserva UUID y foto; el reintento confirmado evita duplicarla",async()=>{
  const f=mount("mobile");await readyMobile(f);await photo(f);f.button("Enviar foto").props.onClick();await f.flush();const first=f.requests.find(r=>r.init.method==="POST"),id=first.init.body.get("requestId");await f.advance(45_000);assert.equal(first.aborted,true);assert.ok(f.image());assert.ok(f.button("Reintentar mismo envío"));assert.equal(f.button("Quitar foto").props.disabled,true);f.button("Reintentar mismo envío").props.onClick();await f.flush();const retry=f.requests.filter(r=>r.init.method==="POST").at(-1);assert.equal(retry.init.body.get("requestId"),id);assert.equal(retry.init.body.get("file").name,first.init.body.get("file").name);retry.respond(f.session({uploadedCount:1}));await f.flush();assert.equal(f.image(),undefined);assert.ok(f.revokedUrls.includes("blob:photo-1"));f.unmount();
});

test("móvil se detiene al vencer, revocar o cambiar el permiso sin conservar una cámara activa",async()=>{
  for(const status of [403,409,410]){const f=mount("mobile");await readyMobile(f);await photo(f);f.button("Enviar foto").props.onClick();await f.flush();f.requests.find(r=>r.init.method==="POST").respond({error:"La sesión ya no está disponible"},status);await f.flush();assert.equal(f.button("Tomar foto"),undefined);assert.equal(f.image(),undefined);assert.match(text(f.tree),/ya no está disponible/);assert.ok(f.revokedUrls.includes("blob:photo-1"));f.unmount();}
  const f=mount("mobile");f.requests[0].respond(f.session({state:"expired"}));await f.flush();assert.match(text(f.tree),/QR venció/);assert.equal(f.button("Tomar foto"),undefined);f.unmount();
});

test("móvil recupera lectura con deadline y rechaza formatos/peso sin enviar",async()=>{
  const f=mount("mobile");await f.advance(20_000);assert.equal(f.requests[0].aborted,true);assert.match(text(f.tree),/consulta tardó demasiado/);assert.equal(f.button("Tomar foto").props.disabled,true);f.requests.find(r=>!r.done&&!r.init.method).respond(f.session());await f.flush();
  for(const file of [{name:"foto.heic",type:"image/heic",size:10},{name:"pesada.jpg",type:"image/jpeg",size:5*1024*1024+1}]){f.all().find(node=>node.props["aria-label"]==="Elegir foto de la galería").props.onChange({target:{files:[file],value:""}});await f.flush();assert.equal(f.image(),undefined);assert.ok(f.all().some(node=>node.props.role==="alert"));}assert.equal(f.requests.some(r=>r.init.method==="POST"),false);f.unmount();
});
