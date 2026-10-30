import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx=(type,props)=>({type,props:props||{}});
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==="object"?[value,...nodes(value.props?.children)]:[];
const text=value=>Array.isArray(value)?value.map(text).join(""):value&&typeof value==="object"?text(value.props?.children):typeof value==="string"?value:"";
const template={key:"template-key",name:"atencion",language:"es",category:"UTILITY",revision:"revision-one",header:null,body:"Hola {{1}}, podemos ayudarte.",footer:null,buttons:[],parameters:[{key:"body:1",label:"Nombre",maxLength:100}],available:true,reason:null};
const catalogue={templates:[template],canSend:true,reason:null,conversationVersion:1,requiresBindingConfirmation:false};
const compile=file=>ts.transpileModule(readFileSync(new URL(file,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const shared={exports:{}};runInNewContext(compile("../lib/atencion-template-types.ts"),{module:shared,exports:shared.exports});

function mount({storage=new Map(),storageFails=false}={}) {
  let cursor=0,dirty=false,effects=[],tree,counter=0,refreshed=0,portals=0;
  const slots=[],requests=[],busyChanges=[];
  const props={detail:{conversation:{id:"10000000-0000-4000-8000-000000000001",name:"Contacto de prueba",phone:"+573001234567",version:1,channel:"whatsapp"},permissions:{manage:true}},actorKey:"analyst:2",disabled:false,onSent:async()=>{refreshed++},onBusyChange:value=>busyChanges.push(value)};
  const react={useState(initial){const n=cursor++;slots[n]??={value:typeof initial==="function"?initial():initial};return[slots[n].value,value=>{slots[n].value=typeof value==="function"?value(slots[n].value):value;dirty=true}];},useRef(initial){const n=cursor++;slots[n]??={current:initial};return slots[n];},useEffect(effect,deps){const n=cursor++;if(!slots[n]||deps.some((value,i)=>!Object.is(value,slots[n].deps[i])))effects.push(()=>{slots[n]?.cleanup?.();slots[n]={deps,cleanup:effect()}})}};
  const mod={exports:{}};
  runInNewContext(compile("../app/dashboard/atencion/attention-template-composer.tsx"),{module:mod,exports:mod.exports,document:{body:{}},
    crypto:{randomUUID:()=>`20000000-0000-4000-8000-${String(++counter).padStart(12,"0")}`},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>{if(storageFails)throw new Error("disabled");storage.set(key,value)},removeItem:key=>storage.delete(key)},
    fetch:(url,init)=>new Promise((resolve,reject)=>requests.push({url,init,resolve,reject})),
    require(name){if(name==="react")return react;if(name==="react-dom")return{createPortal:node=>{portals++;return node}};if(name==="react/jsx-runtime")return{jsx,jsxs:jsx};if(name==="next/image")return{default:"Image"};if(name==="lucide-react")return new Proxy({},{get:(_,key)=>String(key)});if(name==="@/app/_components/finser-ui")return{Button:"button",Input:"input",Select:"select"};if(name==="@/lib/atencion-template-types")return shared.exports;if(name.endsWith("finser-side-panel"))return{default:"Panel"};if(name.endsWith("finser-confirm-dialog"))return{default:"Confirm"};if(name.endsWith(".css"))return{default:new Proxy({},{get:(_,key)=>String(key)})};throw new Error(name)}
  });
  function render(){cursor=0;effects=[];dirty=false;tree=mod.exports.default(props);effects.forEach(run=>run())}
  async function flush(){for(let i=0;i<20;i++){await Promise.resolve();if(dirty)render()}}
  const find=(type,predicate=()=>true)=>nodes(tree).find(node=>node.type===type&&predicate(node.props,node));
  const button=name=>find("button",(_,node)=>text(node)===name);
  render();
  return {props,requests,storage,busyChanges,button,find,flush,get tree(){return tree},get refreshed(){return refreshed},get portals(){return portals},
    async click(name){const node=button(name);assert.ok(node,name);assert.ok(!node.props.disabled,`${name} disabled`);node.props.onClick();await flush()},
    async respond(body,index=requests.length-1,ok=true,status=200){requests[index].resolve({ok,status,json:async()=>body});await flush()},
    async reject(index=requests.length-1){requests[index].reject(new Error("Conexión interrumpida"));await flush()},
    async choose(){find("select").props.onChange({target:{value:template.key}});await flush();find("input",props=>props.maxLength===100).props.onChange({target:{value:"Camila"}});await flush();find("input",props=>props.type==="checkbox").props.onChange({target:{checked:true}});await flush()},
    async confirm(){const node=find("Confirm",props=>props.open);assert.ok(node);node.props.onConfirm();await flush()},
    async update(patch){Object.assign(props,patch);render();await flush()},
    unmount(){slots.forEach(slot=>slot?.cleanup?.())}
  };
}
async function ready(options){const h=mount(options);await h.click("Plantilla");await h.respond(catalogue);await h.choose();return h;}

test("catálogo y vista previa no envían; destinatario y confirmación explícitos preceden un único POST",async()=>{
  const h=await ready();assert.equal(h.requests.length,1);assert.ok(h.portals>0,"dialog is outside the text composer form");
  assert.ok(text(h.tree).includes("Hola Camila, podemos ayudarte."));await h.click("Revisar envío");assert.equal(h.requests.length,1);
  const confirm=h.find("Confirm",props=>props.open);assert.ok(confirm.props.description.includes("+573001234567"));await h.confirm();
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].init.method,"POST");const input=JSON.parse(h.requests[1].init.body);
  assert.equal(input.confirmed,true);assert.equal(input.parameters["body:1"],"Camila");assert.equal([...h.storage.values()][0],input.requestId);
  await h.respond({message:{deliveryStatus:"accepted"}});assert.equal(h.refreshed,1);assert.equal(h.storage.size,0);assert.equal(h.busyChanges.at(-1),false);h.unmount();
});

