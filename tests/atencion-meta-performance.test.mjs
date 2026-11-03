import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
import sharp from "sharp";
import PDFDocument from "pdfkit";

const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createMetaAttentionAdapter,META_ATTENTION_LINE,validateMetaAttentionMedia}=await jiti.import("../lib/atencion-meta.ts");
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

const uploadedPng=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const uploadInput={bytes:uploadedPng,mimeType:'image/png',fileName:'image.png',kind:'image'};
const uploadId='1234567890';
function uploadNetwork(options={}){
 const calls=[];
 const fetch=async(url,init)=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://graph.facebook.com');calls.push({url:parsed,init});
  if(parsed.pathname.endsWith('/messages'))return json({messaging_product:'whatsapp',messages:[{id:'wamid.OWN_UPLOAD_PERF'}],contacts:[{input:input.recipient,wa_id:input.recipient}]});
  if(parsed.pathname.endsWith('/media')){options.onUpload?.();return json({id:options.ackId??uploadId});}
  if(parsed.pathname.endsWith('/phone_numbers'))return json({data:[{id:META_ATTENTION_LINE.phoneNumberId,display_phone_number:META_ATTENTION_LINE.displayPhone}]});
  if(parsed.pathname.endsWith('/'+uploadId))return json({id:uploadId,mime_type:options.media?.mimeType??'image/png',file_size:options.media?.bytes.length??uploadedPng.length,url:'https://lookaside.fbsbx.com/whatsapp_business/attachments/?synthetic=upload'});
  return json({id:META_ATTENTION_LINE.phoneNumberId,display_phone_number:META_ATTENTION_LINE.displayPhone});
 };
 return{calls,fetch,metadata:()=>calls.filter(call=>call.url.pathname.endsWith('/'+uploadId)).length,messages:()=>calls.filter(call=>call.url.pathname.endsWith('/messages')).length};
}

const sampleImage={create:{width:512,height:512,channels:4,background:{r:12,g:180,b:70,alpha:0.5}}};
// The ISO-BMFF video track is the same structural fixture used by the media
// service tests. All five cases pass the real byte/type validator before upload.
const mediaBox=(kind,data)=>{const out=Buffer.alloc(8+data.length);out.writeUInt32BE(out.length);out.write(kind,4);data.copy(out,8);return out;};
const videoHandler=Buffer.alloc(12);videoHandler.write('vide',8);
const videoFixture=Buffer.concat([mediaBox('ftyp',Buffer.from('isom0000')),mediaBox('moov',mediaBox('trak',mediaBox('mdia',mediaBox('hdlr',videoHandler))))]);
const pdfFixture=await new Promise(resolve=>{const doc=new PDFDocument(),chunks=[];doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.text('Documento artificial de prueba local.');doc.end();});
const uploadSamples=[
 {kind:'image',mimeType:'image/png',fileName:'prueba.png',bytes:await sharp(sampleImage).png().toBuffer()},
 {kind:'audio',mimeType:'audio/mp4',fileName:'prueba.m4a',bytes:await readFile(path.join(root,'tests/fixtures/approval-call/tone.m4a'))},
 {kind:'video',mimeType:'video/mp4',fileName:'prueba.mp4',bytes:videoFixture},
 {kind:'document',mimeType:'application/pdf',fileName:'prueba.pdf',bytes:pdfFixture},
 {kind:'sticker',mimeType:'image/webp',fileName:'prueba.webp',bytes:await sharp(sampleImage).webp({lossless:true}).toBuffer()},
];
for(const media of uploadSamples)test(`fresh ${media.kind} upload removes one Graph GET from the first send, without skipping its guard`,async()=>{
 assert.equal(validateMetaAttentionMedia(media).kind,media.kind);
 const sendInput={...input,kind:media.kind,...(media.kind==='document'?{fileName:media.fileName}:{}),...(['image','video','document'].includes(media.kind)?{caption:'Descripción de prueba local'}:{})};
 for(const sameRuntime of[false,true]){
  const wire=uploadNetwork({media}),cache=createAttentionMetaVerificationCache();let guards=0;
  const make=()=>createMetaAttentionAdapter({env:env(),fetch:wire.fetch,now:()=>clockStart,verificationCache:cache});
  const uploader=make(),uploaded=await uploader.uploadMedia(media);assert.deepEqual(uploaded,{mediaId:uploadId});
  const sender=sameRuntime?uploader:make();
  await sender.sendMedia({...sendInput,...uploaded},async()=>{guards++;});
  assert.equal(wire.calls.length,sameRuntime?4:5,'only the exact same runtime may omit the fifth metadata GET');
  assert.equal(wire.metadata(),sameRuntime?0:1);assert.equal(wire.messages(),1);assert.equal(guards,1);
  assert.equal(wire.calls.filter(call=>call.init.method==='POST').length,2,'neither upload nor message is retried');
  const sent=JSON.parse(wire.calls.find(call=>call.url.pathname.endsWith('/messages')).init.body);
  assert.equal(sent.type,media.kind);assert.equal(sent[media.kind].id,uploadId);
 }
});

