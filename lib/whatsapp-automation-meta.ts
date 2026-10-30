import "server-only";
import { createHash } from "node:crypto";
import type { AttentionDatabase } from "./atencion-storage";
import { validateMetaAttentionMedia } from "./atencion-meta";
import { isMetaAutomationConfigured, metaAutomationHeaderUrl, META_AUTOMATION_SCOPE, META_AUTOMATION_TEMPLATES, type MetaAutomationEnv } from "./whatsapp-automation-meta-config";
import { AutomationError, createWhatsAppAutomationMetaStore, type AutomationInput, type AutomationRow } from "./whatsapp-automation-meta-storage";
export { isMetaAutomationConfigured, isWhatsAppAutomationMetaConfigured } from "./whatsapp-automation-meta-config";
export type { MetaAutomationTemplate } from "./whatsapp-automation-meta-config";

export type MetaAutomationResult = { status: "accepted" | "failed" | "unknown"; code: string; providerMessageId?: string; outboxId?: string; httpStatus?: number };
export type MetaAutomationOptions = {
  env?: MetaAutomationEnv; fetcher?: typeof fetch; database?: AttentionDatabase; now?: () => number;
  timeoutMs?: number; deadlineAt?: number; beforeSend?: () => Promise<void>;
  withSendGuard?: <T>(send: () => Promise<T>) => Promise<T>;
};
type Dict = Record<string, unknown>;
type TemplateMetadata = { id: string; name: string; language: string; body: string; footer: string; buttons: string[]; image: boolean };
const dict = (value: unknown): Dict => value && typeof value === "object" && !Array.isArray(value) ? value as Dict : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown) => typeof value === "string" ? value : "";
const safeId = (value: unknown) => typeof value === "string" && /^\d{5,30}$/.test(value);
const cache = new Map<string, { expires: number; value: TemplateMetadata }>();
const mediaCache = new Map<string, { expires: number; id: string; mime: string }>();

