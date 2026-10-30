import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
const jsx=(type,props)=>({type,props:props||{}});
const nodes=v=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==="object"?[v,...nodes(v.props?.children)]:[];
const text=v=>Array.isArray(v)?v.map(text).join(""):v&&typeof v==="object"?text(v.props?.children):typeof v==="string"?v:"";
function mount(webm=false){
  let cursor=0,dirty=false,effects=[],tree,resolveCapture,stopped=0,fetchResolve;
  const slots=[],audio=[],emojis=[],devices=[],revoked=[],requests=[],timers=new Map();let tid=0;
  const react={
    useState(initial){const n=cursor++;slots[n]??={value:typeof initial==="function"?initial():initial};return[slots[n].value,value=>{slots[n].value=typeof value==="function"?value(slots[n].value):value;dirty=true}];},
    useRef(initial){const n=cursor++;slots[n]??={current:initial};return slots[n];},
    useEffect(effect,deps){const n=cursor++;if(!slots[n]||deps.some((v,i)=>!Object.is(v,slots[n].deps[i])))effects.push(()=>{slots[n]?.cleanup?.();slots[n]={deps,cleanup:effect()}})}
  };
  class Recorder{
    static isTypeSupported(type){return type.startsWith(webm?"audio/webm":"audio/ogg")}
    constructor(stream,options){this.state="inactive";this.mime=options.mimeType;devices.push(this)}
    start(){this.state="recording"}
    stop(){assert.equal(this.state,"recording","stop cannot run twice");this.state="inactive";queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(["synthetic audio"],{type:this.mime})});this.onstop?.()})}
  }
  const compiled=ts.transpileModule(readFileSync(new URL("../app/dashboard/atencion/attention-composer-tools.tsx",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const mod={exports:{}};
  runInNewContext(compiled,{
    module:mod,exports:mod.exports,Blob,File,FormData,AbortController,DOMException,MediaRecorder:Recorder,
    URL:{createObjectURL:()=>"blob:local-preview",revokeObjectURL:url=>revoked.push(url)},
    navigator:{mediaDevices:{getUserMedia:()=>new Promise(resolve=>{resolveCapture=resolve})}},
    document:{addEventListener(){},removeEventListener(){}},
    fetch:(url,init)=>{requests.push({url,init});return new Promise(resolve=>{fetchResolve=resolve})},
    setTimeout:fn=>{timers.set(++tid,fn);return tid},clearTimeout:id=>timers.delete(id),setInterval:fn=>{timers.set(++tid,fn);return tid},clearInterval:id=>timers.delete(id),
    require(name){if(name==="react")return react;if(name==="react/jsx-runtime")return{jsx,jsxs:jsx};if(name==="lucide-react")return new Proxy({},{get:(_,key)=>String(key)});if(name==="@/app/_components/finser-ui")return{Button:"button"};if(name.endsWith(".css"))return{default:new Proxy({},{get:(_,key)=>String(key)})};throw new Error(name)}
  });
  const props={conversationId:"chat-A",disabled:false,audioDisabled:false,onAudio:file=>audio.push(file),onEmoji:value=>emojis.push(value)};
  function render(){cursor=0;effects=[];dirty=false;tree=mod.exports.default(props);effects.forEach(run=>run())}
  async function flush(){for(let i=0;i<12;i++){await Promise.resolve();if(dirty)render()}}
  const button=name=>nodes(tree).find(n=>n.type==="button"&&(n.props["aria-label"]===name||text(n)===name));render();
  return{audio,emojis,devices,revoked,requests,button,flush,get stopped(){return stopped},
    async click(name){const b=button(name);assert.ok(b,name);assert.ok(!b.props.disabled,`${name} disabled`);b.props.onClick();await flush()},
    async capture(){resolveCapture({getTracks:()=>[{stop(){stopped++}}]});await flush()},
    async resolveConversion(){fetchResolve({ok:true,headers:new Headers({"content-type":"audio/ogg"}),blob:async()=>new Blob(["converted"],{type:"audio/ogg"})});await flush()},
    unmount(){slots.forEach(slot=>slot?.cleanup?.())},async update(patch){Object.assign(props,patch);render();await flush()}
  };
}
test("emojis edit the draft without sending; audio-specific disable allows emojis",async()=>{
  const h=mount();await h.update({audioDisabled:true});assert.equal(h.button("Grabar audio").props.disabled,true);await h.click("Elegir emoji");await h.click("Pulgar arriba");assert.deepEqual(h.emojis,["👍"]);assert.equal(h.requests.length,0);h.unmount();
});
test("explicit recording previews before attachment; double stop is harmless and never sends",async()=>{
  const h=mount();assert.equal(h.devices.length,0);await h.click("Grabar audio");await h.capture();const stop=h.button("Detener y escuchar");stop.props.onClick();stop.props.onClick();await h.flush();assert.equal(h.audio.length,0);assert.ok(h.stopped);await h.click("Usar audio");assert.equal(h.audio[0].type,"audio/ogg");assert.equal(h.requests.length,0);assert.ok(h.revoked.length);h.unmount();
});
test("late microphone permission after navigation releases tracks without recording",async()=>{
  const h=mount();await h.click("Grabar audio");h.unmount();await h.capture();assert.equal(h.devices.length,0);assert.equal(h.stopped,1);assert.equal(h.audio.length,0);
});
test("cancel and lost permission stop capture and ignore late audio",async()=>{
  const h=mount();await h.click("Grabar audio");await h.capture();await h.click("Cancelar");assert.equal(h.audio.length,0);assert.ok(h.stopped);assert.equal(h.button("Usar audio"),undefined);h.unmount();
  const lost=mount();await lost.click("Grabar audio");await lost.capture();await lost.update({disabled:true});assert.equal(lost.devices[0].state,"inactive");assert.ok(lost.stopped);assert.equal(lost.audio.length,0);lost.unmount();
});
test("WebM conversion is private and late result cannot attach to another chat",async()=>{
  const h=mount(true);await h.click("Grabar audio");await h.capture();await h.click("Detener y escuchar");await h.click("Usar audio");assert.equal(h.requests[0].url,"/api/atencion/chat-A/audio");assert.equal(h.audio.length,0);h.unmount();assert.equal(h.requests[0].init.signal.aborted,true);await h.resolveConversion();assert.equal(h.audio.length,0);
});
