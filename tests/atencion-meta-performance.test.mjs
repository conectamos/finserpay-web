import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createMetaAttentionAdapter,META_ATTENTION_LINE}=await jiti.import("../lib/atencion-meta.ts");
const {createAttentionMetaVerificationCache}=await jiti.import("../lib/atencion-meta-verification-cache.ts");
const clockStart=Date.parse("2026-11-03T15:00:00Z");
const env=()=>({WHATSAPP_ATTENTION_ACCESS_TOKEN:"private-test-verification-token",WHATSAPP_ATTENTION_APP_SECRET:"private-test-app-secret",
 WHATSAPP_ATTENTION_VERIFY_TOKEN:"private-test-verify-token",WHATSAPP_ATTENTION_PHONE_NUMBER_ID:META_ATTENTION_LINE.phoneNumberId,
 WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID:META_ATTENTION_LINE.wabaId,WHATSAPP_GRAPH_API_VERSION:"v25.0",
 WHATSAPP_ATTENTION_SEND_ENABLED:"true",WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED:"true"});
const input={recipient:"12025550100",attemptId:"00000000-0000-4000-8000-000000000001",cutoverConfirmed:true,lastInboundAt:new Date(clockStart-60_000).toISOString(),text:"Texto de prueba"};
const json=value=>new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});
function network({hold=false}={}){
 const calls=[],pending=[];
 const fetch=async(url,init)=>{
  const parsed=new URL(url);assert.equal(parsed.origin,"https://graph.facebook.com");calls.push({url:parsed,init});
  if(parsed.pathname.endsWith("/messages"))return json({messaging_product:"whatsapp",messages:[{id:"wamid.PERFORMANCE_TEST"}],contacts:[{input:input.recipient,wa_id:input.recipient}]});
  const value=parsed.pathname.endsWith("/phone_numbers")?{data:[{id:META_ATTENTION_LINE.phoneNumberId,display_phone_number:META_ATTENTION_LINE.displayPhone}]}
    :{id:META_ATTENTION_LINE.phoneNumberId,display_phone_number:META_ATTENTION_LINE.displayPhone};
  return hold?new Promise(resolve=>pending.push(()=>resolve(json(value)))):json(value);
 };
 return {calls,pending,fetch};
}

// Every transport here is synthetic; no test can reach Meta or a real customer.
test("five request runtimes share one positive provider check, with a fresh persisted guard on every send",async()=>{
 let instant=clockStart;const read=network(),cache=createAttentionMetaVerificationCache();let guards=0;
 const make=()=>createMetaAttentionAdapter({env:env(),fetch:read.fetch,now:()=>instant,verificationCache:cache});
 for(let i=0;i<5;i++)await make().sendText({...input,attemptId:`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`},async()=>{guards++;});
 assert.equal(guards,5);assert.equal(read.calls.filter(item=>item.url.pathname.endsWith("/messages")).length,5);
 assert.equal(read.calls.filter(item=>item.url.pathname.endsWith("/phone_numbers")).length,1);
 assert.equal(read.calls.filter(item=>item.url.pathname===`/v25.0/${META_ATTENTION_LINE.phoneNumberId}`).length,1);
 instant+=5000;await make().sendText(input,async()=>{guards++;});
 assert.equal(read.calls.filter(item=>item.url.pathname.endsWith("/phone_numbers")).length,2,"five-second boundary requires fresh provider verification");
 assert.equal(guards,6);
});

test("concurrent runtimes coalesce both provider GETs and never POST before their individual guards",async()=>{
 const read=network({hold:true}),cache=createAttentionMetaVerificationCache();let guards=0;
 const sends=Array.from({length:4},(_,index)=>createMetaAttentionAdapter({env:env(),fetch:read.fetch,now:()=>clockStart,verificationCache:cache}).sendText({...input,attemptId:`00000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`},async()=>{guards++;}));
 assert.equal(read.pending.length,2);assert.equal(guards,0);assert.equal(read.calls.length,2);
 for(const release of read.pending)release();await Promise.all(sends);
 assert.equal(guards,4);assert.equal(read.calls.filter(item=>item.url.pathname.endsWith("/messages")).length,4);
 assert.equal(read.calls.length,6,"four runtimes use two shared reads plus four explicit sends, instead of twelve requests");
});

test("token and Graph version changes never reuse a provider check; enablement is still fresh after a hit",async()=>{
 const read=network(),cache=createAttentionMetaVerificationCache(),cfg=env();
 const make=()=>createMetaAttentionAdapter({env:cfg,fetch:read.fetch,now:()=>clockStart,verificationCache:cache});
 await make().verifyConnection();cfg.WHATSAPP_ATTENTION_ACCESS_TOKEN="private-test-rotated-token";await make().verifyConnection();
 cfg.WHATSAPP_GRAPH_API_VERSION="v26.0";await make().verifyConnection();
 assert.equal(read.calls.length,6);
 cfg.WHATSAPP_ATTENTION_SEND_ENABLED="false";await assert.rejects(make().sendText(input,async()=>assert.fail("No guard for disabled sending")),{code:"META_SEND_DISABLED"});
 assert.equal(read.calls.length,6);
 cfg.WHATSAPP_ATTENTION_PHONE_NUMBER_ID="unapproved-line";await assert.rejects(make().verifyConnection(),{code:"META_SCOPE_CONFIG"});assert.equal(read.calls.length,6);
});

