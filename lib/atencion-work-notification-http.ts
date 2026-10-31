import { getAttentionWorkAccess } from "./atencion-work-access";
import { attentionWorkNotificationStore } from "./atencion-work-notifications";
import { assertAttentionOrigin, attentionHttpError, attentionJson, readAttentionJson } from "./atencion-http";

export function attentionWorkNotificationHandlers(mode:"seller"|"attention") {
  return {
    GET:async()=>{try {
      const actor=await getAttentionWorkAccess(mode);
      return attentionJson(await(await attentionWorkNotificationStore()).list(actor));
    }catch(error){return attentionHttpError(error);}},
    PATCH:async(request:Request)=>{try {
      assertAttentionOrigin(request);
      const actor=await getAttentionWorkAccess(mode);
      return attentionJson(await(await attentionWorkNotificationStore()).acknowledge(actor,await readAttentionJson(request)));
    }catch(error){return attentionHttpError(error);}},
  };
}
