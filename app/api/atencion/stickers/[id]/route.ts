import {getAttentionAccess,attentionUuid} from "@/lib/atencion-core";
import {attentionJson,attentionHttpError,assertAttentionOrigin,readAttentionJson} from "@/lib/atencion-http";
import {attentionStickerLibrary} from "@/lib/atencion-sticker-library";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){try{assertAttentionOrigin(request);const actor=await getAttentionAccess(),id=attentionUuid((await context.params).id),input=await readAttentionJson(request);return attentionJson({sticker:await(await attentionStickerLibrary()).update(actor,id,input)});}catch(error){return attentionHttpError(error);}}
