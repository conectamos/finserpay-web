import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx=(type,props,key)=>({type,props:props||{},key});
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==="object"?[tree,...nodes(tree.props?.children)]:[];
const text=tree=>Array.isArray(tree)?tree.map(text).join(""):tree&&typeof tree==="object"?text(tree.props?.children):typeof tree==="string"?tree:"";
function mount(options={}){
  let cursor=0,dirty=false,effects=[],tree,clockId=0,now=0;
  let props={kind:"enrollment",mode:"seller",sellerId:7,...options};
  const slots=[],requests=[],timers=new Map(),sources=[];
  const schedule=(fn,delay=0,interval=0)=>{const id=++clockId;timers.set(id,{fn,at:now+delay,interval});return id;};
  const changed=(a,b)=>!a||!b||a.length!==b.length||b.some((v,i)=>!Object.is(v,a[i]));
  const react={
    useState(value){const n=cursor++;slots[n]??={value:typeof value==="function"?value():value};return[slots[n].value,next=>{slots[n].value=typeof next==="function"?next(slots[n].value):next;dirty=true;}];},
    useRef(value){const n=cursor++;slots[n]??={current:value};return slots[n];},
    useCallback(fn,deps){const n=cursor++;if(!slots[n]||changed(slots[n].deps,deps))slots[n]={fn,deps};return slots[n].fn;},
    useMemo(fn,deps){const n=cursor++;if(!slots[n]||changed(slots[n].deps,deps))slots[n]={value:fn(),deps};return slots[n].value;},
    useEffect(fn,deps){const n=cursor++;if(!slots[n]||changed(slots[n].deps,deps))effects.push(()=>{slots[n]?.cleanup?.();slots[n]={deps,cleanup:fn()};});},
  };
  const component=name=>Object.defineProperty(()=>null,"name",{value:name});
  const source=readFileSync(new URL("../app/dashboard/atencion/attention-work-queues.tsx",import.meta.url),"utf8");
  const loaded={exports:{}};
  class FakeEventSource{constructor(url){this.url=url;this.events=new Map();this.closed=false;sources.push(this);}addEventListener(name,fn){this.events.set(name,fn);}close(){this.closed=true;}emit(name){this.events.get(name)?.();}}
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    module:loaded,exports:loaded.exports,Error,FormData,AbortController,URLSearchParams,
    crypto:{randomUUID:()=>"00000000-0000-4000-8000-000000000001"},
    document:{visibilityState:"visible"},window:{addEventListener(){},removeEventListener(){}},
    setTimeout:(fn,delay)=>schedule(fn,delay),clearTimeout:id=>timers.delete(id),setInterval:(fn,delay)=>schedule(fn,delay,delay),clearInterval:id=>timers.delete(id),
    ...(options.sse?{EventSource:FakeEventSource}:{}),
    fetch:(url,init)=>new Promise((resolve,reject)=>requests.push({url,init,done:false,respond(body,status=200){this.done=true;resolve({ok:status<400,status,json:async()=>body});},fail(error){this.done=true;reject(error);}})),
    require(name){
      if(name==="react")return react;
      if(name==="react/jsx-runtime")return{jsx,jsxs:jsx};
      if(name==="@/lib/atencion-work-types")return{attentionWorkKinds:{enrollment:"Enrolamiento iPhone",welcome:"Aprobación · bienvenida"},attentionWorkStates:{pending:"Pendiente",review:"En revisión",information:"Información pendiente",completed:"Finalizada"}};
      if(name==="./attention-operational")return{AttentionObservedRead:component("AttentionObservedRead")};
      if(name.endsWith(".css"))return{default:new Proxy({},{get:(_,key)=>String(key)})};
      if(name==="lucide-react"||name==="@/app/_components/finser-ui")return new Proxy({},{get:(_,key)=>component(String(key))});
      return{default:component(name)};
    },
  });
  function render(){cursor=0;dirty=false;effects=[];tree=loaded.exports.default(props);for(const run of effects)run();}
  async function flush(){for(let i=0;i<25;i++){await Promise.resolve();if(dirty)render();}}
  const all=()=>nodes(tree),button=label=>all().find(n=>n.type?.name==="Button"&&(text(n)===label||n.props["aria-label"]===label));
  render();
  return{requests,flush,all,button,sources,get tree(){return tree;},query:()=>all().find(n=>n.type?.name==="Input"&&!n.props.type),setProps(patch){props={...props,...patch};render();},
    async advance(ms){const until=now+ms;for(;;){const next=[...timers].filter(([,entry])=>entry.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const[id,entry]=next;now=entry.at;if(entry.interval)entry.at+=entry.interval;else timers.delete(id);entry.fn();await flush();}now=until;await flush();},
    unmount(){for(const slot of slots)slot?.cleanup?.();}};
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

const itemA={id:"00000000-0000-4000-8000-000000000011",conversationId:"00000000-0000-4000-8000-000000000021",kind:"enrollment",target:"D-12",state:"pending",callMode:"undecided",name:"Cliente de prueba A",advisor:"Asesor de prueba",ally:"Aliado de prueba",branch:"Sede de prueba",assignee:"Analista de prueba",assigneeKey:"analyst:4",version:2,createdAt:"2026-10-31T12:00:00Z",updatedAt:"2026-10-31T13:00:00Z",lastMessageAt:"2026-10-31T13:01:00Z",preview:"Adjunto el soporte de prueba",unreadCount:2};
const itemB={...itemA,id:"00000000-0000-4000-8000-000000000012",conversationId:"00000000-0000-4000-8000-000000000022",name:"Cliente de prueba B",unreadCount:0};
const detailFor=(item=itemA)=>({item,messages:[{id:"00000000-0000-4000-8000-000000000031",direction:"inbound",text:"Mensaje interno de prueba",sentAt:"2026-10-31T13:01:00Z",author:"Asesor de prueba"}],notes:[],events:[],team:[{key:"analyst:4",name:"Analista de prueba"}],canManage:true,canWrite:true,canAssign:true,historyTruncated:false,document:"DOCUMENTO DE PRUEBA",imei:"000000000000000",operationHref:"/dashboard/aprobaciones/enrolamiento"});
const panel=f=>f.all().find(n=>n.type?.name==="@/app/_components/finser-side-panel");
const observer=f=>f.all().find(n=>n.type?.name==="AttentionObservedRead");
const messageField=f=>f.all().find(n=>n.type==="textarea"&&String(n.props.id).startsWith("work-message-"));
const noteField=f=>f.all().find(n=>n.type==="textarea"&&n.props.placeholder==="Observación visible solo para el equipo…");
const plainButton=(f,label)=>f.all().find(n=>n.type==="button"&&text(n)===label);
async function resolveReads(f,current=detailFor(),items=[itemA,itemB],from=0,total=items.length){for(const request of f.requests.slice(from).filter(r=>!r.done&&!r.init.method))request.respond(request.url.includes("?")?{items,total}:current);await f.flush();}
async function selectWork(f,item=itemA,current=detailFor(item)){const from=f.requests.length;f.all().find(n=>n.type==="button"&&n.key===item.id).props.onClick();await f.flush();await resolveReads(f,current,[itemA,itemB],from);}

test("Atención integra navegación y ficha cerrada; conserva mensaje y nota al consultar y cerrar",async()=>{
  const navigation=jsx("nav",{"aria-label":"Tipos de conversación",children:"Clientes · Enrolamientos · Aprobaciones"});
  const f=mount({mode:"attention",embedded:true,canAssignFilter:true,navigation});await resolveReads(f);
  assert.match(text(f.tree),/Tipos|Clientes · Enrolamientos · Aprobaciones/);assert.ok(f.tree.props.className.includes("embedded"));
  assert.equal(panel(f).props.open,false);assert.equal(panel(f).props.keepMounted,true);
  await selectWork(f);
  assert.match(text(f.tree),/Chat interno/);assert.match(text(f.tree),/Adjunto el soporte de prueba/);
  assert.ok(f.all().some(n=>n.props["aria-label"]==="2 mensajes no leídos"));
  messageField(f).props.onChange({target:{value:"Borrador para el asesor"}});noteField(f).props.onChange({target:{value:"Nota privada en preparación"}});await f.flush();
  f.button("Ficha").props.onClick();await f.flush();assert.equal(panel(f).props.open,true);assert.equal(observer(f).props.active,false);
  panel(f).props.onClose();await f.flush();assert.equal(panel(f).props.open,false);assert.equal(observer(f).props.active,true);
  assert.equal(messageField(f).props.value,"Borrador para el asesor");assert.equal(noteField(f).props.value,"Nota privada en preparación");
  assert.equal(f.requests.some(r=>r.init.method),false);f.unmount();
});

test("filtros globales usan search/filter/state y descartan una respuesta anterior sin tocar el borrador",async()=>{
  const f=mount({mode:"attention",embedded:true,canAssignFilter:true});await resolveReads(f);await selectWork(f);
  messageField(f).props.onChange({target:{value:"Borrador conservado"}});noteField(f).props.onChange({target:{value:"Observación conservada"}});await f.flush();
  plainButton(f,"No leídos").props.onClick();await f.flush();const older=f.requests.filter(r=>!r.done);
  f.all().find(n=>n.props["aria-label"]==="Buscar solicitudes").props.onChange({target:{value:"Aliado buscado"}});await f.flush();
  await f.advance(250);const fresh=f.requests.filter(r=>!r.done&&!older.includes(r));
  const list=fresh.find(r=>r.url.includes("?")),params=new URL(list.url,"https://local.invalid").searchParams;
  assert.equal(params.get("search"),"Aliado buscado");assert.equal(params.get("filter"),"unread");assert.equal(params.get("page"),"1");
  for(const request of fresh)request.respond(request.url.includes("?")?{items:[itemB],total:1}:detailFor());await f.flush();
  for(const request of older)request.respond(request.url.includes("?")?{items:[{...itemA,name:"Respuesta vieja que debe descartarse"}],total:1}:detailFor({...itemA,name:"Detalle viejo"}));await f.flush();
  assert.doesNotMatch(text(f.tree),/Respuesta vieja|Detalle viejo/);assert.equal(messageField(f).props.value,"Borrador conservado");assert.equal(noteField(f).props.value,"Observación conservada");
  f.all().find(n=>n.props["aria-label"]==="Estado de solicitudes").props.onChange({target:{value:"information"}});await f.flush();
  assert.match(f.requests.filter(r=>!r.done&&r.url.includes("?")).at(-1).url,/state=information/);
  assert.ok(plainButton(f,"Sin asignar"));f.unmount();
  const nominal=mount({mode:"attention",embedded:true});await resolveReads(nominal);assert.equal(plainButton(nominal,"Sin asignar"),undefined);nominal.unmount();
});

test("la lectura observada usa conversationId real y JSON; no equivale a leer una notificación",async()=>{
  const f=mount({mode:"attention",embedded:true});await resolveReads(f);await selectWork(f);
  assert.equal(observer(f).props.detail.conversation.id,itemA.conversationId);assert.equal(observer(f).props.detail.messages[0].id,detailFor().messages[0].id);
  assert.equal(observer(f).props.allowContainingDialog,false);
  const pending=observer(f).props.request(`/api/atencion/${itemA.conversationId}/read`,{method:"POST",body:JSON.stringify({messageIds:[detailFor().messages[0].id]})});await f.flush();
  const request=f.requests.at(-1);assert.equal(request.url,`/api/atencion/${itemA.conversationId}/read`);assert.equal(request.init.headers["Content-Type"],"application/json");
  assert.equal(f.requests.some(r=>/notifications/.test(r.url)),false);request.respond({unreadCount:0,changed:true});await pending;
  f.button("Validar enrolamiento").props.onClick();await f.flush();assert.equal(observer(f).props.active,false);
  const management=f.all().find(n=>n.type?.name==="./attention-work-management");assert.equal(management.props.open,true);assert.equal(management.props.chatTheme,"dark");
  management.props.onClose();await f.flush();assert.equal(observer(f).props.active,true);f.unmount();
});

test("errores tardíos de una lectura abortada no retiran el caso revalidado ni bloquean sus acciones",async()=>{
  for(const status of [401,403,404]){
    const f=mount({mode:"attention",embedded:true});await resolveReads(f);await selectWork(f);
    plainButton(f,"No leídos").props.onClick();await f.flush();const older=f.requests.filter(r=>!r.done);
    plainButton(f,"Todos").props.onClick();await f.flush();const from=f.requests.indexOf(older.at(-1))+1;
    await resolveReads(f,detailFor(),[itemA,itemB],from);
    for(const request of older)request.respond({error:"Error de la lectura anterior"},status);await f.flush();
    assert.ok(messageField(f));assert.equal(messageField(f).props.disabled,false);assert.doesNotMatch(text(f.tree),/Error de la lectura anterior|Vuelve a iniciar sesión/);f.unmount();
  }
});

test("Enter envía una sola intención interna y conserva Shift, IME y repeticiones",async()=>{
  const busy=[];const f=mount({mode:"attention",embedded:true,onBusyChange:value=>busy.push(value)});await resolveReads(f);await selectWork(f);
  messageField(f).props.onChange({target:{value:"Mensaje interno revisado"}});await f.flush();
  const event=flags=>({key:"Enter",nativeEvent:{},repeat:false,shiftKey:false,ctrlKey:false,metaKey:false,altKey:false,prevented:false,preventDefault(){this.prevented=true;},currentTarget:{form:{requestSubmit(){f.all().find(n=>n.type==="form"&&n.props.className==="composer").props.onSubmit({preventDefault(){}});}}},...flags});
  for(const flags of [{shiftKey:true},{ctrlKey:true},{altKey:true},{metaKey:true},{nativeEvent:{isComposing:true}},{nativeEvent:{keyCode:229}},{repeat:true}])messageField(f).props.onKeyDown(event(flags));
  assert.equal(f.requests.some(r=>r.init.method==="PATCH"),false);
  const key=messageField(f).props.onKeyDown;key(event({}));key(event({}));await f.flush();
  const writes=f.requests.filter(r=>r.init.method==="PATCH");assert.equal(writes.length,1);assert.equal(JSON.parse(writes[0].init.body).action,"message");assert.equal(JSON.parse(writes[0].init.body).text,"Mensaje interno revisado");assert.ok(busy.includes(true));
  writes[0].respond({...detailFor(),item:{...itemA,version:3}});await f.flush();assert.equal(messageField(f).props.value,"");
  assert.equal(busy.at(-1),false);f.unmount();assert.equal(busy.at(-1),false);
});

test("bandeja inactiva retira datos y lecturas; volver revalida y conserva texto, nota y archivo",async()=>{
  const f=mount({mode:"attention",embedded:true,sse:true});await resolveReads(f);await selectWork(f);
  messageField(f).props.onChange({target:{value:"Mensaje pendiente A"}});noteField(f).props.onChange({target:{value:"Nota pendiente A"}});
  const photo=new File(["imagen artificial"],"prueba.png",{type:"image/png"});f.all().find(n=>n.type?.name==="Input"&&n.props.type==="file").props.onChange({target:{files:[photo],value:""}});await f.flush();
  f.button("Ficha").props.onClick();await f.flush();assert.equal(panel(f).props.open,true);
  f.setProps({active:false});await f.flush();assert.equal(panel(f).props.open,false);assert.equal(messageField(f),undefined);assert.equal(observer(f),undefined);assert.ok(f.sources.every(source=>source.closed));
  const count=f.requests.length;await f.advance(10000);assert.equal(f.requests.length,count);
  f.setProps({active:true});await f.flush();assert.equal(messageField(f),undefined,"espera revalidación antes de presentar el borrador privado");
  await resolveReads(f);assert.equal(messageField(f).props.value,"Mensaje pendiente A");assert.equal(noteField(f).props.value,"Nota pendiente A");assert.match(text(f.tree),/prueba.png/);assert.equal(panel(f).props.open,false);assert.equal(f.sources.filter(source=>!source.closed).length,1);f.unmount();
});

test("initialId abre otra solicitud sin remontar ni mezclar borradores; 403 libera navegación del padre",async()=>{
  const busy=[];const f=mount({mode:"attention",embedded:true,onBusyChange:value=>busy.push(value)});await resolveReads(f);await selectWork(f);
  messageField(f).props.onChange({target:{value:"Borrador A"}});noteField(f).props.onChange({target:{value:"Nota A"}});await f.flush();
  f.setProps({initialId:itemB.id});await f.flush();await resolveReads(f,detailFor(itemB));assert.equal(messageField(f).props.value,"");assert.equal(noteField(f).props.value,"");
  messageField(f).props.onChange({target:{value:"Borrador B"}});await f.flush();await selectWork(f,itemA);
  assert.equal(messageField(f).props.value,"Borrador A");assert.equal(noteField(f).props.value,"Nota A");
  f.setProps({active:false});await f.flush();f.setProps({active:true});await f.flush();
  const denied=f.requests.filter(r=>!r.done);denied[0].respond({error:"Acceso denegado"},403);for(const request of denied.slice(1))request.respond(detailFor());await f.flush();
  assert.equal(messageField(f),undefined);assert.equal(panel(f).props.open,false);assert.equal(busy.at(-1),false);assert.match(text(f.tree),/Vuelve a iniciar sesión/);f.unmount();
});

test("la imagen interna abre el visor privado y se retira al cambiar de caso, bandeja o acceso",async()=>{
  const imageDetail=detailFor();imageDetail.messages[0].attachment={id:"00000000-0000-4000-8000-000000000041",kind:"image",fileName:"soporte-prueba.png"};
  const f=mount({mode:"attention",embedded:true,initialId:itemA.id});await resolveReads(f,imageDetail);
  const viewer=()=>f.all().find(n=>n.type?.name==="./attention-image-viewer"),thumbnail=()=>f.all().find(n=>n.type==="button"&&n.props["aria-label"]==="Abrir soporte-prueba.png");
  assert.equal(viewer(),undefined);thumbnail().props.onClick();await f.flush();
  assert.equal(viewer().props.url,`/api/atencion/solicitudes/${itemA.id}/files/${imageDetail.messages[0].attachment.id}`);assert.equal(viewer().props.name,"soporte-prueba.png");assert.equal(observer(f).props.active,false);
  assert.ok(f.all().some(n=>n.type==="a"&&n.props.download==="soporte-prueba.png"&&text(n)==="Descargar imagen"));
  viewer().props.onClose();await f.flush();assert.equal(viewer(),undefined);assert.equal(observer(f).props.active,true);
  messageField(f).props.onChange({target:{value:"Borrador junto a imagen"}});await f.flush();thumbnail().props.onClick();await f.flush();
  f.setProps({active:false});await f.flush();assert.equal(viewer(),undefined);f.setProps({active:true});await f.flush();await resolveReads(f,imageDetail);assert.equal(viewer(),undefined);assert.equal(messageField(f).props.value,"Borrador junto a imagen");
  thumbnail().props.onClick();await f.flush();await selectWork(f,itemB);assert.equal(viewer(),undefined);
  await selectWork(f,itemA,imageDetail);thumbnail().props.onClick();await f.flush();f.button("Actualizar solicitudes").props.onClick();await f.flush();
  const pending=f.requests.filter(r=>!r.done);pending[0].respond({error:"Acceso denegado"},403);for(const request of pending.slice(1))request.respond(imageDetail);await f.flush();
  assert.equal(viewer(),undefined);assert.equal(messageField(f),undefined);assert.equal(f.requests.some(r=>r.init.method),false);f.unmount();
});

test("allowCreate=false conserva la bandeja del asesor sin crear ni buscar otras ventas",async()=>{
  const f=mount({allowCreate:false});await resolveReads(f);
  assert.ok(f.all().some(n=>n.type==="aside"&&n.props.className==="inbox"));assert.equal(f.button("Crear solicitud"),undefined);assert.equal(f.query(),undefined);
  assert.equal(f.all().some(n=>n.type==="details"&&n.props.className==="create"),false);assert.equal(f.requests.some(r=>r.url.startsWith("/api/solicitudes")),false);f.unmount();
});

const sellerCase=()=>({...detailFor(),canManage:false,canAssign:false});
const singleOptions={mode:"seller",singleCase:true,allowCreate:false,initialId:itemA.id,expectedTarget:itemA.target};
test("el chat de una venta consulta solo su caso; la ficha colapsable conserva el borrador y los soportes",async()=>{
  const current=sellerCase();current.messages[0].attachment={id:"00000000-0000-4000-8000-000000000041",kind:"image",fileName:"soporte-privado.png"};
  const f=mount({...singleOptions,sse:true});assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,`/api/ventas/atencion/${itemA.id}`);await resolveReads(f,current);
  assert.ok(f.tree.props.className.includes("singleCase"));assert.equal(f.all().some(n=>n.type==="aside"&&n.props.className==="inbox"),false);assert.equal(f.button("Volver a la bandeja"),undefined);assert.equal(f.button("Crear solicitud"),undefined);assert.equal(panel(f),undefined);
  const profile=()=>f.all().find(n=>n.type==="section"&&n.props.className==="singleProfile");assert.equal(profile().props.hidden,true);
  messageField(f).props.onChange({target:{value:"Consulta privada del asesor"}});await f.flush();f.button("Ficha").props.onClick();await f.flush();assert.equal(profile().props.hidden,false);assert.equal(f.button("Ficha").props["aria-expanded"],true);
  f.button("Ficha").props.onClick();await f.flush();assert.equal(profile().props.hidden,true);assert.equal(messageField(f).props.value,"Consulta privada del asesor");
  assert.ok(f.all().some(n=>n.type==="a"&&n.props.href===`/api/ventas/atencion/${itemA.id}/files/${current.messages[0].attachment.id}`));
  const before=f.requests.length;await f.advance(5000);assert.equal(f.requests.length,before+1);await resolveReads(f,current);f.sources.find(source=>!source.closed).emit("invalidate");await f.flush();await resolveReads(f,current);
  assert.ok(f.requests.every(r=>r.url===`/api/ventas/atencion/${itemA.id}`));assert.equal(f.requests.some(r=>r.init.method),false);f.unmount();
});

