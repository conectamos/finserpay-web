import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const actor = { key: "admin:1", name: "Central de prueba", central: true, admin: true };
const chatA = { id: "00000000-0000-4000-8000-000000000001", name: "Contacto artificial A", phone: "+573001234567", channel: "whatsapp", externalId: "fixture-A", status: "open", version: 4, tags: [] };
const chatB = { ...chatA, id: "00000000-0000-4000-8000-000000000002", name: "Contacto artificial B", phone: "+573009876543", externalId: "fixture-B" };
const message = { id: "00000000-0000-4000-8000-000000000003", text: "Prueba local: contactar al 3009876543", direction: "inbound", sentAt: "2026-10-31T22:00:00Z", author: null };
const detail = chat => ({ conversation: chat, permissions: { canSend: true, manage: true }, messaging: { canReply: true, windowExpiresAt: "2099-01-01T00:00:00Z", reason: null }, customer: {}, notes: [], tasks: [], messages: [message] });
const inbox = activeActor => ({ actor: activeActor, schemaReady: true, conversations: [chatA,chatB], total: 2, pageSize: 40, team: [], quickReplies: [], metrics: {}, integration: { configured: true, canSync: true, canSend: true } });
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree,...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" ? tree : "";

// Execute the real Console. Responses can arrive after abort/navigation intentionally.
function mount(activeActor = actor) {
  let cursor = 0, dirty = false, effects = [], tree, timerId = 0, now = 0, mounted = true, updatesAfterUnmount = 0;
  const slots = [], requests = [], timers = new Map(), events = new Map();
  const changed = (a,b) => !a || !b || a.length !== b.length || b.some((value,index) => !Object.is(value,a[index]));
  const schedule = (fn,delay = 0,interval = 0) => { const id = ++timerId; timers.set(id,{ fn,at:now+delay,interval }); return id; };
  const react = {
    Fragment: "fragment",
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[index].value,next => { if(!mounted) { updatesAfterUnmount++; return; } slots[index].value = typeof next === "function" ? next(slots[index].value) : next; dirty = true; }]; },
    useRef(value) { const index = cursor++; slots[index] ??= { current:value }; return slots[index]; },
    useCallback(fn,deps) { const index = cursor++; if(!slots[index] || changed(slots[index].deps,deps)) slots[index] = { fn,deps }; return slots[index].fn; },
    useMemo(fn,deps) { const index = cursor++; if(!slots[index] || changed(slots[index].deps,deps)) slots[index] = { value:fn(),deps }; return slots[index].value; },
    useEffect(fn,deps) { const index = cursor++; if(!slots[index] || changed(slots[index].deps,deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps,cleanup:fn() }; }); },
  };
  const component = name => Object.defineProperty(() => null,"name",{value:name});
  const source = readFileSync(new URL("../app/dashboard/atencion/attention-console.tsx",import.meta.url),"utf8"), loaded = { exports:{} };
  const target = name => ({ addEventListener(event,fn) { events.set(`${name}:${event}`,fn); }, removeEventListener(event) { events.delete(`${name}:${event}`); } });
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    module:loaded,exports:loaded.exports,Error,FormData,File,AbortController,URLSearchParams,URL,
    document:{visibilityState:"visible",...target("document")},navigator:{onLine:true},window:target("window"),
    sessionStorage:{getItem:()=>null,removeItem(){},setItem(){}},crypto:{randomUUID:()=>"00000000-0000-4000-8000-000000000010"},
    setTimeout:(fn,delay)=>schedule(fn,delay),clearTimeout:id=>timers.delete(id),setInterval:(fn,delay)=>schedule(fn,delay,delay),clearInterval:id=>timers.delete(id),requestAnimationFrame:fn=>schedule(fn,0),cancelAnimationFrame:id=>timers.delete(id),
    fetch:(url,init)=>new Promise((resolve,reject)=>requests.push({url,init,done:false,respond(body,status=200){this.done=true;resolve({ok:status>=200&&status<300,status,headers:new Headers(),json:async()=>body});},fail(){this.done=true;reject(new Error("Conexión artificial interrumpida"));}})),
    require(name) {
      if(name==="react") return react;
      if(name==="react/jsx-runtime") return {jsx,jsxs:jsx,Fragment:"fragment"};
      if(name==="lucide-react" || name==="@/app/_components/finser-ui" || name==="./attention-operational") return new Proxy({},{get:(_,key)=>component(String(key))});
      if(name.endsWith(".css")) return {default:new Proxy({},{get:(_,key)=>String(key)})};
      return {default:component(name)};
    },
  });
  function render() { cursor=0;dirty=false;effects=[];tree=loaded.exports.default({actor:activeActor});for(const effect of effects) effect(); }
  async function flush() { for(let i=0;i<22;i++) { await Promise.resolve();if(dirty&&mounted) render(); } }
  async function advance(ms) {
    const until=now+ms;
    for(;;) { const next=[...timers].filter(([,entry])=>entry.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next) break;const[id,entry]=next;now=entry.at;if(entry.interval) entry.at+=entry.interval;else timers.delete(id);entry.fn();await flush(); }
    now=until;await flush();
  }
  const all=()=>nodes(tree), composer=()=>all().find(node=>node.type?.name==="ReplyComposer");
  render();
  return {
    requests,flush,advance,all,composer,
    actions:()=>all().find(node=>node.type?.name==="MessageContent")?.props.phoneActions,
    get updatesAfterUnmount(){return updatesAfterUnmount;},
    async ready(){await advance(250);requests.at(-1).respond(inbox(activeActor));await flush();},
    async select(chat=chatA){all().find(node=>node.type==="button"&&text(node).includes(chat.name)).props.onClick();await flush();await advance(0);requests.at(-1).respond(detail(chat));await flush();},
    async change(patch){composer().props.change(patch);await flush();},
    async finishNavigation(chat){await flush();await advance(0);requests.at(-1).respond(detail(chat));await flush();},
    unmount(){for(const slot of slots) slot?.cleanup?.();mounted=false;},
  };
}