test("failed verification is not cached and a changed waiter configuration cannot use another request's success",async()=>{
 const cache=createAttentionMetaVerificationCache();let failures=0;
 for(let i=0;i<2;i++)await assert.rejects(cache.verify("opaque-key",()=>clockStart,async()=>{failures++;throw new Error("synthetic");}),/synthetic/);
 assert.equal(failures,2);
 const read=network({hold:true}),first=env(),second=env();
 const a=createMetaAttentionAdapter({env:first,fetch:read.fetch,now:()=>clockStart,verificationCache:cache});
 const b=createMetaAttentionAdapter({env:second,fetch:read.fetch,now:()=>clockStart,verificationCache:cache});
 const one=a.verifyConnection(),two=b.verifyConnection();second.WHATSAPP_ATTENTION_ACCESS_TOKEN="changed-during-wait";
 for(const release of read.pending)release();await one;await assert.rejects(two,{code:"META_SCOPE_CONFIG"});
});

test("positive cache is bounded, returns copies and rejects clock rollback or unbounded TTL options",async()=>{
 let instant=clockStart,reads=0;const cache=createAttentionMetaVerificationCache({limit:2,ttlMs:60_000});
 const read=async()=>{reads++;return {...META_ATTENTION_LINE};};
 const value=await cache.verify("one",()=>instant,read);value.phoneNumberId="tampered";
 assert.equal((await cache.verify("one",()=>instant,read)).phoneNumberId,META_ATTENTION_LINE.phoneNumberId);
 await cache.verify("two",()=>instant,read);await cache.verify("three",()=>instant,read);await cache.verify("one",()=>instant,read);assert.equal(reads,4);
 instant+=5000;await cache.verify("one",()=>instant,read);assert.equal(reads,5,"caller cannot expand the five-second allowance");
 instant-=1;await cache.verify("one",()=>instant,read);assert.equal(reads,6,"clock rollback requires fresh evidence");
});

test("injected transports remain isolated by default instead of populating shared production verification",async()=>{
 const read=network();for(let i=0;i<2;i++)await createMetaAttentionAdapter({env:env(),fetch:read.fetch,now:()=>clockStart}).verifyConnection();
 assert.equal(read.calls.length,4);
});


test("media metadata and provider identity read together before the persisted guard and one POST",async()=>{
 const pending=[],calls=[];let guards=0;const mediaId="1234567890";
 const transport=async(url,init)=>{const parsed=new URL(url);calls.push({url:parsed,init});assert.equal(parsed.origin,"https://graph.facebook.com");
  if(parsed.pathname.endsWith("/messages"))return json({messaging_product:"whatsapp",messages:[{id:"wamid.MEDIA_PERF"}],contacts:[{input:input.recipient,wa_id:input.recipient}]});
  const value=parsed.pathname.endsWith("/phone_numbers")?{data:[{id:META_ATTENTION_LINE.phoneNumberId,display_phone_number:META_ATTENTION_LINE.displayPhone}]}
   :parsed.pathname.endsWith("/"+mediaId)?{id:mediaId,mime_type:"image/png",file_size:12,url:"https://lookaside.fbsbx.com/whatsapp_business/attachments/?test=local"}
   :{id:META_ATTENTION_LINE.phoneNumberId,display_phone_number:META_ATTENTION_LINE.displayPhone};
  return new Promise(resolve=>pending.push({path:parsed.pathname,resolve:()=>resolve(json(value))}));
 };
 const adapter=createMetaAttentionAdapter({env:env(),fetch:transport,now:()=>clockStart});
 const sent=adapter.sendMedia({...input,mediaId,kind:"image"},async()=>{guards++;});
 assert.equal(pending.length,3,"metadata and two identity GETs start in the same phase instead of two serial phases");assert.equal(guards,0);
 for(const item of pending.filter(item=>!item.path.endsWith("/"+mediaId)))item.resolve();
 await Promise.resolve();assert.equal(guards,0);assert.equal(calls.length,3);
 pending.find(item=>item.path.endsWith("/"+mediaId)).resolve();await sent;assert.equal(guards,1);assert.equal(calls.filter(item=>item.init.method==="POST").length,1);
});

test("default production adapters reuse positive checks without sharing injected test transports",async()=>{
 const priorFetch=globalThis.fetch,read=network();globalThis.fetch=read.fetch;
 try{for(let i=0;i<2;i++)await createMetaAttentionAdapter({env:{...env(),WHATSAPP_ATTENTION_ACCESS_TOKEN:"synthetic-default-cache-only"},now:()=>clockStart}).verifyConnection();}
 finally{globalThis.fetch=priorFetch;}
 assert.equal(read.calls.length,2,"fresh HTTP adapters share only the identical private configuration's provider identity");
});
