import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {createJiti} from 'jiti';
const root=path.resolve(import.meta.dirname,'..');
const jiti=createJiti(import.meta.url,{alias:{'@':root,'server-only':path.join(root,'node_modules/next/dist/compiled/server-only/empty.js')}});
const {attentionDaptaEventConfig,createAttentionDaptaEventHandler,dispatchAttentionDaptaEvents}=await jiti.import('../lib/atencion-dapta-event-runtime.ts');
const {AttentionDaptaError}=await jiti.import('../lib/atencion-dapta.ts');
const scope={workspaceId:'7496b9a3-2fe6-4e28-8411-7d54ee788b2c',agentId:'6f9560ec-dcfd-4725-bf61-27cd8d528a1c',agentChannelId:'6933b28b-b0a1-400c-aa1e-54f75bfbbd91',phoneNumberId:'1162059967000416',wabaId:'2148284059050848'};
const token='test-event-token-never-production-12345678901234567890';
const now=new Date('2026-11-02T01:00:00Z');
const conversationId='00000000-0000-4000-8000-000000000001',messageId='00000000-0000-4000-8000-000000000002',contactId='12025550100';
function native(){return{event:'new_message_sent',delivery_id:'delivery.test',created_at:now.toISOString(),agent_id:scope.agentId,workspace_id:scope.workspaceId,agent_channel_id:scope.agentChannelId,phone_number:scope.phoneNumberId,
  conversation:{id:conversationId,organization_id:scope.workspaceId,text_agent_id:scope.agentId,channel_type:'meta_whatsapp',channel_identifier:contactId,metadata:{channel_id:scope.agentChannelId,organization_id:scope.workspaceId,agent_channel_type:'meta_whatsapp'}},
  message:{id:messageId,conversation_id:conversationId,direction:'outbound',content_type:'text',content:'Artificial private text',recipient_identifier:contactId,status:'pending',created_at:now.toISOString(),metadata:{agent_attribution:{agent_id:scope.agentId}}}};}