test("un caso único conserva el intento de mensaje hasta confirmar y no permite crear otro caso",async()=>{
  const busy=[];const f=mount({...singleOptions,onBusyChange:value=>busy.push(value)});await resolveReads(f,sellerCase());
  messageField(f).props.onChange({target:{value:"¿Puede revisar el equipo?"}});await f.flush();
  f.all().find(n=>n.type==="form"&&n.props.className==="composer").props.onSubmit({preventDefault(){}});await f.flush();
  const sent=f.requests.find(r=>r.init.method==="PATCH"),body=sent.init.body;assert.equal(sent.url,`/api/ventas/atencion/${itemA.id}`);sent.respond({error:"Resultado sin confirmar"},500);await f.flush();await resolveReads(f,sellerCase());
  assert.equal(messageField(f).props.disabled,true);assert.equal(busy.at(-1),true);assert.match(text(f.tree),/Consultar \/ reintentar mismo intento/);
  f.button("Consultar / reintentar mismo intento").props.onClick();await f.flush();const retried=f.requests.filter(r=>r.init.method==="PATCH").at(-1);assert.equal(retried.init.body,body);retried.respond({...sellerCase(),item:{...itemA,version:3}});await f.flush();
  assert.equal(messageField(f).props.value,"");assert.equal(busy.at(-1),false);assert.equal(f.requests.some(r=>r.init.method==="POST"),false);f.unmount();
});

