import { getAttentionAccess } from "@/lib/atencion-core";
import { parseAttentionBoardMove } from "@/lib/atencion-board-core";
import { getAttentionBoardPlacement, moveAttentionBoardConversation } from "@/lib/atencion-board-storage";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionUuid, readAttentionJson } from "@/lib/atencion-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(_request:Request,context:{params:Promise<{id:string}>}){
  try{const actor=await getAttentionAccess(),id=attentionUuid((await context.params).id);
    return attentionJson(await getAttentionBoardPlacement(actor,id));}
  catch(error){return attentionHttpError(error);}
}
export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{assertAttentionOrigin(request);const actor=await getAttentionAccess(),id=attentionUuid((await context.params).id);
    return attentionJson(await moveAttentionBoardConversation(actor,id,parseAttentionBoardMove(await readAttentionJson(request))));}
  catch(error){return attentionHttpError(error);}
}
