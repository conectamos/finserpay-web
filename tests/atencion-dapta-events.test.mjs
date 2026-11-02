import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root}});
const {parseDaptaAttentionEvent,assertDaptaEventAuthorization,getDaptaEventScope,canonicalDaptaEventContact}=await jiti.import("../lib/atencion-dapta-events.ts");
const scope={workspaceId:"7496b9a3-2fe6-4e28-8411-7d54ee788b2c",agentId:"6f9560ec-dcfd-4725-bf61-27cd8d528a1c",agentChannelId:"6933b28b-b0a1-400c-aa1e-54f75bfbbd91",phoneNumberId:"1162059967000416",wabaId:"2148284059050848"};
const now=new Date("2026-11-02T01:00:00Z"),contact="12025550100";
const conversationId="00000000-0000-4000-8000-000000000001",messageId="00000000-0000-4000-8000-000000000002";
function event(){return{event:"new_message_sent",delivery_id:"delivery.test.1",created_at:now.toISOString(),agent_id:scope.agentId,workspace_id:scope.workspaceId,agent_channel_id:scope.agentChannelId,phone_number:scope.phoneNumberId,
  conversation:{id:conversationId,organization_id:scope.workspaceId,text_agent_id:scope.agentId,channel_type:"meta_whatsapp",channel_identifier:contact,metadata:{channel_id:scope.agentChannelId,organization_id:scope.workspaceId,agent_channel_type:"meta_whatsapp"}},
  message:{id:messageId,conversation_id:conversationId,direction:"outbound",content_type:"text",content:"Contenido artificial que nunca se guarda en cola",sender_identifier:"proveedor_opaco",recipient_identifier:contact,status:"pending",created_at:now.toISOString(),metadata:{agent_attribution:{agent_id:scope.agentId,agent_name:"No confiar en este nombre"}}}};}

test("native pending event only produces an opaque wake-up identity, never a sent message or body",()=>{
  const parsed=parseDaptaAttentionEvent(event(),scope,now);
  assert.equal(parsed.contactId,contact);assert.equal(parsed.phone,"+"+contact);assert.equal(parsed.messageId,messageId);
  assert.equal(parsed.externalConversationId,conversationId);assert.match(parsed.fingerprint,/^[a-f0-9]{64}$/);
  const serialized=JSON.stringify(parsed);
  for(const value of ["Contenido artificial","pending","proveedor_opaco","No confiar","agent_attribution"])assert.equal(serialized.includes(value),false);
});
test("strict canonical contacts keep the complete BSUID and allow only a single E164 plus",()=>{
  const value=event();value.conversation.channel_identifier="CO.A1b2C3";value.message.recipient_identifier="CO.A1b2C3";
  const parsed=parseDaptaAttentionEvent(value,scope,now);assert.equal(parsed.contactId,"CO.A1b2C3");assert.equal(parsed.phone,null);
  assert.equal(canonicalDaptaEventContact("+12025550100"),contact);
  for(const invalid of ["++12025550100","whatsapp:12025550100","(202)555-0100","CO.A_1","co.A1","CO.ENT.A1",`CO.${"a".repeat(129)}`])assert.throws(()=>canonicalDaptaEventContact(invalid));
});
test("all native provenance fields are required and contradictions fail before a queue exists",()=>{
  const changes=[
    e=>{e.agent_id="wrong";},e=>{e.workspace_id="wrong";},e=>{e.agent_channel_id="wrong";},e=>{e.phone_number="+573124085562";},
    e=>{e.conversation.organization_id="wrong";},e=>{e.conversation.text_agent_id="wrong";},e=>{e.conversation.channel_type="twilio_whatsapp";},
    e=>{e.conversation.metadata.channel_id="wrong";},e=>{e.conversation.metadata.organization_id="wrong";},e=>{e.conversation.metadata.agent_channel_type="wrong";},
    e=>{e.message.metadata.agent_attribution.agent_id="wrong";},e=>{e.message.conversation_id=messageId;},e=>{e.message.recipient_identifier="12025550199";},
  ];
  for(const change of changes){const value=event();change(value);assert.throws(()=>parseDaptaAttentionEvent(value,scope,now),{code:"DAPTA_EVENT_SCOPE_MISMATCH",status:403});}
});
test("unobserved event formats and directions are not guessed",()=>{
  for(const [key,value]of[["event","new_message_received"],["event","conversation_opened"],["direction","inbound"],["content_type","document"],["status","failed"]]){
    const input=event();if(key==="event")input[key]=value;else input.message[key]=value;
    assert.throws(()=>parseDaptaAttentionEvent(input,scope,now),{code:"DAPTA_EVENT_UNSUPPORTED"});
  }
});
test("invalid, expired and future timestamps do not enqueue; explicit timezone and calendar required",()=>{
  for(const date of ["2026-11-02 01:00:00","2026-02-31T12:00:00Z","2026-11-01T00:00:00Z","2026-11-02T01:06:00Z","not-a-date"]){
    const input=event();input.created_at=date;assert.throws(()=>parseDaptaAttentionEvent(input,scope,now));
  }
  const input=event();input.message.created_at="2026-11-02T01:06:00Z";assert.throws(()=>parseDaptaAttentionEvent(input,scope,now));
  input.message.created_at="2026-11-01T20:00:00-05:00";assert.equal(parseDaptaAttentionEvent(input,scope,now).messageAt,now.toISOString());
});
test("dedicated event token rejects missing configuration and unrelated credentials",()=>{
  const key="event-token-test-only-"+"a".repeat(48);
  assert.doesNotThrow(()=>assertDaptaEventAuthorization(`Bearer ${key}`,key));
  for(const header of [null,"Bearer credit-read-token",`Bearer ${key} trailing`,`Bearer\n${key}`])assert.throws(()=>assertDaptaEventAuthorization(header,key),{status:401});
  for(const configured of [undefined,"short",key+"\nextra"])assert.throws(()=>assertDaptaEventAuthorization(`Bearer ${key}`,configured),{status:503});
});
test("scope needs explicit agent channel and event fingerprints ignore body but bind identity",()=>{
  const env={DAPTA_ATTENTION_WORKSPACE_ID:scope.workspaceId,DAPTA_ATTENTION_AGENT_ID:scope.agentId,DAPTA_ATTENTION_AGENT_CHANNEL_ID:scope.agentChannelId,WHATSAPP_ATTENTION_PHONE_NUMBER_ID:scope.phoneNumberId,WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID:scope.wabaId};
  assert.deepEqual(getDaptaEventScope(env),scope);assert.equal(getDaptaEventScope({...env,DAPTA_ATTENTION_AGENT_CHANNEL_ID:""}),null);
  const a=event(),b=event();b.message.content="Otra copia del evento";b.delivery_id="delivery.test.retry";
  assert.equal(parseDaptaAttentionEvent(a,scope,now).fingerprint,parseDaptaAttentionEvent(b,scope,now).fingerprint);
  b.message.id="00000000-0000-4000-8000-000000000099";assert.notEqual(parseDaptaAttentionEvent(a,scope,now).fingerprint,parseDaptaAttentionEvent(b,scope,now).fingerprint);
});