test("un caso único bloquea y retira datos si cambian id, tipo o venta en cualquier respuesta",async()=>{
  const mismatches=[{id:itemB.id},{kind:"welcome"},{target:"D-999"}];
  for(const mismatch of mismatches){
    const f=mount(singleOptions);await resolveReads(f,{...sellerCase(),item:{...itemA,...mismatch}});
    assert.equal(messageField(f),undefined);assert.match(text(f.tree),/ya no corresponde al enrolamiento de esta venta/);const count=f.requests.length;await f.advance(5000);assert.equal(f.requests.length,count);f.unmount();
  }
  for(const upload of [false,true]){
    const busy=[];const f=mount({...singleOptions,onBusyChange:value=>busy.push(value)});await resolveReads(f,sellerCase());
    if(upload){const file=new File(["imagen artificial"],"soporte-prueba.png",{type:"image/png"});f.all().find(n=>n.type?.name==="Input"&&n.props.type==="file").props.onChange({target:{files:[file],value:""}});await f.flush();f.button("Enviar soporte").props.onClick();}
    else{messageField(f).props.onChange({target:{value:"Texto de prueba"}});await f.flush();f.all().find(n=>n.type==="form"&&n.props.className==="composer").props.onSubmit({preventDefault(){}});}
    await f.flush();f.requests.find(r=>r.init.method).respond({...sellerCase(),item:{...itemA,target:"D-999"}});await f.flush();
    assert.equal(messageField(f),undefined);assert.equal(f.button("Consultar / reintentar mismo intento"),undefined);assert.match(text(f.tree),/ya no corresponde al enrolamiento de esta venta/);assert.equal(busy.at(-1),false);f.unmount();
  }
});

