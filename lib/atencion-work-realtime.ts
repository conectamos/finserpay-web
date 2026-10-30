import "server-only";
import { AttentionError } from "./atencion-core";
import type { AttentionRealtimeBroker } from "./atencion-realtime";

/** Invalidation only. Every heartbeat/event revalidates commercial access. */
export function createWorkRealtimeStream(options:{signal:AbortSignal;broker:AttentionRealtimeBroker;authorize:(ids:readonly string[])=>Promise<boolean>;heartbeatMs?:number;lifetimeMs?:number}){
  let dispose=()=>{};const encoder=new TextEncoder();
  return new ReadableStream<Uint8Array>({start(controller){
    let closed=false,running=false,ready=false,overflow=false,scheduled:ReturnType<typeof setTimeout>|undefined;
    const ids=new Set<string>();let unsubscribe=()=>{};
    const close=()=>{if(closed)return;closed=true;unsubscribe();clearInterval(heartbeat);clearTimeout(lifetime);if(scheduled)clearTimeout(scheduled);options.signal.removeEventListener("abort",close);try{controller.close();}catch{}};
    dispose=close;
    const send=(event:string,data:object)=>{if(closed)return;if(controller.desiredSize!==null&&controller.desiredSize<=0){close();return;}controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));};
    const schedule=()=>{if(!closed&&!running&&!scheduled)scheduled=setTimeout(()=>{scheduled=undefined;void flush();},100);};
    async function flush(){if(closed||running)return;running=true;const pending=[...ids];ids.clear();const wasReady=ready,force=overflow;ready=false;overflow=false;
      try{const relevant=await options.authorize(pending);if(closed)return;const connected=options.broker.connected();send("heartbeat",{connected});if(wasReady&&connected)send("ready",{});if(connected&&(relevant||wasReady||force))send("invalidate",{});}
      catch(error){if(error instanceof AttentionError&&[401,403].includes(error.status)){send("access_revoked",{});close();}else send("degraded",{});}
      finally{running=false;if(ids.size||ready)schedule();}}
    const heartbeat=setInterval(schedule,options.heartbeatMs??15000),lifetime=setTimeout(close,options.lifetimeMs??240000);
    options.signal.addEventListener("abort",close,{once:true});if(options.signal.aborted){close();return;}
    unsubscribe=options.broker.subscribe(event=>{if(event.kind==="connected")ready=true;else if(event.kind==="disconnected")send("degraded",{});else if(event.kind==="change"){if(ids.size<100)ids.add(event.change.conversationId);else overflow=true;}else return;schedule();});
    schedule();
  },cancel(){dispose();}},{highWaterMark:64*1024,size:value=>value.byteLength});
}