test('upload proof is consumed once and never crosses adapter instances or applies to stored media IDs',async()=>{
 const wire=uploadNetwork(),cache=createAttentionMetaVerificationCache();
 const make=()=>createMetaAttentionAdapter({env:env(),fetch:wire.fetch,now:()=>clockStart,verificationCache:cache});
 const adapter=make();await adapter.uploadMedia(uploadInput);
 await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});assert.equal(wire.metadata(),0);
 await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});assert.equal(wire.metadata(),1,'second use performs ordinary metadata validation');
 await adapter.uploadMedia(uploadInput);
 await make().sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});assert.equal(wire.metadata(),2,'another runtime cannot consume private upload evidence');
 await make().sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});assert.equal(wire.metadata(),3,'an existing outbox media ID is always checked');
});

test('expired or rolled-back upload clocks fall back to provider metadata',async()=>{
 for(const offset of[5000,-1]){
  let instant=clockStart;const wire=uploadNetwork();
  const adapter=createMetaAttentionAdapter({env:env(),fetch:wire.fetch,now:()=>instant});
  await adapter.uploadMedia(uploadInput);instant+=offset;
  await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});
  assert.equal(wire.metadata(),1);assert.equal(wire.messages(),1);
 }
 for(const invalidInstant of[NaN,Infinity,-Infinity]){
  let instant=invalidInstant;const wire=uploadNetwork();const adapter=createMetaAttentionAdapter({env:env(),fetch:wire.fetch,now:()=>instant});
  await adapter.uploadMedia(uploadInput);instant=clockStart;
  await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});assert.equal(wire.metadata(),1,'non-finite upload clock never supplies reusable evidence');
 }
});

test('scope rotation during an upload acknowledgment never creates reusable upload evidence',async()=>{
 for(const field of['WHATSAPP_ATTENTION_PHONE_NUMBER_ID','WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID']){
  const cfg=env(),original=cfg[field],wire=uploadNetwork({onUpload:()=>{cfg[field]='unapproved-scope';}});
  const adapter=createMetaAttentionAdapter({env:cfg,fetch:wire.fetch,now:()=>clockStart});
  await adapter.uploadMedia(uploadInput);
  await assert.rejects(adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>assert.fail()),{code:'META_SCOPE_CONFIG'});
  assert.equal(wire.messages(),0);cfg[field]=original;
  await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});
  assert.equal(wire.metadata(),1,'restoring configuration cannot manufacture proof of the earlier upload');
 }
});

test('upload evidence is bound to token and Graph version, including rotation during the upload acknowledgment',async()=>{
 for(const field of['WHATSAPP_ATTENTION_ACCESS_TOKEN','WHATSAPP_GRAPH_API_VERSION']){
  const cfg=env(),wire=uploadNetwork();const adapter=createMetaAttentionAdapter({env:cfg,fetch:wire.fetch,now:()=>clockStart});
  await adapter.uploadMedia(uploadInput);cfg[field]=field==='WHATSAPP_ATTENTION_ACCESS_TOKEN'?'rotated-upload-test-token':'v26.0';
  await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});assert.equal(wire.metadata(),1);
 }
 const cfg=env(),wire=uploadNetwork({onUpload:()=>{cfg.WHATSAPP_ATTENTION_ACCESS_TOKEN='rotated-inside-upload-test-token';}});
 const adapter=createMetaAttentionAdapter({env:cfg,fetch:wire.fetch,now:()=>clockStart});
 await adapter.uploadMedia(uploadInput);await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});
 assert.equal(wire.metadata(),1,'the upload response cannot be attributed to a different configuration');
 cfg.WHATSAPP_ATTENTION_PHONE_NUMBER_ID='unapproved-line';
 await assert.rejects(adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>assert.fail()),{code:'META_SCOPE_CONFIG'});
 assert.equal(wire.messages(),1);
});