test("sin id el chat único no consulta una bandeja; revocar acceso elimina sus datos y archivos",async()=>{
  const empty=mount({...singleOptions,initialId:null});await empty.flush();assert.equal(empty.requests.length,0);assert.match(text(empty.tree),/No hay una solicitud vinculada/);empty.unmount();
  const f=mount({...singleOptions,sse:true});await resolveReads(f,sellerCase());messageField(f).props.onChange({target:{value:"Borrador protegido"}});await f.flush();f.button("Ficha").props.onClick();await f.flush();
  f.sources.find(source=>!source.closed).emit("access_revoked");await f.flush();assert.equal(messageField(f),undefined);assert.equal(f.button("Ficha"),undefined);assert.match(text(f.tree),/Vuelve a iniciar sesión/);assert.ok(f.sources.every(source=>source.closed));f.unmount();
});

test("el equipo central abre solo el caso de la venta y gestiona con ficha inline y tema claro",async()=>{
  const f=mount({...singleOptions,mode:"attention",embedded:true,sse:true});await resolveReads(f);
  assert.ok(f.tree.props.className.includes("singleCase"));assert.equal(f.tree.props.className.includes("embedded"),false);
  assert.equal(f.all().some(n=>n.type==="aside"&&n.props.className==="inbox"),false);assert.equal(f.button("Volver a la bandeja"),undefined);assert.equal(panel(f),undefined);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,`/api/atencion/solicitudes/${itemA.id}`);assert.equal(f.sources.find(source=>!source.closed).url,"/api/atencion/events");
  const profile=()=>f.all().find(n=>n.type==="section"&&n.props.className==="singleProfile");assert.equal(profile().props.hidden,true);assert.equal(observer(f).props.active,true);
  assert.equal(observer(f).props.allowContainingDialog,true);
  messageField(f).props.onChange({target:{value:"Respuesta central preparada"}});noteField(f).props.onChange({target:{value:"Nota del analista"}});await f.flush();
  f.button("Ficha").props.onClick();await f.flush();assert.equal(profile().props.hidden,false);assert.equal(observer(f).props.active,false);assert.ok(f.button("Asignar"));
  f.button("Ficha").props.onClick();await f.flush();assert.equal(observer(f).props.active,true);assert.equal(messageField(f).props.value,"Respuesta central preparada");assert.equal(noteField(f).props.value,"Nota del analista");
  f.button("Validar enrolamiento").props.onClick();await f.flush();const management=f.all().find(n=>n.type?.name==="./attention-work-management");assert.equal(management.props.open,true);assert.equal(management.props.chatTheme,undefined);assert.equal(observer(f).props.active,false);
  management.props.onClose();await f.flush();assert.equal(observer(f).props.active,true);await f.advance(5000);await resolveReads(f);
  assert.ok(f.requests.every(r=>r.url===`/api/atencion/solicitudes/${itemA.id}`));assert.equal(f.requests.some(r=>r.init.method),false);f.unmount();
});