function lookup(f,signal) {
  const actions=f.actions();assert.ok(actions);
  const pending=actions.onOpenPhone(chatB.phone,signal).then(value=>({value}),error=>({error}));
  return {actions,pending};
}
const phoneRequest=f=>f.requests.find(request=>!request.done&&request.url.startsWith("/api/atencion/phone?"));

for(const status of [401,403]) test(`consulta telefónica ${status} tardía no retira el nuevo chat ni sus borradores`,async()=>{
  const f=mount();await f.ready();await f.select();await f.change({text:"Borrador A conservado"});
  const {pending}=lookup(f);await f.flush();const previous=phoneRequest(f);assert.ok(previous);
  await f.select(chatB);const image=new File(["imagen sintética"],"borrador-B.png",{type:"image/png"});await f.change({text:"Borrador B conservado",file:image});
  previous.respond({error:"Consulta obsoleta del chat anterior"},status);await pending;await f.flush();
  assert.equal(f.composer()?.props.detail.conversation.id,chatB.id);assert.equal(f.composer().props.draft.text,"Borrador B conservado");assert.equal(f.composer().props.draft.file,image);
  assert.ok(!f.all().some(node=>node.props.role==="alert"&&text(node).includes("Consulta obsoleta")));
  await f.select(chatA);assert.equal(f.composer().props.draft.text,"Borrador A conservado");f.unmount();
});

test("abrir la coincidencia real conserva texto y archivo de cada chat y no envía mensajes",async()=>{
  const f=mount();await f.ready();await f.select();const file=new File(["imagen artificial"],"borrador-A.png",{type:"image/png"});await f.change({text:"Respuesta pendiente A",file});
  const {actions,pending}=lookup(f);await f.flush();const request=phoneRequest(f);assert.equal(new URL(request.url,"https://local.invalid").searchParams.get("phone"),chatB.phone);
  request.respond({matches:[{id:chatB.id,name:chatB.name,phone:chatB.phone,status:"open"}],total:1});const result=await pending;assert.equal(result.value.matches[0].id,chatB.id);
  actions.onOpenConversation(result.value.matches[0].id);await f.finishNavigation(chatB);await f.change({text:"Respuesta pendiente B"});
  actions.onOpenConversation(chatA.id);await f.flush();assert.equal(f.composer().props.detail.conversation.id,chatB.id,"una acción antigua no secuestra la selección actual");
  f.actions().onOpenConversation(chatA.id);await f.finishNavigation(chatA);assert.equal(f.composer().props.draft.text,"Respuesta pendiente A");assert.equal(f.composer().props.draft.file,file);
  await f.select(chatB);assert.equal(f.composer().props.draft.text,"Respuesta pendiente B");assert.equal(f.requests.some(request=>request.init.method&&request.init.method!=="GET"),false);f.unmount();
});

for(const status of [401,403]) test(`cerrar opciones aborta el lookup y su ${status} posterior no borra el chat actual`,async()=>{
  const f=mount();await f.ready();await f.select();await f.change({text:"Respuesta que debe permanecer"});const controller=new AbortController();
  const {pending}=lookup(f,controller.signal);await f.flush();const request=phoneRequest(f);assert.ok(request);controller.abort();
  request.respond({error:"Consulta cerrada"},status);await pending;await f.flush();
  assert.equal(f.composer()?.props.detail.conversation.id,chatA.id);assert.equal(f.composer().props.draft.text,"Respuesta que debe permanecer");f.unmount();
});

test("un lookup de la cuenta desmontada no actualiza su estado ni afecta la sesión nueva",async()=>{
  const previous=mount();await previous.ready();await previous.select();const {pending}=lookup(previous);await previous.flush();const oldRequest=phoneRequest(previous);previous.unmount();
  const current=mount({...actor,key:"admin:7",name:"Otra cuenta de prueba"});await current.ready();await current.select(chatB);await current.change({text:"Borrador exclusivo de la cuenta nueva"});
  oldRequest.respond({error:"Acceso anterior revocado"},403);await pending;await previous.flush();await current.flush();
  assert.equal(previous.updatesAfterUnmount,0);assert.equal(current.composer().props.draft.text,"Borrador exclusivo de la cuenta nueva");assert.equal(current.composer().props.detail.conversation.id,chatB.id);current.unmount();
});
