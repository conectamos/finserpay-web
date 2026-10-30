import { getAttentionAccess } from "@/lib/atencion-core";
import { parseAttentionBoardCards } from "@/lib/atencion-board-core";
import { getAttentionBoardCards } from "@/lib/atencion-board-storage";
import { attentionHttpError, attentionJson } from "@/lib/atencion-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  try{return attentionJson(await getAttentionBoardCards(await getAttentionAccess(),parseAttentionBoardCards(new URL(request.url).searchParams)));}
  catch(error){return attentionHttpError(error);}
}
