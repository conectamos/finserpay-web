import {getAttentionAccess} from "@/lib/atencion-core";
import {attentionJson,attentionHttpError,assertAttentionOrigin} from "@/lib/atencion-http";
import {attentionStickerLibrary,readStickerUpload} from "@/lib/atencion-sticker-library";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(){try{const actor=await getAttentionAccess();return attentionJson(await(await attentionStickerLibrary()).list(actor));}catch(error){return attentionHttpError(error);}}
export async function POST(request:Request){try{assertAttentionOrigin(request);const actor=await getAttentionAccess(),input=await readStickerUpload(request);return attentionJson({sticker:await(await attentionStickerLibrary()).save(actor,input)});}catch(error){return attentionHttpError(error);}}