function result(row: AutomationRow): MetaAutomationResult {
  return { status: ["accepted","sent","delivered","read"].includes(row.status) ? "accepted" : row.status === "failed" ? "failed" : "unknown",
    code: row.errorCode || (row.wamid ? "META_ACCEPTED" : "META_CONFIRMATION_PENDING"), ...(row.wamid ? {providerMessageId:row.wamid} : {}), outboxId:row.id };
}
function metadata(value: unknown, input: AutomationInput): TemplateMetadata {
  const rule = META_AUTOMATION_TEMPLATES[input.template];
  const rows = list(dict(value).data).map(dict).filter(row => row.name === input.template && row.language === rule.language);
  if (rows.length !== 1 || rows[0].status !== "APPROVED" || rows[0].parameter_format !== "POSITIONAL" || !safeId(rows[0].id)) throw new AutomationError("TEMPLATE_NOT_APPROVED");
  const components = list(rows[0].components).map(dict);
  const bodies = components.filter(c => c.type === "BODY"), headers = components.filter(c => c.type === "HEADER");
  if (bodies.length !== 1 || (rule.imageEnv ? headers.length !== 1 || headers[0].format !== "IMAGE" : headers.length !== 0)) throw new AutomationError("TEMPLATE_SHAPE_CHANGED");
  const body = str(bodies[0].text), parameters = [...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
  if (!body || body.length > 10000 || new Set(parameters).size !== rule.parameters || parameters.some(n => n < 1 || n > rule.parameters)
    || /\{\{|\}\}/.test(body.replace(/\{\{\d+\}\}/g, ""))) throw new AutomationError("TEMPLATE_SHAPE_CHANGED");
  const footer = components.filter(c => c.type === "FOOTER").map(c => str(c.text)).join("\n");
  const buttons = components.filter(c => c.type === "BUTTONS").flatMap(c => list(c.buttons).map(dict)).map(b => [str(b.text),str(b.url)].filter(Boolean).join(": "));
  if ([footer,...buttons].some(value => value.includes("{{") || value.length > 2000)
    || components.some(c => !["BODY","HEADER","FOOTER","BUTTONS"].includes(str(c.type)))) throw new AutomationError("TEMPLATE_UNSUPPORTED_COMPONENTS");
  return {id:str(rows[0].id),name:input.template,language:rule.language,body,footer,buttons,image:Boolean(rule.imageEnv)};
}

export function createWhatsAppAutomationMetaSender(options: MetaAutomationOptions & {database: AttentionDatabase}) {
  const env = options.env ?? process.env, fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
  const store = createWhatsAppAutomationMetaStore(options.database,{now:()=>new Date(now())});
  return async function send(input: AutomationInput & {beforeSend?:()=>Promise<void>}): Promise<MetaAutomationResult> {
    let row: AutomationRow | undefined, lease = "", attempted = false;
    const deadline = Math.min(options.deadlineAt ?? Infinity, now()+Math.max(1000,Math.min(options.timeoutMs??12000,20000)));
    const check = () => {
      if (!isMetaAutomationConfigured(env)) throw new AutomationError("META_AUTOMATION_DISABLED");
      if (now() >= deadline) throw new AutomationError("AUTOMATION_DEADLINE");
    };
    async function request(url: URL, init: RequestInit, max = 1024*1024) {
      check(); const controller = new AbortController();
      const timer = setTimeout(()=>controller.abort(),Math.max(1,deadline-now()));
      try {
        const response = await fetcher(url,{...init,signal:controller.signal,cache:"no-store",redirect:"error"});
        if (Number(response.headers.get("content-length") || 0)>max) throw new AutomationError("META_RESPONSE_TOO_LARGE");
        const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length=0;
        if (!reader) throw new AutomationError("META_EMPTY_RESPONSE");
        try { for (;;) { const next=await reader.read(); if(next.done)break; length+=next.value.length; if(length>max)throw new AutomationError("META_RESPONSE_TOO_LARGE"); chunks.push(next.value); } }
        finally { reader.releaseLock(); }
        return {response,bytes:Buffer.concat(chunks)};
      } finally { clearTimeout(timer); controller.abort(); }
    }
    async function graph(path: string, query: Record<string,string> = {}, body?: Dict | FormData) {
      const url = new URL(`https://graph.facebook.com/v25.0/${path}`); Object.entries(query).forEach(([k,v])=>url.searchParams.set(k,v));
      const headers: Record<string,string> = {Authorization:`Bearer ${env.WHATSAPP_ATTENTION_ACCESS_TOKEN}`};
      if(body && !(body instanceof FormData))headers["Content-Type"]="application/json";
      const read = await request(url,{method:body?"POST":"GET",headers,...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
      let parsed: Dict; try { parsed=dict(JSON.parse(read.bytes.toString("utf8"))); } catch { throw new AutomationError("META_INVALID_RESPONSE"); }
      if(!read.response.ok || parsed.error) {
        // Explicit Graph rejection is definitive; server failures remain uncertain after POST.
        const code=Number(dict(parsed.error).code);
        const error=new AutomationError(read.response.status>=400 && read.response.status<500 && code>0 ? `META_REJECTED_${code}` : "META_PROVIDER_FAILURE");
        throw error;
      }
      return parsed;
    }
    try {
      check(); const rule=META_AUTOMATION_TEMPLATES[input.template]; if(!rule)throw new AutomationError("INVALID_AUTOMATION_INPUT");
      const image = rule.imageEnv ? metaAutomationHeaderUrl(input.headerImageUrl || env[rule.imageEnv] || "",input.template) : undefined;
      if(rule.imageEnv && !image)throw new AutomationError("INVALID_TEMPLATE_IMAGE");
      if(!rule.imageEnv && input.headerImageUrl)throw new AutomationError("INVALID_TEMPLATE_IMAGE");
      const normalized={...input,phone:input.phone.replace(/^\+/,""),headerImageUrl:image || undefined};
      const reserved=await store.reserve(normalized); row=reserved.row;
      if(!reserved.claimed)return result(row); lease=row.leaseToken!;
      const credentialKey=createHash("sha256").update(String(env.WHATSAPP_ATTENTION_ACCESS_TOKEN)).digest("hex");
      const templateKey=`${credentialKey}:${input.template}`;
      let template=cache.get(templateKey);
      if(!template || template.expires<=now()) {
        const phone=await graph(META_AUTOMATION_SCOPE.phoneNumberId,{fields:"id,display_phone_number"});
        const matches=(item:Dict)=>item.id===META_AUTOMATION_SCOPE.phoneNumberId && str(item.display_phone_number).replace(/[+\s()-]/g,"")==="573124085562";
        if(!matches(phone))throw new AutomationError("META_SCOPE_MISMATCH");
        const numbers=await graph(`${META_AUTOMATION_SCOPE.wabaId}/phone_numbers`,{fields:"id,display_phone_number",limit:"100"});
        if(!list(numbers.data).map(dict).some(matches))throw new AutomationError("META_SCOPE_MISMATCH");
        const value=metadata(await graph(`${META_AUTOMATION_SCOPE.wabaId}/message_templates`,{name:input.template,fields:"id,name,status,language,parameter_format,components",limit:"100"}),normalized);
        if(cache.size>=28)cache.clear(); template={value,expires:now()+60000};cache.set(templateKey,template);
      }
      const content=template.value;
      const rendered=[content.body.replace(/\{\{(\d+)\}\}/g,(_,n)=>normalized.body[Number(n)-1]),content.footer,...content.buttons].filter(Boolean).join("\n");
      let media: {id:string;mime:string}|undefined;
      if(image) {
        const key=`${credentialKey}:${image}`,cached=mediaCache.get(key);
        if(cached && cached.expires>now())media=cached;
        else {
          const downloaded=await request(new URL(image),{method:"GET"},5*1024*1024);
          if(!downloaded.response.ok)throw new AutomationError("TEMPLATE_IMAGE_UNAVAILABLE");
          const mime=downloaded.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "";
          validateMetaAttentionMedia({bytes:downloaded.bytes,mimeType:mime,kind:"image"});
          const form=new FormData();form.set("messaging_product","whatsapp");form.set("type",mime);
          form.set("file",new Blob([new Uint8Array(downloaded.bytes)],{type:mime}),mime==="image/png"?"plantilla.png":"plantilla.jpg");
          const upload=await graph(`${META_AUTOMATION_SCOPE.phoneNumberId}/media`,{},form);
          if(!safeId(upload.id))throw new AutomationError("INVALID_MEDIA_RECEIPT");
          media={id:str(upload.id),mime};if(mediaCache.size>=12)mediaCache.clear();mediaCache.set(key,{...media,expires:now()+3600000});
        }
      }
      row=await store.prepare(row.id,lease,{text:rendered,metadata:content,...(media?{mediaId:media.id,mimeType:media.mime}:{})});
      await (input.beforeSend ?? options.beforeSend)?.();check();
      row=await store.start(row.id,lease);
      const components: Dict[]=[];
      if(media)components.push({type:"header",parameters:[{type:"image",image:{id:media.id}}]});
      if(normalized.body.length)components.push({type:"body",parameters:normalized.body.map(text=>({type:"text",text}))});
      const networkOnly=async()=>{
        check();if(attempted)throw new AutomationError("SEND_ALREADY_STARTED");attempted=true;
        return graph(`${META_AUTOMATION_SCOPE.phoneNumberId}/messages`,{},{messaging_product:"whatsapp",recipient_type:"individual",to:normalized.phone,
          type:"template",template:{name:input.template,language:{code:rule.language},...(components.length?{components}:{})},biz_opaque_callback_data:row!.id});
      };
      const ack=options.withSendGuard ? await options.withSendGuard(networkOnly) : await networkOnly();
      if(!attempted)throw new AutomationError("SEND_GUARD_NOT_CALLED");
      const message=dict(list(dict(ack).messages)[0]),contact=dict(list(dict(ack).contacts)[0]);
      if(dict(ack).messaging_product!=="whatsapp" || !/^wamid\.[A-Za-z0-9_+/=.-]{1,500}$/.test(str(message.id))
        || contact.wa_id!==normalized.phone || str(contact.input).replace(/^\+/,"")!==normalized.phone)throw new AutomationError("INVALID_SEND_RECEIPT");
      row=await store.accept(row.id,str(message.id));return result(row);
    } catch(error) {
      const code=error instanceof AutomationError ? error.code : "AUTOMATION_FAILED";
      const uncertain=attempted && !/^META_REJECTED_\d+$/.test(code);
      if(row && lease) {
        try { return result(await store.fail(row.id,lease,uncertain,code)); }
        catch { return {status:attempted?"unknown":"failed",code:attempted?"META_CONFIRMATION_PENDING":"AUTOMATION_STORAGE_FAILED",outboxId:row.id}; }
      }
      return {status:"failed",code};
    }
  };
}

export async function sendWhatsAppAutomationTemplate(input: AutomationInput & {beforeSend?:()=>Promise<void>}, options: MetaAutomationOptions = {}): Promise<MetaAutomationResult> {
  if(!isMetaAutomationConfigured(options.env ?? process.env))return {status:"failed",code:"META_AUTOMATION_DISABLED"};
  const database=options.database ?? (await import("./prisma")).default;
  return createWhatsAppAutomationMetaSender({...options,database})(input);
}
