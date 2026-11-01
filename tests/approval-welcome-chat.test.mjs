import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
const jsx=(type,props,key)=>({type,props:props||{},key});
const nodes=t=>Array.isArray(t)?t.flatMap(nodes):t&&typeof t==="object"?[t,...nodes(t.props?.children)]:[];
function mount(options={}){
  const slots=[],busy=[];let cursor=0,dirty=false,tree,effects=[],refreshes=0;
  const unread={count:null,hasNew:false,arrival:0,denied:false,unavailable:false,...options.unread,refresh:()=>{refreshes++;}};
  let props={workId:"00000000-0000-4000-8000-000000000081",creditId:12,onBusyChange:v=>busy.push(v),...options};
  const react={
    useState(v){const n=cursor++;slots[n]??={value:v};return[slots[n].value,next=>{slots[n].value=typeof next==="function"?next(slots[n].value):next;dirty=true;}];},
    useRef(v){const n=cursor++;slots[n]??={current:v};return slots[n];},
    useEffect(fn,deps){const n=cursor++;if(!slots[n])effects.push(()=>{slots[n]={deps,cleanup:fn()};});},
  };
  const component=name=>Object.defineProperty(()=>null,"name",{value:name}),loaded={exports:{}};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../app/dashboard/aprobaciones/approval-welcome-chat.tsx",import.meta.url),"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText,{
    module:loaded,exports:loaded.exports,document:{body:{}},fetch:()=>assert.fail("el launcher no debe enviar solicitudes"),
    require(name){if(name==="react")return react;if(name==="react/jsx-runtime")return{jsx,jsxs:jsx};if(name==="react-dom")return{createPortal:t=>t};
      if(name==="./use-approval-chat-unread")return{useApprovalChatUnread:()=>unread};
      if(name==="lucide-react")return{MessageCircle:component("MessageCircle")};
      if(name.endsWith(".css"))return{default:{}};
      return{default:component(name)};},
  });
  function render(){cursor=0;dirty=false;effects=[];tree=loaded.exports.default(props);effects.forEach(fn=>fn());}
  render();
  return{busy,all:()=>nodes(tree),get refreshes(){return refreshes;},flush(){for(let n=0;dirty&&n<20;n++)render();},setUnread(p){Object.assign(unread,p);render();},setProps(p){props={...props,...p};render();},unmount(){slots.forEach(s=>s?.cleanup?.());}};
}
const launcher=f=>f.all().find(n=>n.type==="button"),panel=f=>f.all().find(n=>n.type?.name?.endsWith("finser-side-panel")),chat=f=>f.all().find(n=>n.type?.name?.endsWith("attention-work-queues"));
test("burbuja abre y minimiza el chat exacto sin desmontar su borrador ni crear solicitudes",()=>{
  const f=mount();assert.equal(panel(f),undefined);assert.equal(chat(f),undefined);
  launcher(f).props.onClick();f.flush();const initial=chat(f);assert.equal(panel(f).props.open,true);assert.equal(panel(f).props.keepMounted,true);assert.equal(chat(f).props.active,true);
  assert.equal(chat(f).props.initialId,"00000000-0000-4000-8000-000000000081");assert.equal(chat(f).props.expectedTarget,"C-12");
  assert.equal(chat(f).props.mode,"attention");assert.equal(chat(f).props.kind,"welcome");assert.equal(chat(f).props.singleCase,true);assert.equal(chat(f).props.allowCreate,false);assert.equal(chat(f).props.welcomeWallOpen,true);
  panel(f).props.onClose();f.flush();assert.equal(panel(f).props.open,false);assert.equal(chat(f).props.active,false);assert.equal(chat(f).key,initial.key);
  launcher(f).props.onClick();f.flush();assert.equal(panel(f).props.open,true);assert.equal(chat(f).key,initial.key);f.unmount();
});
test("envío pendiente bloquea minimizar y avisa al muro sin desactivar su propio chat",()=>{
  const f=mount();launcher(f).props.onClick();f.flush();chat(f).props.onBusyChange(true);f.flush();
  assert.equal(f.busy.at(-1),true);assert.equal(panel(f).props.busy,true);assert.equal(chat(f).props.active,true);assert.equal(launcher(f).props.disabled,true);
  panel(f).props.onClose();f.flush();assert.equal(panel(f).props.open,true);
  chat(f).props.onBusyChange(false);f.flush();panel(f).props.onClose();f.flush();assert.equal(panel(f).props.open,false);assert.equal(f.busy.at(-1),false);f.unmount();
});
test("acciones del expediente impiden abrir o minimizar; desmontaje libera el bloqueo",()=>{
  const f=mount({disabled:true});launcher(f).props.onClick();f.flush();assert.equal(panel(f),undefined);
  f.setProps({disabled:false});launcher(f).props.onClick();f.flush();f.setProps({disabled:true});panel(f).props.onClose();f.flush();assert.equal(panel(f).props.open,true);
  chat(f).props.onBusyChange(true);f.flush();f.unmount();assert.equal(f.busy.at(-1),false);
});

test("muestra contador real y aviso sin abrir ni marcar lectura; abrir no pone el contador en cero",()=>{
  const f=mount({unread:{count:3}});
  assert.match(launcher(f).props["aria-label"],/3 mensajes sin leer/);assert.equal(panel(f),undefined);
  assert.equal(launcher(f).props["data-unread"],true);
  f.setUnread({count:4,hasNew:true,arrival:1});
  const live=()=>f.all().find(n=>n.props.role==="status");
  assert.equal(live().props.children.props.children,"Nuevo mensaje del asesor.");
  const arrival=live().props.children.key;
  f.setUnread({count:3});assert.equal(live().props.children.key,arrival);assert.equal(live().props.children.props.children,"Nuevo mensaje del asesor.");
  f.setUnread({count:4});
  launcher(f).props.onClick();f.flush();assert.match(launcher(f).props["aria-label"],/4 mensajes sin leer/);assert.equal(f.refreshes,1);
  panel(f).props.onClose();f.flush();assert.equal(f.refreshes,2);assert.match(launcher(f).props["aria-label"],/4 mensajes sin leer/);
  assert.equal(live().props.children.key,arrival);assert.equal(live().props.children.props.children,"Nuevo mensaje del asesor.");
  f.setUnread({count:0,hasNew:false});assert.equal(launcher(f).props["data-unread"],undefined);assert.equal(live().props.children.props.children,"");f.unmount();
});

test("la vista compacta mantiene el número exacto accesible y retira datos ante revocación",()=>{
  const f=mount({unread:{count:120}});assert.match(launcher(f).props["aria-label"],/120 mensajes sin leer/);
  assert.ok(f.all().some(n=>String(n.props["aria-hidden"])==="true"&&n.props.children==="99+"));
  launcher(f).props.onClick();f.flush();assert.ok(chat(f));
  f.setUnread({count:null,hasNew:false,denied:true});assert.equal(chat(f),undefined);assert.equal(launcher(f).props.disabled,true);
  assert.equal(launcher(f).props["aria-label"],"Chat de bienvenida no disponible");f.unmount();
});
