import { cookies } from "next/headers";
import { getAttentionWorkAccess } from "./atencion-work-access";
import { assertAttentionOrigin, attentionHttpError, attentionJson, readAttentionJson } from "./atencion-http";
import { AttentionError } from "./atencion-core";
import { attentionPushConfig } from "./atencion-push-core";
import { attentionPushStore } from "./atencion-push-storage";

export function attentionPushHandlers(mode:"seller"|"attention"){
  return {
    GET:async(request:Request)=>{try{
      const actor=await getAttentionWorkAccess(mode),config=attentionPushConfig();
      const endpoint=new URL(request.url).searchParams.get("endpoint");
      if(endpoint&&endpoint.length>2048)throw new AttentionError("Dispositivo inválido.");
      const status=await(await attentionPushStore()).status(actor,endpoint);
      return attentionJson({...status,configured:!!config,publicKey:config?.publicKey||null});
    }catch(error){return attentionHttpError(error);}},
    POST:async(request:Request)=>{try{
      assertAttentionOrigin(request);const actor=await getAttentionWorkAccess(mode);
      if(!attentionPushConfig())throw new AttentionError("Falta configurar los avisos al celular. La campana de la plataforma sigue disponible.",503);
      const input=await readAttentionJson(request,{maxBytes:4096});
      if(Object.keys(input).some(key=>key!=="subscription"))throw new AttentionError("Datos del dispositivo inválidos.");
      const row=await(await attentionPushStore()).subscribe(actor,input.subscription);
      (await cookies()).set("finser-work-push-device",row.id,{httpOnly:true,sameSite:"strict",secure:process.env.NODE_ENV==="production",path:"/",maxAge:90*86400});
      return attentionJson({subscribed:true});
    }catch(error){return attentionHttpError(error);}},
    DELETE:async(request:Request)=>{try{
      assertAttentionOrigin(request);const actor=await getAttentionWorkAccess(mode),input=await readAttentionJson(request,{maxBytes:4096});
      if(Object.keys(input).some(key=>key!=="endpoint"))throw new AttentionError("Datos del dispositivo inválidos.");
      const result=await(await attentionPushStore()).unsubscribe(actor,input.endpoint);
      (await cookies()).delete("finser-work-push-device");return attentionJson(result);
    }catch(error){return attentionHttpError(error);}},
  };
}
