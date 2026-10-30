import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {createJiti} from "jiti";
const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createWorkRealtimeStream}=await jiti.import("../lib/atencion-work-realtime.ts");
const {AttentionError}=await jiti.import("../lib/atencion-core.ts");
test("eventos comerciales solo invalidan después de autorización y no transportan datos del caso",async()=>{
  let listener,disposed=false;const controller=new AbortController(),seen=[];
  const broker={connected:()=>true,subscribe:fn=>{listener=fn;return()=>{disposed=true;}},close(){}};
  const stream=createWorkRealtimeStream({signal:controller.signal,broker,authorize:async ids=>{seen.push(ids);return ids.includes("caso-autorizado");},lifetimeMs:2000,heartbeatMs:1000}),reader=stream.getReader(),decode=new TextDecoder();
  assert.match(decode.decode((await reader.read()).value),/heartbeat/);
  listener({kind:"change",change:{conversationId:"caso-ajeno"}});
  assert.match(decode.decode((await reader.read()).value),/heartbeat/);
  listener({kind:"change",change:{conversationId:"caso-autorizado"}});
  assert.match(decode.decode((await reader.read()).value),/heartbeat/);
  const frame=decode.decode((await reader.read()).value);assert.match(frame,/event: invalidate/);assert.doesNotMatch(frame,/caso|nombre|documento/);assert.ok(seen.some(ids=>ids.includes("caso-ajeno")));controller.abort();assert.equal(disposed,true);assert.equal((await reader.read()).done,true);
});
test("revocación del acceso comercial cierra el stream sin emitir el historial",async()=>{
  let disposed=false;const controller=new AbortController();const stream=createWorkRealtimeStream({signal:controller.signal,broker:{connected:()=>true,subscribe:()=>()=>{disposed=true;},close(){}},authorize:async()=>{throw new AttentionError("Acceso retirado",403);},lifetimeMs:2000}),reader=stream.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),"event: access_revoked\ndata: {}\n\n");assert.equal((await reader.read()).done,true);assert.equal(disposed,true);
});
