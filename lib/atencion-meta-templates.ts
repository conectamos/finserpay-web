import { createHash } from "node:crypto";
import { AttentionError, attentionUuid } from "./atencion-core";
import type { AttentionTemplate, AttentionTemplateIntent } from "./atencion-template-types";
import { renderAttentionTemplatePreview } from "./atencion-template-types";

// Primary sending contract: Meta's WhatsApp collection and button parameter reference:
// https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive
// https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/button_parameter_object/

type Dict = Record<string, unknown>;
export type MetaManualTemplate = AttentionTemplate & { providerId: string; format: "POSITIONAL" | "NAMED" };
export type MetaTemplateSnapshot = { definition: MetaManualTemplate; parameters: Record<string, string> };
const dict = (v: unknown): Dict => v && typeof v === "object" && !Array.isArray(v) ? v as Dict : {};
const text = (v: unknown, max = 4096) => typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) ? v : "";
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const restricted = new Set(["bienvenida","1_dia_falta","hoyvence","data","2dias","cuotavencida","bloqueo","liquidacion_aliado_pdf","liquidacion_aliado","vencido","fechap"]);
const restrictedName = (name: string) => restricted.has(name) || name.startsWith("liquidacion_aliado");
const tokens = (value: string) => [...new Set([...value.matchAll(/\{\{([a-z_]+|[1-9]\d*)\}\}/g)].map(match => match[1]))];
function tokenShape(value: string, format: string) {
  const values = tokens(value);
  return !/[{}]/.test(value.replace(/\{\{([a-z_]+|[1-9]\d*)\}\}/g,"")) && values.length <= 20
    && (format === "NAMED" ? values.every(v => /^[a-z_]+$/.test(v)) : values.every((_,i) => values.includes(String(i+1))));
}
function validUrl(value: string) {
  try { const url = new URL(value.replace("{{1}}","sample")),index=value.indexOf("{{1}}");
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      && (index<0 || value.endsWith("{{1}}") && index===value.lastIndexOf("{{1}}") && new URL(value.slice(0,index)).origin===url.origin); }
  catch { return false; }
}