test("el caso central respeta los permisos del analista y no envía con acceso solo de consulta",async()=>{
  const f=mount({...singleOptions,mode:"attention"});await resolveReads(f,{...detailFor(),canWrite:false,canManage:false,canAssign:false,team:[]});
  assert.equal(messageField(f).props.disabled,true);assert.equal(f.button("Enviar").props.disabled,true);assert.equal(f.button("Validar enrolamiento"),undefined);assert.equal(f.button("Asignar"),undefined);assert.equal(f.button("Guardar solo nota interna"),undefined);
  messageField(f).props.onChange({target:{value:"No se debe enviar"}});await f.flush();f.all().find(n=>n.type==="form"&&n.props.className==="composer").props.onSubmit({preventDefault(){}});await f.flush();
  assert.equal(f.requests.some(r=>r.init.method),false);assert.match(text(f.tree),/Tu perfil tiene acceso de consulta/);f.unmount();
});

test("el caso central retira datos ante otra vinculación, incluso al recibir la gestión del analista",async()=>{
  for(const mismatch of [{id:itemB.id},{kind:"welcome"},{target:"D-999"}]){
    const f=mount({...singleOptions,mode:"attention"});await resolveReads(f,{...detailFor(),item:{...itemA,...mismatch}});assert.equal(messageField(f),undefined);assert.match(text(f.tree),/ya no corresponde al enrolamiento de esta venta/);f.unmount();
  }
  const f=mount({...singleOptions,mode:"attention"});await resolveReads(f);f.button("Validar enrolamiento").props.onClick();await f.flush();
  f.all().find(n=>n.type?.name==="./attention-work-management").props.onUpdated({...detailFor(),item:{...itemA,target:"D-999"}});await f.flush();assert.equal(messageField(f),undefined);assert.equal(observer(f),undefined);assert.equal(f.button("Ficha"),undefined);assert.match(text(f.tree),/ya no corresponde al enrolamiento de esta venta/);assert.equal(f.requests.some(r=>r.init.method),false);f.unmount();
});

