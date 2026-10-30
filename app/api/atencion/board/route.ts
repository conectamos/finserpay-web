import { getAttentionAccess } from "@/lib/atencion-core";
import { parseAttentionBoardMutation, parseAttentionBoardSearch } from "@/lib/atencion-board-core";
import { configureAttentionBoard, getAttentionBoard } from "@/lib/atencion-board-storage";
import { assertAttentionOrigin, attentionHttpError, attentionJson, readAttentionJson } from "@/lib/atencion-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  try{return attentionJson(await getAttentionBoard(await getAttentionAccess(),parseAttentionBoardSearch(new URL(request.url).searchParams)));}
  catch(error){return attentionHttpError(error);}
}
export async function PATCH(request:Request){
  try{assertAttentionOrigin(request);const actor=await getAttentionAccess();return attentionJson(await configureAttentionBoard(actor,parseAttentionBoardMutation(await readAttentionJson(request))));}
  catch(error){return attentionHttpError(error);}
}
