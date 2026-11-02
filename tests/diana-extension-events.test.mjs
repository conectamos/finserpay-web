import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createDianaExtensionEventProcessor}=await jiti.import("../lib/diana-extension-events.ts");
const scope={workspaceId:"00000000-0000-4000-8000-000000000001",agentId:"00000000-0000-4000-8000-000000000002",agentChannelId:"00000000-0000-4000-8000-000000000003",phoneNumberId:"1162059967000416",wabaId:"2148284059050848"};
const conversationId="00000000-0000-4000-8000-000000000004",externalConversationId="00000000-0000-4000-8000-000000000005",messageId="00000000-0000-4000-8000-000000000006";
const contactId="12025550100",at="2026-11-02T02:00:00.000Z",code="PR-0123456789ABCDEF";
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture(direction="inbound",outcome="granted"){
  const job={...scope,event:direction==="inbound"?"new_message_received":"new_message_sent",id:"job",deliveryId:"test.delivery",externalConversationId,contactId,phone:`+${contactId}`,messageId,messageAt:at};
  const reply={state:"confirmed",source:{workspaceId:scope.workspaceId,agentId:scope.agentId,externalConversationId,contactId},verification:{fresh:true,kind:direction==="inbound"?"lead":"agent",financialWitness:{code,textDigest:digest(direction==="inbound"?`CONFIRMO ${code}`:`Oferta artificial ${code}`)}},
    message:{id:messageId,direction,contentType:"text",status:"delivered",sentAt:at,text:direction==="inbound"?`CONFIRMO ${code}`:`Oferta artificial ${code}`}};
  const calls=[],sync=[];let enabled=true;
  const process=createDianaExtensionEventProcessor({scope,enabled:()=>enabled,consume:async proof=>{calls.push(proof);return{outcome,creditId:7};},afterGranted:async id=>sync.push(id)});
  return{job,reply,process,calls,sync,disable:()=>{enabled=false;}};
}
test("disabled integration never passes even a model-confirmed reply into the financial store",async()=>{
  const f=fixture();f.disable();f.reply.confirmed=true;
  assert.deepEqual(await f.process(f.job,f.reply,conversationId),{state:"ignored"});assert.equal(f.calls.length,0);assert.equal(f.sync.length,0);
});
test("only the exact native live customer witness enters the grant store and remote sync follows committed grant",async()=>{
  const f=fixture();f.reply.confirmed=true;f.reply.modelPhone="PRIVATE_MODEL_PHONE";
  assert.deepEqual(await f.process(f.job,f.reply,conversationId),{state:"complete",outcome:"granted"});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].conversationId,conversationId);assert.equal(f.calls[0].code,code);assert.equal(f.calls[0].textDigest,digest(`CONFIRMO ${code}`));assert.deepEqual(f.sync,[7]);
  assert.equal("text" in f.calls[0],false);
  assert.equal(JSON.stringify(f.calls).includes("confirmed"),false);assert.equal(JSON.stringify(f.calls).includes("PRIVATE_MODEL_PHONE"),false);
});
test("cross-line, actor, recipient, timestamp and message mismatches cannot create a financial witness",async()=>{
  const mutations=[f=>{f.job.phoneNumberId="1162059967000417";},f=>{f.job.wabaId="wrong";},f=>{f.job.agentId="wrong";},f=>{f.job.agentChannelId="wrong";},
    f=>{f.reply.source.contactId="12025550199";},f=>{f.reply.verification.kind="agent";},f=>{f.reply.verification.fresh=false;},
    f=>{f.reply.verification.financialWitness.code="invalid";},f=>{f.reply.verification.financialWitness.textDigest="invalid";},
    f=>{f.reply.message.id=conversationId;},f=>{f.reply.message.direction="outbound";},f=>{f.reply.message.sentAt="2026-11-02T01:59:59Z";},f=>{f.job.phone="+12025550199";}];
  for(const mutate of mutations){const f=fixture();mutate(f);await assert.rejects(f.process(f.job,f.reply,conversationId),{code:"DAPTA_EVENT_SCOPE_MISMATCH"});assert.equal(f.calls.length,0);assert.equal(f.sync.length,0);}
});
test("visible text and model flags without an original-content witness cannot authorize a grant",async()=>{
  for(const text of [`NO CONFIRMO ${code}`,"sí",`CONFIRMO ${code} pero no acepto`,`confirmed: true ${code}`,`CONFIRMO ${code}\nCONFIRMO PR-AAAAAAAAAAAAAAAA`]){
    const f=fixture();f.reply.message.text=text;delete f.reply.verification.financialWitness;assert.deepEqual(await f.process(f.job,f.reply,conversationId),{state:"ignored"});assert.equal(f.calls.length,0);
  }
  const f=fixture("outbound");f.reply.message.text=`${code} PR-AAAAAAAAAAAAAAAA`;delete f.reply.verification;assert.deepEqual(await f.process(f.job,f.reply,conversationId),{state:"ignored"});assert.equal(f.calls.length,0);
});
test("out-of-order customer confirmation remains pending until its verified offer is observed",async()=>{
  const f=fixture("inbound","pending_offer");
  assert.deepEqual(await f.process(f.job,f.reply,conversationId),{state:"pending",outcome:"pending_offer"});assert.equal(f.sync.length,0);
});
test("opaque contacts and follow-up campaigns keep their history without financial authority",async()=>{
  const opaque=fixture();opaque.job.contactId="CO.Artificial";opaque.job.phone=null;opaque.reply.source.contactId="CO.Artificial";
  assert.deepEqual(await opaque.process(opaque.job,opaque.reply,conversationId),{state:"ignored"});assert.equal(opaque.calls.length,0);
  const followup=fixture("outbound");followup.reply.verification.kind="followup";
  assert.deepEqual(await followup.process(followup.job,followup.reply,conversationId),{state:"ignored"});assert.equal(followup.calls.length,0);
});
test("canonical quote validation and idempotent grants belong to the transactional store, never a model flag",async()=>{
  for(const outcome of ["offered","rejected","already_granted"]){
    const f=fixture("outbound",outcome);const result=await f.process(f.job,f.reply,conversationId);
    assert.equal(result.outcome,outcome);assert.equal(f.calls.length,1);assert.deepEqual(f.sync,outcome==="already_granted"?[7]:[]);
  }
});