const stateSelect=f=>f.all().find(n=>n.props["aria-label"]==="Estado de solicitudes");
const workRow=(f,id)=>f.all().find(n=>n.type==="button"&&n.key===id);
const workManager=f=>f.all().find(n=>n.type?.name==="./attention-work-management");
async function staffWork(kind="enrollment",options={}){
  const a={...itemA,kind},b={...itemB,kind},f=mount({mode:"attention",embedded:true,canAssignFilter:true,kind,...options});
  await resolveReads(f,detailFor(a),[a,b],0,41);
  if(!options.initialId){workRow(f,a.id).props.onClick();await f.flush();await resolveReads(f,detailFor(a),[a,b],0,41);}
  return{f,a,b,completed:{...detailFor({...a,state:"completed",version:3}),canWrite:false}};
}

for(const kind of ["enrollment","welcome"])test(`${kind}: la gestión confirmada sale de pendientes, libera navegación y conserva sus borradores en historial`,async()=>{
  const busy=[];const{f,a,b,completed}=await staffWork(kind,{onBusyChange:value=>busy.push(value)});
  assert.equal(stateSelect(f).props.value,"active");assert.equal(new URL(f.requests[0].url,"https://local.invalid").searchParams.get("state"),"active");
  assert.equal(f.button("Página siguiente").props.disabled,false);
  messageField(f).props.onChange({target:{value:"Borrador que permanece en historial"}});noteField(f).props.onChange({target:{value:"Nota que permanece"}});
  const file=new File(["soporte artificial"],"soporte-pendiente.png",{type:"image/png"});f.all().find(n=>n.type?.name==="Input"&&n.props.type==="file").props.onChange({target:{files:[file],value:""}});await f.flush();
  f.button("Ficha").props.onClick();await f.flush();f.button(kind==="enrollment"?"Validar enrolamiento":"Gestionar bienvenida").props.onClick();await f.flush();
  const management=workManager(f);management.props.onBusyChange(true);await f.flush();assert.equal(busy.at(-1),true);management.props.onUpdated(completed);await f.flush();
  assert.equal(workRow(f,a.id),undefined);assert.ok(workRow(f,b.id));assert.equal(messageField(f),undefined);assert.equal(panel(f).props.open,false);assert.equal(workManager(f),undefined);assert.equal(f.tree.props.className.includes("showDetail"),false);assert.equal(busy.at(-1),false);assert.equal(f.button("Página siguiente").props.disabled,true);
  assert.ok(f.all().some(n=>n.props.role==="status"&&/Solicitud finalizada/.test(text(n))));
  await resolveReads(f,null,[b],0,80);assert.equal(f.button("Página siguiente").props.disabled,false,"el total siguiente vuelve a ser el del servidor");
  stateSelect(f).props.onChange({target:{value:"completed"}});await f.flush();await resolveReads(f,null,[completed.item]);workRow(f,a.id).props.onClick();await f.flush();await resolveReads(f,completed,[completed.item]);
  assert.equal(messageField(f).props.value,"Borrador que permanece en historial");assert.equal(noteField(f).props.value,"Nota que permanece");assert.match(text(f.tree),/soporte-pendiente.png/);assert.equal(f.requests.some(r=>r.init.method==="DELETE"),false);f.unmount();
});

