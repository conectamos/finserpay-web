import { getAttentionWorkAccess } from "./atencion-work-access";
import { attentionWorkStore, parseWorkKind } from "./atencion-work-storage";
import { assertAttentionOrigin, attentionHttpError, attentionJson, readAttentionJson } from "./atencion-http";
import { readAttentionBody } from "./atencion-meta-http";
import { AttentionError, attentionUuid } from "./atencion-core";

export function attentionWorkHandlers(mode:"seller"|"attention"){
  return {
    upload:async(request:Request,context:{params:Promise<{id:string}>})=>{try{assertAttentionOrigin(request);const a=await getAttentionWorkAccess(mode),contentType=request.headers.get("content-type")||"";
      if(!/^multipart\/form-data\s*;/i.test(contentType)||contentType.length>250)throw new AttentionError("Adjunta un archivo.",415);
      const bytes=await readAttentionBody(request,16*1024*1024+65536),form=await new Response(Buffer.from(bytes),{headers:{"Content-Type":contentType}}).formData();
      for(const key of form.keys())if(!["requestId","version","file"].includes(key)||form.getAll(key).length!==1)throw new AttentionError("Formulario inválido.");
      const file=form.get("file"),version=Number(form.get("version"));if(!file||typeof file==="string"||!Number.isSafeInteger(version)||version<1)throw new AttentionError("Archivo o versión inválidos.");
      return attentionJson(await (await attentionWorkStore()).attach(a,(await context.params).id,{requestId:attentionUuid(form.get("requestId")),version,fileName:file.name,mimeType:file.type,content:new Uint8Array(await file.arrayBuffer())}));
    }catch(error){return attentionHttpError(error);}},
    media:async(_request:Request,context:{params:Promise<{id:string;fileId:string}>})=>{try{const a=await getAttentionWorkAccess(mode),p=await context.params,file=await(await attentionWorkStore()).media(a,p.id,p.fileId);return new Response(Buffer.from(file.content),{headers:{"Content-Type":file.mimeType,"Content-Disposition":file.mimeType==="application/pdf"?'attachment; filename="soporte.pdf"':'inline',"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",Vary:"Cookie"}});}catch(error){return attentionHttpError(error);}},
    list:async(request:Request)=>{try{const a=await getAttentionWorkAccess(mode),p=new URL(request.url).searchParams;
      return attentionJson(await (await attentionWorkStore()).list(a,parseWorkKind(p.get("kind")||"enrollment"),Number(p.get("page")||1)));
    }catch(error){return attentionHttpError(error);}},
    create:async(request:Request)=>{try{assertAttentionOrigin(request);const a=await getAttentionWorkAccess(mode);
      return attentionJson(await (await attentionWorkStore()).create(a,await readAttentionJson(request)),201);
    }catch(error){return attentionHttpError(error);}},
    detail:async(_request:Request,context:{params:Promise<{id:string}>})=>{try{const a=await getAttentionWorkAccess(mode);return attentionJson(await (await attentionWorkStore()).detail(a,(await context.params).id));}catch(error){return attentionHttpError(error);}},
    mutate:async(request:Request,context:{params:Promise<{id:string}>})=>{try{assertAttentionOrigin(request);const a=await getAttentionWorkAccess(mode);return attentionJson(await (await attentionWorkStore()).mutate(a,(await context.params).id,await readAttentionJson(request)));}catch(error){return attentionHttpError(error);}},
  };
}
