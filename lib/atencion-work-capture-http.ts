import "server-only";
import { AttentionError, attentionUuid } from "./atencion-core";
import { assertAttentionOrigin, attentionHttpError, attentionJson, readAttentionJson } from "./atencion-http";
import { readAttentionBody } from "./atencion-meta-http";
import { getAttentionWorkAccess } from "./atencion-work-access";
import { ATTENTION_WORK_CAPTURE_MAX_BYTES, attentionWorkCaptureStore, attentionWorkCaptureToken } from "./atencion-work-capture";

type WorkContext={params:Promise<{id:string}>};
type SessionContext={params:Promise<{id:string;sessionId:string}>};
const response=(body:unknown,status=200)=>{const r=attentionJson(body,status);r.headers.set("Vary","Cookie, Authorization");r.headers.set("Referrer-Policy","no-referrer");return r;};
function noQuery(request:Request){if(new URL(request.url).search)throw new AttentionError("No incluyas datos del enlace en la URL.");}
function token(request:Request){noQuery(request);const match=/^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization")||"");return attentionWorkCaptureToken(match?.[1]);}
const failure=(error:unknown)=>{const r=attentionHttpError(error);r.headers.set("Vary","Cookie, Authorization");r.headers.set("Referrer-Policy","no-referrer");return r;};
export function attentionWorkCaptureHandlers(mode:"seller"|"attention"){
  return {
    create:async(request:Request,context:WorkContext)=>{try{assertAttentionOrigin(request);noQuery(request);const actor=await getAttentionWorkAccess(mode);return response(await(await attentionWorkCaptureStore()).create(actor,(await context.params).id,await readAttentionJson(request,{maxBytes:2048})),201);}catch(error){return failure(error);}},
    status:async(request:Request,context:SessionContext)=>{try{noQuery(request);const actor=await getAttentionWorkAccess(mode),{id,sessionId}=await context.params;return response(await(await attentionWorkCaptureStore()).status(actor,id,sessionId));}catch(error){return failure(error);}},
    revoke:async(request:Request,context:SessionContext)=>{try{assertAttentionOrigin(request);noQuery(request);const actor=await getAttentionWorkAccess(mode),{id,sessionId}=await context.params;return response(await(await attentionWorkCaptureStore()).revoke(actor,id,sessionId));}catch(error){return failure(error);}},
  };
}
export const attentionWorkCaptureMobileHandlers={
  status:async(request:Request)=>{try{return response(await(await attentionWorkCaptureStore()).mobileStatus(token(request)));}catch(error){return failure(error);}},
  upload:async(request:Request)=>{try{
    assertAttentionOrigin(request);const bearer=token(request),store=await attentionWorkCaptureStore();
    // Reject an invalid/revoked account before reading photo bytes, then revalidate under locks on commit.
    const status=await store.mobileStatus(bearer);if(status.state!=="open")throw new AttentionError("El enlace de captura caducó o fue cancelado.",410);
    const contentType=request.headers.get("content-type")||"";
    if(!/^multipart\/form-data\s*;/i.test(contentType)||contentType.length>250)throw new AttentionError("Adjunta una foto.",415);
    const bytes=await readAttentionBody(request,ATTENTION_WORK_CAPTURE_MAX_BYTES+65536);
    let form:FormData;try{form=await new Response(Buffer.from(bytes),{headers:{"Content-Type":contentType}}).formData();}catch{throw new AttentionError("Formulario de captura inválido.");}
    for(const key of form.keys())if(!["requestId","file"].includes(key)||form.getAll(key).length!==1)throw new AttentionError("Formulario de captura inválido.");
    const file=form.get("file"),requestId=attentionUuid(form.get("requestId"));
    if(!file||typeof file==="string")throw new AttentionError("Adjunta una foto.");
    return response(await store.upload(bearer,{requestId,fileName:file.name,mimeType:file.type,content:new Uint8Array(await file.arrayBuffer())}));
  }catch(error){return failure(error);}},
};
