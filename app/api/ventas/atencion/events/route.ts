import {getAttentionWorkAccess} from "@/lib/atencion-work-access";
import {attentionWorkStore} from "@/lib/atencion-work-storage";
import {getAttentionRealtimeBroker} from "@/lib/atencion-realtime";
import {createWorkRealtimeStream} from "@/lib/atencion-work-realtime";
import {attentionHttpError} from "@/lib/atencion-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(request:Request){try{const actor=await getAttentionWorkAccess("seller"),store=await attentionWorkStore();await store.authorizeEvents(actor,[]);
  return new Response(createWorkRealtimeStream({signal:request.signal,broker:getAttentionRealtimeBroker(),authorize:ids=>store.authorizeEvents(actor,ids)}),{headers:{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"private, no-store, no-cache, no-transform","X-Accel-Buffering":"no","X-Content-Type-Options":"nosniff",Vary:"Cookie"}});
}catch(error){return attentionHttpError(error);}}