test("respuesta perdida conserva UUID; consulta y reapertura nunca repiten el POST",async()=>{
  const h=await ready();await h.click("Revisar envío");await h.confirm();await h.reject();assert.equal(h.storage.size,1);
  await h.click("Consultar estado");assert.match(h.requests.at(-1).url,/messages\?requestId=/);await h.respond({message:{deliveryStatus:"uncertain"}});
  assert.equal(h.requests.filter(item=>item.init?.method==="POST").length,1);assert.equal(h.button("Revisar envío").props.disabled,true);
  const saved=h.storage;h.unmount();const again=mount({storage:saved});await again.click("Plantilla");await again.respond(catalogue,0);
  assert.equal(again.requests.length,2);assert.match(again.requests[1].url,/messages\?requestId=/);
  await again.respond({message:{deliveryStatus:"read"}},1);assert.equal(saved.size,0);assert.equal(again.refreshed,1);assert.equal(again.requests.filter(item=>item.init?.method==="POST").length,0);again.unmount();
});

test("un intento ausente requiere cancelación durable antes de liberar otro envío",async()=>{
  const h=await ready();await h.click("Revisar envío");await h.confirm();await h.reject();await h.click("Consultar estado");await h.respond({message:null});
  assert.equal(h.storage.size,1);await h.click("Cancelar intento pendiente");assert.equal(h.requests.at(-1).init.method,"DELETE");await h.respond({cancelled:true});assert.equal(h.storage.size,0);h.unmount();
});

test("conversación modificada tras revisar exige una nueva revisión y no envía",async()=>{
  const h=await ready();await h.click("Revisar envío");await h.update({detail:{...h.props.detail,conversation:{...h.props.detail.conversation,version:2}}});await h.confirm();
  assert.equal(h.requests.length,1);assert.ok(text(h.tree).includes("La conversación cambió"));h.unmount();
});

test("acceso retirado por el servidor cierra el panel y refresca el alcance del chat",async()=>{
  const h=await ready();await h.click("Revisar envío");await h.confirm();
  await h.respond({error:"Acceso retirado"},undefined,false,403);
  assert.equal(h.refreshed,1);assert.equal(h.storage.size,1,"retain request ID for safe status recovery");
  assert.equal(h.find("Confirm",props=>props.open),undefined);
  assert.equal(h.requests.filter(item=>item.init?.method==="POST").length,1);h.unmount();
});

test("plantilla no disponible, permiso revocado y almacenamiento fallido nunca permiten POST",async()=>{
  const blocked=mount();await blocked.click("Plantilla");await blocked.respond({...catalogue,templates:[{...template,available:false,reason:"Usa el flujo financiero"}]});blocked.find("select").props.onChange({target:{value:template.key}});await blocked.flush();assert.equal(blocked.button("Revisar envío").props.disabled,true);assert.ok(text(blocked.tree).includes("Usa el flujo financiero"));blocked.unmount();
  const denied=await ready();await denied.update({detail:{...denied.props.detail,permissions:{manage:false}}});assert.equal(denied.tree,null);assert.equal(denied.requests.length,1);denied.unmount();
  const noStorage=await ready({storageFails:true});await noStorage.click("Revisar envío");await noStorage.confirm();assert.equal(noStorage.requests.length,1);assert.ok(text(noStorage.tree).includes("no permite guardar"));noStorage.unmount();
});