/** Only public, approved definitions are exposed. Unsupported structure stays visible but disabled. */
export function readMetaManualTemplate(raw: unknown): MetaManualTemplate | null {
  const row = dict(raw), name = text(row.name,512), language = text(row.language,30), providerId = text(row.id,30);
  if (row.status !== "APPROVED" || !/^[a-z0-9_]{1,512}$/.test(name) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language) || !/^\d{5,30}$/.test(providerId)) return null;
  const format = row.parameter_format === "NAMED" ? "NAMED" : "POSITIONAL";
  const components = Array.isArray(row.components) ? row.components.map(dict) : [];
  const bodies=components.filter(c=>c.type==="BODY"), headers=components.filter(c=>c.type==="HEADER"), footers=components.filter(c=>c.type==="FOOTER"), groups=components.filter(c=>c.type==="BUTTONS");
  const body=text(bodies[0]?.text), header=headers.length ? text(headers[0].text,60) : null, footer=footers.length ? text(footers[0].text,60) : null;
  const buttons=(Array.isArray(groups[0]?.buttons)?groups[0].buttons:[]).map(value=>{const b=dict(value);return {type:text(b.type,40),text:text(b.text,25),...(b.type==="URL"?{url:text(b.url,2000)}:{})};});
  let reason: string | null = null;
  if (restrictedName(name)) reason="Esta plantilla pertenece a una gestión financiera y requiere sus controles de elegibilidad.";
  else if (row.category === "AUTHENTICATION") reason="Las plantillas de autenticación se envían únicamente desde su proceso de verificación.";
  else if (!["UTILITY","MARKETING"].includes(String(row.category))) reason="La categoría de esta plantilla no está habilitada para envío manual.";
  else if (format === "NAMED") reason="Las variables con nombre todavía no están habilitadas para envío manual.";
  else if (row.parameter_format && row.parameter_format !== "POSITIONAL") reason="El formato de variables de esta plantilla no está habilitado.";
  else if (bodies.length!==1 || !body || headers.length>1 || footers.length>1 || groups.length>1 || groups.some(c=>!Array.isArray(c.buttons))
    || components.some(c=>!["BODY","HEADER","FOOTER","BUTTONS"].includes(String(c.type)))) reason="La estructura de esta plantilla todavía no está habilitada.";
  else if (headers.some(c=>c.format!=="TEXT")) reason="Esta plantilla requiere un encabezado multimedia; el envío manual de ese formato aún no está disponible.";
  else if (headers.length && !header) reason="El encabezado de esta plantilla no tiene un texto válido.";
  else if (![body,header||""].every(value=>tokenShape(value,format)) || (footer && /[{}]/.test(footer))) reason="Las variables de esta plantilla no tienen un formato compatible.";
  else if (buttons.length>3 || buttons.some(b=>!b.text || !["URL","QUICK_REPLY"].includes(b.type) || (b.type==="URL" && (!b.url || !validUrl(b.url) || !tokenShape(b.url,"POSITIONAL") || tokens(b.url).length>1)))) reason="Esta plantilla tiene botones que todavía no están habilitados.";
  const parameters = ["header","body"].flatMap(component => tokens(component==="header"?header||"":body).map(token=>({key:`${component}:${token}`,label:`${component==="header"?"Encabezado":"Mensaje"} · ${token}`,maxLength:component==="header"?60:1024})))
    .concat(buttons.flatMap((button,index)=>button.type==="URL"&&button.url?.includes("{{1}}")?[{key:`button:${index}`,label:`Enlace · ${button.text}`,maxLength:128}]:[]));
  const definition: Omit<MetaManualTemplate,"key"|"revision"|"available"|"reason">={providerId,name,language,category:text(row.category,40),format,header,body,footer,buttons,parameters};
  return {...definition,key:hash([name,language]),revision:hash(definition),available:reason===null,reason};
}
export function publicMetaTemplate(value: MetaManualTemplate): AttentionTemplate {
  const {providerId:_providerId,format:_format,...publicValue}=value;void _providerId;void _format;return publicValue;
}
export function parseAttentionTemplateIntent(raw: Record<string, unknown>): AttentionTemplateIntent {
  if (Object.keys(raw).some(key=>!["requestId","version","templateKey","revision","parameters","confirmed"].includes(key)) || raw.confirmed!==true
    || !Number.isSafeInteger(raw.version) || Number(raw.version)<1 || !/^[a-f0-9]{64}$/.test(String(raw.templateKey)) || !/^[a-f0-9]{64}$/.test(String(raw.revision))) throw new AttentionError("Revisa y confirma la plantilla antes de enviarla.");
  const values=dict(raw.parameters), keys=Object.keys(values).sort();
  if (!raw.parameters || Array.isArray(raw.parameters) || keys.length>45 || keys.some(key=>!/^(?:body|header):(?:[1-9]\d*|[a-z_]+)$|^button:\d$/.test(key)
    || typeof values[key]!=="string" || !values[key] || String(values[key]).length>1024 || /[\r\n\t\u0000-\u001f\u007f]/.test(String(values[key])))) throw new AttentionError("Completa las variables de la plantilla con texto válido.");
  return {requestId:attentionUuid(raw.requestId),version:Number(raw.version),templateKey:String(raw.templateKey),revision:String(raw.revision),parameters:Object.fromEntries(keys.map(key=>[key,values[key] as string])),confirmed:true};
}
export function templateIntentFingerprint(conversationId: string, input: Pick<AttentionTemplateIntent,"version"|"templateKey"|"revision"|"parameters">) {
  return hash({conversationId,version:input.version,templateKey:input.templateKey,revision:input.revision,parameters:Object.fromEntries(Object.entries(input.parameters).sort(([a],[b])=>a.localeCompare(b)))});
}
export function compileMetaTemplate(snapshot: MetaTemplateSnapshot) {
  const {definition:d,parameters}=snapshot;
  if (!d.available || d.reason || restrictedName(d.name)) throw new AttentionError(d.reason || "Esta plantilla no está habilitada para envío manual.",409);
  const expected=d.parameters.map(p=>p.key).sort();
  if (JSON.stringify(Object.keys(parameters).sort())!==JSON.stringify(expected)) throw new AttentionError("Completa exactamente las variables solicitadas por la plantilla.");
  for (const p of d.parameters) {
    const value=parameters[p.key];
    if (typeof value!=="string" || !value.trim() || value.length>p.maxLength || /[\r\n\t\u0000-\u001f\u007f{}]/.test(value)
      || p.key.startsWith("button:") && !/^[A-Za-z0-9._~-]{1,128}$/.test(value)) throw new AttentionError(`El valor de ${p.label} no es válido.`);
  }
  const render=(value:string,component:string)=>value.replace(/\{\{([a-z_]+|[1-9]\d*)\}\}/g,(_,token)=>parameters[`${component}:${token}`]);
  const components: Dict[]=[];
  for(const component of ["header","body"] as const){const value=d[component]||"",names=tokens(value).sort((a,b)=>Number(a)-Number(b));
    if(names.length)components.push({type:component,parameters:names.map(name=>({type:"text",text:parameters[`${component}:${name}`],...(d.format==="NAMED"?{parameter_name:name}:{})}))});}
  for(const [index,button] of d.buttons.entries()){
    if(button.type==="QUICK_REPLY")components.push({type:"button",sub_type:"quick_reply",index:String(index),parameters:[{type:"payload",payload:`attention:${d.key.slice(0,24)}:${index}`}]});
    else if(button.url?.includes("{{1}}"))components.push({type:"button",sub_type:"url",index:String(index),parameters:[{type:"text",text:parameters[`button:${index}`]}]});
  }
  const renderedText=renderAttentionTemplatePreview(d,parameters);
  if(renderedText.length>16000 || render(d.header||"","header").length>60 || render(d.body,"body").length>4096)throw new AttentionError("La plantilla completa excede el tamaño permitido.");
  return {text:renderedText,template:{name:d.name,language:{code:d.language},...(components.length?{components}:{})}};
}