test('malformed upload acknowledgments and invalid file kind or names cannot use upload proof to send',async()=>{
 const bad=uploadNetwork({ackId:'not-a-media-id'}),broken=createMetaAttentionAdapter({env:env(),fetch:bad.fetch,now:()=>clockStart});
 await assert.rejects(broken.uploadMedia(uploadInput),{code:'INVALID_MEDIA_RECEIPT'});assert.equal(bad.messages(),0);
 await broken.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});assert.equal(bad.metadata(),1,'a client-known ID is not proof of an upload');
 const wire=uploadNetwork(),adapter=createMetaAttentionAdapter({env:env(),fetch:wire.fetch,now:()=>clockStart});
 await adapter.uploadMedia(uploadInput);
 await assert.rejects(adapter.sendMedia({...input,mediaId:uploadId,kind:'video'},async()=>assert.fail()),{code:'UNSUPPORTED_MEDIA'});
 assert.equal(wire.messages(),0);assert.equal(wire.metadata(),0);
 await adapter.uploadMedia(uploadInput);
 await assert.rejects(adapter.sendMedia({...input,mediaId:uploadId,kind:'image',fileName:'image.exe'},async()=>assert.fail()),{code:'INVALID_MEDIA_NAME'});
 assert.equal(wire.messages(),0);
});

test('fresh upload proof never bypasses a disabled channel, closed window or failed persisted guard',async()=>{
 for(const failure of['disabled','window','guard']){
  const cfg=env(),wire=uploadNetwork(),adapter=createMetaAttentionAdapter({env:cfg,fetch:wire.fetch,now:()=>clockStart});let guards=0;
  await adapter.uploadMedia(uploadInput);
  if(failure==='disabled')cfg.WHATSAPP_ATTENTION_SEND_ENABLED='false';
  const send={...input,mediaId:uploadId,kind:'image',...(failure==='window'?{lastInboundAt:new Date(clockStart-24*3600000).toISOString()}:{})};
  await assert.rejects(adapter.sendMedia(send,async()=>{guards++;throw new Error('persisted guard rejected');}),failure==='guard'?/persisted guard rejected/:{code:failure==='disabled'?'META_SEND_DISABLED':'SERVICE_WINDOW_CLOSED'});
  assert.equal(wire.messages(),0);assert.equal(guards,failure==='guard'?1:0);
 }
});

test('a failed persisted guard consumes upload evidence before a later explicit attempt',async()=>{
 const wire=uploadNetwork(),adapter=createMetaAttentionAdapter({env:env(),fetch:wire.fetch,now:()=>clockStart});let guards=0;
 await adapter.uploadMedia(uploadInput);
 await assert.rejects(adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{guards++;throw new Error('persisted guard rejected');}),/persisted guard rejected/);
 assert.equal(wire.messages(),0);assert.equal(wire.metadata(),0);assert.equal(guards,1);
 await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{guards++;});
 assert.equal(wire.metadata(),1,'the later explicit call performs ordinary metadata validation');
 assert.equal(wire.messages(),1);assert.equal(guards,2,'each explicit call still requires its own persisted guard');
});

test('a different media ID cannot consume upload evidence as authorization or skip its metadata lookup',async()=>{
 const wire=uploadNetwork(),adapter=createMetaAttentionAdapter({env:env(),fetch:wire.fetch,now:()=>clockStart}),differentId='9876543210';
 await adapter.uploadMedia(uploadInput);
 await assert.rejects(adapter.sendMedia({...input,mediaId:differentId,kind:'image'},async()=>assert.fail()),{code:'UNSUPPORTED_MEDIA'});
 assert.equal(wire.calls.filter(call=>call.url.pathname.endsWith('/'+differentId)).length,1);
 assert.equal(wire.messages(),0);
 await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});
 assert.equal(wire.metadata(),1,'an attempted different ID retires the single-use proof rather than retaining it');
});

test('a failed second upload clears the earlier proof and rollback during upload cannot create one',async()=>{
 const options={},wire=uploadNetwork(options),adapter=createMetaAttentionAdapter({env:env(),fetch:wire.fetch,now:()=>clockStart});
 await adapter.uploadMedia(uploadInput);options.ackId='invalid';
 await assert.rejects(adapter.uploadMedia(uploadInput),{code:'INVALID_MEDIA_RECEIPT'});
 await adapter.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});assert.equal(wire.metadata(),1);
 let instant=clockStart;const rolled=uploadNetwork({onUpload:()=>{instant--;}}),rollback=createMetaAttentionAdapter({env:env(),fetch:rolled.fetch,now:()=>instant});
 await rollback.uploadMedia(uploadInput);instant=clockStart;
 await rollback.sendMedia({...input,mediaId:uploadId,kind:'image'},async()=>{});assert.equal(rolled.metadata(),1);
});
