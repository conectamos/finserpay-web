import {getAttentionAccess,attentionUuid} from "@/lib/atencion-core";
import {attentionHttpError} from "@/lib/atencion-http";
import {attentionStickerLibrary} from "@/lib/atencion-sticker-library";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(_request:Request,context:{params:Promise<{id:string}>}){try{const actor=await getAttentionAccess(),id=attentionUuid((await context.params).id),file=await(await attentionStickerLibrary()).media(actor,id);return new Response(Buffer.from(file.bytes),{headers:{"Content-Type":"image/webp","Content-Length":String(file.bytes.length),"Content-Disposition":"inline; filename=sticker.webp","Cache-Control":"private, no-store, max-age=0","X-Content-Type-Options":"nosniff",Vary:"Cookie"}});}catch(error){return attentionHttpError(error);}}