for(const kind of ["enrollment","welcome"])test(`${kind}: una finalización de otro analista retira el caso con el siguiente evento real`,async()=>{
  const{f,a,b,completed}=await staffWork(kind,{sse:true});f.sources.find(source=>!source.closed).emit("invalidate");await f.flush();await resolveReads(f,completed,[b],0,41);
  assert.equal(messageField(f),undefined);assert.equal(workRow(f,a.id),undefined);assert.ok(workRow(f,b.id));assert.equal(f.button("Página siguiente").props.disabled,false,"no resta otra vez al total recibido del servidor");
  assert.equal(f.requests.some(r=>r.init.method),false);f.unmount();
});

test("todos, no leídos y sin asignar conservan el filtro de pendientes de gestión",async()=>{
  const{f,a,b}=await staffWork();
  for(const [label,filter]of[["No leídos","unread"],["Sin asignar","unassigned"],["Todos","all"]]){
    plainButton(f,label).props.onClick();await f.flush();const request=f.requests.filter(r=>!r.done&&r.url.includes("?")).at(-1),params=new URL(request.url,"https://local.invalid").searchParams;
    assert.equal(params.get("filter"),filter);assert.equal(params.get("state"),"active");await resolveReads(f,detailFor(a),[a,b]);
  }
  assert.equal(nodes(stateSelect(f)).some(n=>n.type==="option"&&n.props.value===""),false);assert.ok(nodes(stateSelect(f)).some(n=>n.type==="option"&&text(n)==="Finalizadas (historial)"));f.unmount();
});