const financialCandidate={creditId:101,creditLabel:"Crédito QA-101",revision:"financial-review-one",eligible:true,reason:null,parameters:{"body:1":"Camila","body:2":"2 de noviembre de 2026","body:3":"$ 120.000"},installmentNumber:4,dueDate:"2026-11-02",checkedOn:"2026-10-31",pendingAmount:120000,coveredCredits:[{id:101,number:"QA-101"}]};
const financialTemplate={...template,key:"financial-key",name:"2dias",headerImageUrl:"/whatsapp/templates/2dias.png",body:"Hola {{1}}, tu cuota vence el {{2}} por {{3}}.",parameters:[{key:"body:1",label:"Nombre",maxLength:100},{key:"body:2",label:"Fecha",maxLength:100},{key:"body:3",label:"Valor",maxLength:100}],financial:{blockedReason:null,candidates:[financialCandidate,{...financialCandidate,creditId:102,creditLabel:"Crédito QA-102",eligible:false,revision:null,parameters:{},reason:"El crédito está pagado y no tiene cuotas pendientes."}]}};
const financialCatalogue={...catalogue,templates:[financialTemplate]};
async function chooseFinancial(h,payload=financialCatalogue,credit="101"){
  await h.click("Plantilla");await h.respond(payload);
  h.find("select",p=>p["aria-label"]==="Plantilla aprobada").props.onChange({target:{value:payload.templates[0].key}});await h.flush();
  if(credit){h.find("select",p=>p["aria-label"]==="Crédito para validar").props.onChange({target:{value:credit}});await h.flush();}
}
async function consent(h){h.find("input",p=>p.type==="checkbox").props.onChange({target:{checked:true}});await h.flush();}

test("plantilla financiera exige crédito y usa parámetros del servidor sin campos editables ni llaves sin resolver",async()=>{
  const h=mount();await chooseFinancial(h,financialCatalogue,"");
  assert.ok(text(h.tree).includes("Selecciona un crédito para generar el mensaje"));assert.ok(!text(h.tree).includes("{{1}}"));
  assert.equal(h.find("section",p=>p["aria-label"]==="Vista previa de la plantilla"),undefined);assert.equal(h.button("Revisar envío").props.disabled,true);
  h.find("select",p=>p["aria-label"]==="Crédito para validar").props.onChange({target:{value:"101"}});await h.flush();
  assert.equal(h.find("input",p=>Boolean(p.maxLength)),undefined,"financial parameters are never editable");
  assert.ok(text(h.tree).includes("Hola Camila, tu cuota vence el 2 de noviembre de 2026 por $ 120.000."));
  assert.equal(h.find("Image").props.src,"/whatsapp/templates/2dias.png");assert.equal(h.requests.length,1);h.unmount();
});

test("preflight financiero precede confirmación exacta y POST sólo contiene referencia financiera, nunca parámetros editados",async()=>{
  const h=mount();await chooseFinancial(h);await consent(h);await h.click("Revisar envío");
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].init?.method,undefined);assert.equal(h.find("Confirm",p=>p.open),undefined);
  await h.respond(financialCatalogue);const dialog=h.find("Confirm",p=>p.open);assert.ok(dialog);
  for(const expected of ["+573001234567","Crédito QA-101","cuota 4","2 de noviembre de 2026","31 de octubre de 2026","$ 120.000"])assert.ok(dialog.props.description.includes(expected),expected);
  await h.confirm();const intent=JSON.parse(h.requests.at(-1).init.body);assert.deepEqual(intent.parameters,{});assert.equal(intent.creditId,101);assert.equal(intent.financialRevision,"financial-review-one");assert.equal(intent.version,1);
  await h.respond({message:{deliveryStatus:"accepted"}});assert.equal(h.refreshed,1);assert.equal(h.storage.size,0);h.unmount();
});

test("crédito pagado o identidad ambigua muestran su motivo preciso y nunca generan preview enviable",async()=>{
  const paid=mount();await chooseFinancial(paid,financialCatalogue,"102");assert.ok(text(paid.tree).includes("El crédito está pagado y no tiene cuotas pendientes."));assert.equal(paid.button("Revisar envío").props.disabled,true);assert.equal(paid.find("section",p=>p["aria-label"]==="Vista previa de la plantilla"),undefined);assert.equal(paid.requests.length,1);paid.unmount();
  const ambiguous=mount();await chooseFinancial(ambiguous,{...financialCatalogue,templates:[{...financialTemplate,financial:{candidates:[],blockedReason:"El teléfono coincide con más de un titular. Vincula una ficha antes de continuar."}}]},"");assert.ok(text(ambiguous.tree).includes("más de un titular"));assert.equal(ambiguous.button("Revisar envío").props.disabled,true);assert.equal(ambiguous.find("select",p=>p["aria-label"]==="Crédito para validar"),undefined);ambiguous.unmount();
});

