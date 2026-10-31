import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx=(type,props,key)=>({type,props:props||{},key});
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==="object"?[tree,...nodes(tree.props?.children)]:[];
const text=tree=>Array.isArray(tree)?tree.map(text).join(""):tree&&typeof tree==="object"?text(tree.props?.children):typeof tree==="string"||typeof tree==="number"?String(tree):"";
const phone="+573001234567",otherPhone="+573009876543";
const message="Hola  300 123 4567\nOtro: +57 300 987 6543";
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const match=(id,name="Contacto de prueba")=>({id,name,phone,status:"open"});

function mount(options={}){
  let cursor=0,dirty=false,effects=[],tree;
  const slots=[],calls=[],opened=[],documentEvents=new Map(),windowEvents=new Map(),viewportEvents=new Map();
  let props={text:message,contextKey:"conversation-a:message-a",onOpenPhone:async value=>{calls.push(value);return{matches:[],total:0};},onOpenConversation:id=>opened.push(id),...options};
  const changed=(a,b)=>!a||!b||a.length!==b.length||b.some((value,index)=>!Object.is(value,a[index]));
  const react={
    useState(value){const index=cursor++;slots[index]??={value:typeof value==="function"?value():value};return[slots[index].value,next=>{const value=typeof next==="function"?next(slots[index].value):next;if(!Object.is(value,slots[index].value)){slots[index].value=value;dirty=true;}}];},
    useRef(value){const index=cursor++;slots[index]??={current:value};return slots[index];},
    useId(){const index=cursor++;slots[index]??={id:`phone-popover-${index}`};return slots[index].id;},
    useCallback(fn,deps){const index=cursor++;if(!slots[index]||changed(slots[index].deps,deps))slots[index]={fn,deps};return slots[index].fn;},
    useEffect(fn,deps){const index=cursor++;if(!slots[index]||changed(slots[index].deps,deps))effects.push(()=>{slots[index]?.cleanup?.();slots[index]={deps,cleanup:fn()};});},
  };
  const bus=events=>({addEventListener(name,fn){if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);},removeEventListener(name,fn){events.get(name)?.delete(fn);}});
  const document={body:{},activeElement:null,...bus(documentEvents)};
  const popupElement={nodeType:1,contains:target=>target===popupElement||target?.owner===popupElement,getBoundingClientRect:()=>({height:options.popupHeight||200}),querySelector:()=>({owner:popupElement,nodeType:1,focus(){document.activeElement=this;}})};
  const window={innerWidth:800,innerHeight:600,...bus(windowEvents),visualViewport:{width:800,height:600,offsetLeft:0,offsetTop:0,...bus(viewportEvents)}};
  const source=readFileSync(new URL("../app/dashboard/atencion/attention-message-text.tsx",import.meta.url),"utf8"),loaded={exports:{}},helper={exports:{}};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/atencion-phone-links.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:helper,exports:helper.exports});
  const component=name=>Object.defineProperty(()=>null,"name",{value:name});
  const result=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true});assert.equal(result.diagnostics.length,0);
  runInNewContext(result.outputText,{
    module:loaded,exports:loaded.exports,Error,AbortController,document,window,
    require(name){
      if(name==="react")return react;
      if(name==="react/jsx-runtime")return{jsx,jsxs:jsx};
      if(name==="react-dom")return{createPortal:children=>jsx("Portal",{children})};
      if(name==="@/lib/atencion-phone-links")return helper.exports;
      if(name==="@/app/_components/finser-ui"||name==="lucide-react")return new Proxy({},{get:(_,key)=>component(String(key))});
      if(name.endsWith(".css"))return{default:new Proxy({},{get:(_,key)=>String(key)})};
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const all=()=>nodes(tree),popover=()=>all().find(node=>node.props.role==="dialog");
  function render(){cursor=0;dirty=false;effects=[];tree=loaded.exports.default(props);if(popover()?.props.ref)popover().props.ref.current=popupElement;for(const run of effects)run();}
  async function flush(){for(let i=0;i<30;i++){await Promise.resolve();if(dirty)render();}}
  const trigger=index=>all().filter(node=>node.type==="button"&&node.props["aria-haspopup"]==="dialog")[index];
  const button=label=>all().find(node=>(node.type==="button"||node.type?.name==="Button")&&(text(node)===label||node.props["aria-label"]===label));
  const anchors=[];
  async function open(index=0){const anchor={nodeType:1,isConnected:true,focuses:0,focus(){this.focuses++;document.activeElement=this;},contains(target){return target===this;},getBoundingClientRect:()=>({left:760,right:800,top:560,bottom:588})};anchors.push(anchor);trigger(index).props.onClick({currentTarget:anchor});await flush();return anchor;}
  async function emit(surface,name,patch={}){const events=surface==="document"?documentEvents:surface==="viewport"?viewportEvents:windowEvents;const event={type:name,target:{nodeType:1},preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...patch};for(const fn of [...(events.get(name)||[])])fn(event);await flush();return event;}
  render();
  return{all,button,trigger,popover,flush,open,emit,calls,opened,anchors,popupElement,document,get tree(){return tree;},setProps(patch){props={...props,...patch};render();},unmount(){for(const slot of slots)slot?.cleanup?.();}};
}

test("el texto conserva espacios y saltos; el primer clic solo abre opciones, sin consultar ni enviar",async()=>{
  const f=mount();await f.flush();assert.equal(text(f.tree),message);assert.equal(f.popover(),undefined);assert.equal(f.calls.length,0);
  await f.open();assert.ok(f.popover());assert.equal(f.calls.length,0);assert.equal(f.opened.length,0);assert.equal(f.button("Abrir chat").props.disabled,false);assert.equal(f.all().some(node=>node.type==="a"),false);
  assert.ok(f.popover().props.style.left>=12);assert.ok(f.popover().props.style.left+f.popover().props.style.width<=788);assert.ok(f.popover().props.style.top>=12);assert.ok(f.popover().props.style.top+200<=588);
  await f.open(1);assert.equal(f.all().filter(node=>node.props.role==="dialog").length,1);assert.equal(f.popover().props["aria-label"],`Opciones para ${otherPhone}`);f.unmount();
});

test("Abrir chat consulta una sola vez y abre únicamente el identificador confirmado",async()=>{
  const pending=deferred(),calls=[];const f=mount({onOpenPhone:value=>{calls.push(value);return pending.promise;}});await f.open();
  const lookup=f.button("Abrir chat").props.onClick;lookup();lookup();await f.flush();assert.deepEqual(calls,[phone]);assert.equal(f.button("Buscando chat…").props.disabled,true);assert.equal(f.opened.length,0);
  pending.resolve({matches:[match("conversation-confirmed")],total:1});await f.flush();assert.deepEqual(f.opened,["conversation-confirmed"]);assert.equal(f.popover(),undefined);f.unmount();
});

test("varios resultados requieren elegir; nunca se abre el primero automáticamente",async()=>{
  const f=mount({onOpenPhone:async()=>({matches:[match("one","Contacto A"),match("two",null)],total:2})});await f.open();f.button("Abrir chat").props.onClick();await f.flush();
  assert.equal(f.opened.length,0);const choices=f.all().filter(node=>node.type==="button"&&Object.hasOwn(node.props,"data-phone-choice"));assert.equal(choices.length,2);assert.match(text(choices[0]),/Contacto A/);assert.match(text(choices[1]),/\+573001234567/);
  choices[1].props.onClick();await f.flush();assert.deepEqual(f.opened,["two"]);assert.equal(f.popover(),undefined);f.unmount();
});

test("se muestran como máximo diez coincidencias y se indica cómo acotar la lista",async()=>{
  const f=mount({onOpenPhone:async()=>({matches:Array.from({length:12},(_,index)=>match(`chat-${index}`)),total:15})});await f.open();f.button("Abrir chat").props.onClick();await f.flush();
  assert.equal(f.all().filter(node=>node.type==="button"&&Object.hasOwn(node.props,"data-phone-choice")).length,10);assert.match(text(f.tree),/15 conversaciones/);assert.match(text(f.tree),/buscador de la bandeja/);assert.equal(f.opened.length,0);f.unmount();
});

test("sin coincidencias ofrece WhatsApp sin texto precargado ni navegación automática",async()=>{
  const f=mount();await f.open();f.button("Abrir chat").props.onClick();await f.flush();assert.match(text(f.tree),/No hay un chat disponible para este número/);
  const link=f.all().find(node=>node.type==="a");assert.equal(link.props.href,"https://wa.me/573001234567");assert.equal(link.props.target,"_blank");assert.equal(link.props.rel,"noopener noreferrer");assert.equal(text(link),"Abrir en WhatsApp");assert.equal(f.opened.length,0);assert.deepEqual(f.calls,[phone]);f.unmount();
});

test("Escape restaura el foco; clic externo, scroll y resize cierran e invalidan la consulta tardía",async()=>{
  for(const action of ["escape","outside","scroll","resize","viewport"]){
    const pending=deferred();let signal;const f=mount({onOpenPhone:(_phone,requestSignal)=>{signal=requestSignal;return pending.promise;}}),anchor=await f.open();f.button("Abrir chat").props.onClick();await f.flush();assert.equal(signal.aborted,false);
    if(action==="escape"){const event=await f.emit("document","keydown",{key:"Escape"});assert.equal(event.prevented,true);assert.equal(anchor.focuses,1);}
    if(action==="outside")await f.emit("document","pointerdown");
    if(action==="scroll")await f.emit("window","scroll");
    if(action==="resize")await f.emit("window","resize");
    if(action==="viewport")await f.emit("viewport","resize");
    assert.equal(f.popover(),undefined);assert.equal(signal.aborted,true);pending.resolve({matches:[match("late")],total:1});await f.flush();assert.equal(f.opened.length,0);f.unmount();
  }
});

test("desplazarse dentro de las opciones conserva el menú; salir con el foco lo cierra",async()=>{
  const f=mount();await f.open();await f.emit("window","scroll",{target:f.popupElement});assert.ok(f.popover());await f.emit("document","focusin");assert.equal(f.popover(),undefined);f.unmount();
});

test("cambio de conversación, mensaje, deshabilitación o desmontaje descarta promesas anteriores",async()=>{
  for(const change of ["context","text","disabled","unmount"]){
    const pending=deferred();let signal;const f=mount({onOpenPhone:(_phone,requestSignal)=>{signal=requestSignal;return pending.promise;}});await f.open();f.button("Abrir chat").props.onClick();await f.flush();
    if(change==="context")f.setProps({contextKey:"conversation-b:message-b"});if(change==="text")f.setProps({text:"Otro mensaje"});if(change==="disabled")f.setProps({disabled:true});if(change==="unmount")f.unmount();await f.flush();
    assert.equal(signal.aborted,true);pending.resolve({matches:[match("wrong-context")],total:1});await f.flush();assert.equal(f.opened.length,0);if(change!=="unmount")assert.equal(f.popover(),undefined);f.unmount();
  }
});

test("un error permite reintentar la consulta sin crear conversaciones",async()=>{
  let tries=0;const f=mount({onOpenPhone:async()=>{if(++tries===1)throw new Error("No se pudo consultar el número");return{matches:[match("retry-confirmed")],total:1};}});await f.open();f.button("Abrir chat").props.onClick();await f.flush();
  assert.ok(f.all().some(node=>node.props.role==="alert"&&/No se pudo consultar/.test(text(node))));f.button("Abrir chat").props.onClick();await f.flush();assert.equal(tries,2);assert.deepEqual(f.opened,["retry-confirmed"]);f.unmount();
});

test("sin callbacks se conserva texto plano; disabled impide acciones y React mantiene el contenido como texto",async()=>{
  const f=mount({onOpenPhone:undefined,onOpenConversation:undefined});assert.equal(text(f.tree),message);assert.equal(f.trigger(0),undefined);f.unmount();
  const disabled=mount({disabled:true});assert.equal(disabled.trigger(0).props.disabled,true);await disabled.open();assert.equal(disabled.popover(),undefined);assert.equal(disabled.calls.length,0);disabled.unmount();
  const html=mount({text:'<img src=x onerror="enviar()">\nhttps://finserpay.com/clientes'});assert.equal(text(html.tree),'<img src=x onerror="enviar()">\nhttps://finserpay.com/clientes');assert.equal(html.all().some(node=>node.type==="img"||node.props.dangerouslySetInnerHTML),false);html.unmount();
});