const env={DAPTA_ATTENTION_EVENTS_ENABLED:'true',DAPTA_ATTENTION_EVENT_TOKEN:token,DAPTA_ATTENTION_WORKSPACE_ID:scope.workspaceId,DAPTA_ATTENTION_AGENT_ID:scope.agentId,DAPTA_ATTENTION_AGENT_CHANNEL_ID:scope.agentChannelId,WHATSAPP_ATTENTION_PHONE_NUMBER_ID:scope.phoneNumberId,WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID:scope.wabaId};
test('event receiver is disabled without explicit activation, dedicated token and the fixed Meta line',()=>{
  assert.deepEqual(attentionDaptaEventConfig(env),{scope,token});
  for(const patch of [{DAPTA_ATTENTION_EVENTS_ENABLED:'false'},{DAPTA_ATTENTION_EVENT_TOKEN:'short'},{DAPTA_ATTENTION_AGENT_CHANNEL_ID:''},{WHATSAPP_ATTENTION_PHONE_NUMBER_ID:'1234567890'}])assert.equal(attentionDaptaEventConfig({...env,...patch}),null);
});
test('authentication and unavailable configuration fail before reading the request or writing a job',async()=>{
  let read=false,writes=0;
  const req={headers:new Headers({'authorization':'Bearer wrong'}),get body(){read=true;throw new Error('must not read');}};
  const handler=createAttentionDaptaEventHandler({config:()=>({scope,token}),ingest:async()=>writes++});
  assert.equal((await handler(req)).status,401);assert.equal(read,false);assert.equal(writes,0);
  assert.equal((await createAttentionDaptaEventHandler({config:()=>null,ingest:async()=>writes++})(req)).status,503);
});
test('authenticated native event only queues validated identifiers and never echoes private data',async()=>{
  const queued=[];
  const handler=createAttentionDaptaEventHandler({config:()=>({scope,token}),now:()=>now,ingest:async e=>queued.push(e)});
  const response=await handler(new Request('https://finserpay.test/api/integraciones/atencion/dapta',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(native())}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.equal(queued.length,1);
  assert.equal(JSON.stringify(queued).includes('Artificial private text'),false);assert.equal(queued[0].contactId,contactId);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('bad type, malformed JSON, excessive bodies and foreign channel cannot queue events',async()=>{
  let queued=0;const handler=createAttentionDaptaEventHandler({config:()=>({scope,token}),now:()=>now,ingest:async()=>queued++});
  const make=(body,type='application/json')=>new Request('https://finserpay.test/api/integraciones/atencion/dapta',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':type},body});
  assert.equal((await handler(make('{}','text/plain'))).status,415);
  assert.equal((await handler(make('{broken'))).status,400);
  assert.equal((await handler(make('a'.repeat(65537)))).status,413);
  const foreign=native();foreign.agent_channel_id='foreign';assert.equal((await handler(make(JSON.stringify(foreign)))).status,403);
  assert.equal(queued,0);
});
function fixture(){
  const job={id:'job',externalConversationId:conversationId,contactId,messageId,historyCursor:null,attempts:1};
  const retries=[],saved=[];
  const store={claim:async limit=>{assert.equal(limit,2);return[job];},retry:async(j,input)=>{assert.equal(j,job);retries.push(input);},persistConfirmed:async(j,input)=>{assert.equal(j,job);saved.push(input);return{imported:true,pendingBinding:false};}};
  const source={workspaceId:scope.workspaceId,agentId:scope.agentId,externalConversationId:conversationId,contactId};
  return{job,store,source,retries,saved};
}
test('worker only persists a provider-confirmed exact message, with no outbound transport',async()=>{
  const f=fixture();const reply={state:'confirmed',source:f.source,historyCursor:null,historyTruncated:false,message:{id:messageId,text:'Artificial confirmed',sentAt:now.toISOString(),status:'delivered',direction:'outbound',contentType:'text'}};
  const result=await dispatchAttentionDaptaEvents(f.store,async input=>{assert.deepEqual(input,{externalConversationId:conversationId,contactId,messageId,historyCursor:null});return reply;});
  assert.deepEqual(result,{processed:1,imported:1,pending:0,failed:0});assert.equal(f.saved.length,1);assert.equal(f.retries.length,0);
});
test('pending delivery keeps its independent checkpoint and never persists a sent reply',async()=>{
  const f=fixture();const result=await dispatchAttentionDaptaEvents(f.store,async()=>({state:'pending',source:f.source,historyCursor:'page-token',historyTruncated:true,reason:'DELIVERY_PENDING'}));
  assert.equal(result.pending,1);assert.equal(f.saved.length,0);assert.deepEqual(f.retries,[{delaySeconds:10,code:'DAPTA_PENDING',historyCursor:'page-token'}]);
});
test('failed sends are terminal and 429 preserves the provider retry-after without importing content',async()=>{
  const f=fixture();await dispatchAttentionDaptaEvents(f.store,async()=>({state:'failed',source:f.source,historyCursor:null,historyTruncated:false,reason:'DELIVERY_FAILED'}));
  assert.equal(f.retries[0].code,'DAPTA_FAILED');assert.equal(f.saved.length,0);
  f.retries.length=0;await dispatchAttentionDaptaEvents(f.store,async()=>{throw new AttentionDaptaError('RATE_LIMITED',429,'private provider detail',180);});
  assert.deepEqual(f.retries,[{code:'DAPTA_RATE_LIMITED',delaySeconds:180}]);assert.equal(f.saved.length,0);
});
test('a verified reply waits for its native binding instead of linking a guessed conversation',async()=>{
  const f=fixture();f.store.persistConfirmed=async()=>({imported:false,pendingBinding:true});
  const result=await dispatchAttentionDaptaEvents(f.store,async()=>({state:'confirmed',source:f.source,historyCursor:'tail',historyTruncated:false,message:{id:messageId,text:'Artificial',sentAt:now.toISOString(),status:'sent',direction:'outbound',contentType:'text'}}));
  assert.equal(result.pending,1);assert.deepEqual(f.retries,[{delaySeconds:10,code:'DAPTA_BINDING_PENDING',historyCursor:'tail'}]);
});

test('incoming customer events require the separate extension gate and never trust forwarded model flags',async()=>{
  const value=native();value.event='new_message_received';value.confirmed=true;
  Object.assign(value.message,{direction:'inbound',sender_identifier:contactId,recipient_identifier:scope.phoneNumberId,status:'delivered',metadata:{},content:'CONFIRMO PR-0123456789ABCDEF'});
  const queued=[],make=()=>new Request('https://finserpay.test/api/integraciones/atencion/dapta',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
  const disabled=createAttentionDaptaEventHandler({config:()=>({scope,token}),now:()=>now,ingest:async event=>queued.push(event)});
  assert.equal((await disabled(make())).status,400);assert.equal(queued.length,0);
  const enabled=createAttentionDaptaEventHandler({config:()=>({scope,token,extensionsEnabled:true}),now:()=>now,ingest:async event=>queued.push(event)});
  assert.equal((await enabled(make())).status,200);assert.equal(queued[0].event,'new_message_received');
  assert.equal(JSON.stringify(queued).includes('CONFIRMO'),false);assert.equal(Object.hasOwn(queued[0],'confirmed'),false);
});
test('disabled extensions preserve incoming jobs durably and keep ordinary outbound importing',async()=>{
  const f=fixture();f.job.event='new_message_received';
  const result=await dispatchAttentionDaptaEvents(f.store,async()=>assert.fail('disabled incoming must not call provider'));
  assert.equal(result.pending,1);assert.equal(f.saved.length,0);assert.equal(f.retries[0].code,'DAPTA_EXTENSION_PENDING');
  f.job.event='new_message_sent';f.retries.length=0;
  const reply={state:'confirmed',source:f.source,historyCursor:null,historyTruncated:false,message:{id:messageId,text:'Ordinary response',sentAt:now.toISOString(),status:'delivered',direction:'outbound',contentType:'text'}};
  const done=await dispatchAttentionDaptaEvents(f.store,async()=>reply,{enabled:()=>false,process:async()=>assert.fail('disabled financial store')});
  assert.equal(done.imported,1);assert.equal(f.saved.length,1);
});
test('a confirmation that overtakes its offer retries instead of being discarded or duplicated into native history',async()=>{
  const f=fixture();f.job.event='new_message_received';let consumed=0,completed=0;
  f.store.getVerifiedConversation=async()=>({conversationId});
  f.store.completeVerifiedInbound=async()=>{completed++;return{imported:false,pendingBinding:false};};
  const reply={state:'confirmed',source:f.source,historyCursor:null,historyTruncated:false,verification:{fresh:true,kind:'lead'},message:{id:messageId,text:'CONFIRMO PR-0123456789ABCDEF',sentAt:now.toISOString(),status:'delivered',direction:'inbound',contentType:'text'}};
  const extensions={enabled:()=>true,process:async(job,observed,internalId)=>{assert.equal(job,f.job);assert.equal(observed,reply);assert.equal(internalId,conversationId);return{state:++consumed===1?'pending':'complete'};}};
  const read=async input=>{assert.equal(input.direction,'inbound');assert.equal(input.requireFresh,true);return reply;};
  assert.equal((await dispatchAttentionDaptaEvents(f.store,read,extensions)).pending,1);
  assert.equal(completed,0);assert.equal(f.retries[0].code,'DAPTA_EXTENSION_PENDING');assert.equal(f.saved.length,0);
  const result=await dispatchAttentionDaptaEvents(f.store,read,extensions);
  assert.equal(result.failed,0);assert.equal(result.pending,0);assert.equal(completed,1);assert.equal(f.saved.length,0);
});