test("si cambia la cuota en preflight, se actualiza el preview y exige otra revisión explícita sin POST",async()=>{
  const changed={...financialCatalogue,templates:[{...financialTemplate,financial:{blockedReason:null,candidates:[{...financialCandidate,revision:"financial-review-two",parameters:{...financialCandidate.parameters,"body:3":"$ 80.000"},pendingAmount:80000}]}}]};
  const h=mount();await chooseFinancial(h);await consent(h);await h.click("Revisar envío");await h.respond(changed);
  assert.equal(h.find("Confirm",p=>p.open),undefined);assert.equal(h.find("input",p=>p.type==="checkbox").props.checked,false);assert.ok(text(h.tree).includes("$ 80.000"));assert.ok(text(h.tree).includes("cambiaron"));assert.equal(h.requests.filter(r=>r.init?.method==="POST").length,0);
  await consent(h);await h.click("Revisar envío");await h.respond(changed);await h.confirm();assert.equal(JSON.parse(h.requests.at(-1).init.body).financialRevision,"financial-review-two");h.unmount();
});

test("pago recibido durante revisión bloquea el envío con el motivo actualizado",async()=>{
  const h=mount();await chooseFinancial(h);await consent(h);await h.click("Revisar envío");
  await h.respond({...financialCatalogue,templates:[{...financialTemplate,financial:{blockedReason:null,candidates:[{...financialCandidate,eligible:false,revision:null,reason:"La cuota ya fue pagada.",parameters:{}}]}}]});
  assert.equal(h.find("Confirm",p=>p.open),undefined);assert.ok(text(h.tree).includes("La cuota ya fue pagada."));assert.equal(h.button("Revisar envío").props.disabled,true);assert.equal(h.requests.filter(r=>r.init?.method==="POST").length,0);h.unmount();
});

test("DATA muestra y confirma todos los créditos de la cohorte validada por el servidor",async()=>{
  const dataCatalogue={...financialCatalogue,templates:[{...financialTemplate,name:"data",headerImageUrl:null,financial:{blockedReason:null,candidates:[{...financialCandidate,coveredCredits:[{id:101,number:"QA-101"},{id:103,number:"QA-103"}]}]}}]};
  const h=mount();await chooseFinancial(h,dataCatalogue);assert.ok(text(h.tree).includes("Créditos incluidos en este aviso"));assert.ok(text(h.tree).includes("QA-103"));
  assert.ok(text(h.find("label",(_,node)=>text(node).includes("He verificado"))).includes("los créditos QA-101, QA-103"));
  await consent(h);await h.click("Revisar envío");await h.respond(dataCatalogue);assert.ok(h.find("Confirm",p=>p.open).props.description.includes("Créditos incluidos: QA-101, QA-103"));h.unmount();
});

test("cambio de destinatario tras preflight rechaza la confirmación aunque la versión no cambie",async()=>{
  const h=mount();await chooseFinancial(h);await consent(h);await h.click("Revisar envío");await h.respond(financialCatalogue);
  const original=h.find("Confirm",p=>p.open).props.description;
  await h.update({detail:{...h.props.detail,conversation:{...h.props.detail.conversation,phone:"+573009999999"}}});assert.equal(h.find("Confirm",p=>p.open).props.description,original);
  await h.confirm();assert.equal(h.requests.filter(r=>r.init?.method==="POST").length,0);assert.ok(text(h.tree).includes("La conversación cambió"));h.unmount();
});

test("catálogo financiero con versión distinta refresca el alcance y exige revisar de nuevo",async()=>{
  const h=mount();await chooseFinancial(h);await consent(h);await h.click("Revisar envío");await h.respond({...financialCatalogue,conversationVersion:2});
  assert.equal(h.refreshed,1);assert.equal(h.find("Confirm",p=>p.open),undefined);assert.equal(h.find("input",p=>p.type==="checkbox").props.checked,false);assert.equal(h.requests.filter(r=>r.init?.method==="POST").length,0);h.unmount();
});

test("envío financiero incierto mantiene UUID y bloquea seleccionar otro crédito sin reenvíos automáticos",async()=>{
  const h=mount();await chooseFinancial(h);await consent(h);await h.click("Revisar envío");await h.respond(financialCatalogue);await h.confirm();const intent=JSON.parse(h.requests.at(-1).init.body);await h.reject();
  assert.equal([...h.storage.values()][0],intent.requestId);assert.equal(h.find("select",p=>p["aria-label"]==="Crédito para validar").props.disabled,true);
  await h.click("Consultar estado");await h.respond({message:{deliveryStatus:"uncertain"}});assert.equal(h.requests.filter(r=>r.init?.method==="POST").length,1);assert.equal(h.storage.size,1);h.unmount();
});