test("finalizar también retira el caso de los filtros pendiente, revisión e información pendiente",async()=>{
  for(const state of ["pending","review","information"]){
    const{f,a,b,completed}=await staffWork();stateSelect(f).props.onChange({target:{value:state}});await f.flush();await resolveReads(f,detailFor({...a,state}),[{...a,state},b]);workManager(f).props.onUpdated(completed);await f.flush();
    assert.equal(messageField(f),undefined);assert.equal(workRow(f,a.id),undefined);assert.equal(stateSelect(f).props.value,state);f.unmount();
  }
});

test("un enlace nuevo a un caso finalizado abre historial; el filtro histórico conserva la consulta",async()=>{
  const completed={...detailFor({...itemA,state:"completed"}),canWrite:false};const f=mount({mode:"attention",embedded:true,initialId:itemA.id});await resolveReads(f,completed,[]);
  assert.equal(stateSelect(f).props.value,"completed");assert.ok(messageField(f));assert.equal(messageField(f).props.disabled,true);await resolveReads(f,completed,[completed.item]);assert.ok(workRow(f,itemA.id));
  workManager(f).props.onUpdated(completed);await f.flush();assert.ok(messageField(f));assert.ok(workRow(f,itemA.id));assert.doesNotMatch(text(f.tree),/Solicitud finalizada\. Puedes consultar/);f.unmount();
  const history=await staffWork();stateSelect(history.f).props.onChange({target:{value:"completed"}});await history.f.flush();await resolveReads(history.f,history.completed,[history.completed.item]);assert.ok(messageField(history.f));assert.ok(workRow(history.f,history.a.id));history.f.unmount();
});

test("la consulta externa de un caso finalizado no abandona una escritura incierta; el reintento confirmado sí",async()=>{
  const busy=[];const{f,a,b,completed}=await staffWork("enrollment",{onBusyChange:value=>busy.push(value)});messageField(f).props.onChange({target:{value:"Mensaje de resultado incierto"}});await f.flush();
  f.all().find(n=>n.type==="form"&&n.props.className==="composer").props.onSubmit({preventDefault(){}});await f.flush();const sent=f.requests.find(r=>r.init.method==="PATCH"),body=sent.init.body;sent.respond({error:"Resultado sin confirmar"},500);await f.flush();await resolveReads(f,completed,[b]);
  assert.ok(messageField(f));assert.equal(messageField(f).props.value,"Mensaje de resultado incierto");assert.equal(messageField(f).props.disabled,true);assert.ok(f.button("Consultar / reintentar mismo intento"));assert.equal(busy.at(-1),true);
  f.button("Consultar / reintentar mismo intento").props.onClick();await f.flush();const retried=f.requests.filter(r=>r.init.method==="PATCH").at(-1);assert.equal(retried.init.body,body);retried.respond(completed);await f.flush();assert.equal(messageField(f),undefined);assert.equal(workRow(f,a.id),undefined);assert.equal(busy.at(-1),false);f.unmount();
});

test("las solicitudes únicas y del asesor conservan su historial finalizado",async()=>{
  const completed={...sellerCase(),item:{...itemA,state:"completed"},canWrite:false};
  for(const options of [singleOptions,{...singleOptions,mode:"attention"},{mode:"seller",initialId:itemA.id}]){
    const f=mount(options);await resolveReads(f,completed,[completed.item]);assert.ok(messageField(f));assert.equal(messageField(f).props.disabled,true);assert.equal(stateSelect(f),undefined);assert.doesNotMatch(text(f.tree),/Solicitud finalizada\. Puedes consultar/);f.unmount();
  }
});
