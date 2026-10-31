import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { loadReissueModule as load } from "./credit-approval-reissue-fixture.mjs";
const core=load("lib/atencion-core.ts");
const types=load("lib/atencion-work-enrollment-types.ts");
const checks=load("lib/atencion-work-enrollment-core.ts",{"./atencion-core":core,"./atencion-work-enrollment-types":types});
const enrollment=load("lib/iphone-enrollment.ts",{},{process:{env:{IPHONE_ENROLLMENT_ENABLED:"true",IPHONE_ENROLLMENT_SESSION_SECRET:"a".repeat(40),IPHONE_ENROLLMENT_IDENTITY_PEPPER:"b".repeat(40),IPHONE_ENROLLMENT_SHARED_ACCESS_SECRET:"c".repeat(43)}}});
const allChecks=Object.fromEntries(types.attentionEnrollmentChecks.map(c=>[c.key,true]));
const grantId="11111111-1111-4111-8111-111111111111",actor={type:"attention",actor:{userId:7}};
function fixture(options={}){
  const session=enrollment.issueIphoneEnrollmentPortalSession({grantId,analyst:{name:"Analista",externalId:"FINSER-USER:7"},grantExpiresAt:new Date(Date.now()+8*3600000)});
  const grant={accessMode:"GRANT",grantId,issuedBy:{userId:7},analyst:{name:"Analista",externalId:"FINSER-USER:7"},session:session.payload};
  const db={},context={db,actor:actor.actor,work:{id:"work",targetId:28,version:3},target:{document:"1000000001",imei:"123456789012345",platform:"IPHONE"}};
  const review={id:"review-real",analystName:"Analista original",approvedAt:"2026-10-31T15:00:00.000Z"};let domainCalls=0,workCalls=0,tokenChecks=0,expired=false,saved=null;const lookups=[];
  const service=load("lib/atencion-work-enrollment.ts",{
    "./atencion-core":core,"./atencion-work-enrollment-core":checks,"./iphone-enrollment":{...enrollment,verifyIphoneEnrollmentCaseToken:token=>{tokenChecks++;return enrollment.verifyIphoneEnrollmentCaseToken(token,expired?new Date(Date.now()+2*3600000):new Date());}},
    "./atencion-work-storage":{createAttentionWorkStore:()=>({workflowRead:async(a,id,kind,run)=>run(context),workflowMutate:async(a,id,kind,input,run)=>{workCalls++;if(options.durable&&saved)return {...saved,alreadyApplied:true};const result=await run(context);if(options.durable)saved=result;return result;}})},
    "./iphone-enrollment-storage":{
      findIphoneEnrollmentApplicationInTransaction:async(input,passed)=>{assert.equal(passed,db);lookups.push(input);return options.unavailable||options.changedAfterWrite&&domainCalls?{kind:"NOT_READY"}:{kind:"FOUND",item:{review:options.existing||domainCalls?review:null}};},
      approveIphoneEnrollmentCaseInTransaction:async(input,passed)=>{domainCalls++;assert.equal(passed,db);assert.equal(input.caseToken.solicitudId,28);assert.equal(input.nominalActor.id,7);assert.equal(input.checklist.enrollmentApproved,true);return {review,alreadyApproved:!!options.existing};},
    },
  }).createAttentionWorkEnrollment({});
  const token=()=>enrollment.createIphoneEnrollmentCaseToken({solicitudId:28,targetType:"APPLICATION",targetId:null,documentHash:enrollment.hashIphoneEnrollmentDocument("1000000001"),imeiHash:enrollment.hashIphoneEnrollmentImei("123456789012345"),session:session.payload});
  return {service,context,grant,review,lookups,expire:()=>{expired=true;},counts:()=>({domainCalls,workCalls,tokenChecks}),input:()=>({requestId:randomUUID(),version:3,caseToken:token(),checks:allChecks})};
}
test("requiere exactamente las cuatro pruebas existentes y no acepta campos de identidad del cliente",()=>{
  assert.equal(checks.parseAttentionEnrollmentAction({checks:allChecks}).action,"confirm");
  for(const invalid of [{},{...allChecks,abm:false},{...allChecks,abm:"true"},{...allChecks,extra:true}])assert.throws(()=>checks.parseAttentionEnrollmentAction({checks:invalid}),/cuatro/);
  assert.throws(()=>checks.parseAttentionEnrollmentAction({checks:allChecks,document:"other"}),/no admitidos/);
  assert.equal(checks.parseAttentionEnrollmentAction({action:"record_existing"}).checks,null);
  assert.throws(()=>checks.parseAttentionEnrollmentAction({action:"record_existing",checks:allChecks}),/sin declarar/);
});
test("consulta se vincula al D-id del chat y emite token de aplicación, nunca búsqueda libre",async()=>{
  const f=fixture(),result=await f.service.status(actor,"work",f.grant);
  assert.equal(result.status,"ready");assert.equal(result.version,3);assert.equal(result.available,true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.lookups)),[{solicitudId:28,document:"1000000001",imei:"123456789012345"}]);
  const token=enrollment.verifyIphoneEnrollmentCaseToken(result.caseToken);assert.equal(token.solicitudId,28);assert.equal(token.targetType,"APPLICATION");
});
test("confirmación conserva corecanónico, las cuatro pruebas y el responsable real en el resultado",async()=>{
  const f=fixture(),result=await f.service.approve(actor,"work",f.input(),f.grant);
  assert.equal(result.complete,true);assert.equal(result.result.review.analystName,"Analista original");assert.equal(result.result.source,"analyst_checks");
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.checks)),allChecks);assert.equal(f.counts().domainCalls,1);
});
test("IMEI/cédula/caso/token alterados o grant ajeno fallan antes de autorizar dominio",async()=>{
  for(const mutate of [f=>{f.context.target.imei="999999999999999";},f=>{f.context.target.document="9999999999";},f=>{f.context.work.targetId=29;},f=>{f.grant.issuedBy.userId=8;}]){
    const f=fixture(),input=f.input();mutate(f);await assert.rejects(f.service.approve(actor,"work",input,f.grant));assert.equal(f.counts().domainCalls,0);
  }
  const f=fixture();await assert.rejects(f.service.approve(actor,"work",{...f.input(),caseToken:"altered"},f.grant));assert.equal(f.counts().domainCalls,0);
});
test("no disponible no se autoriza; registrar existente exige revisión canónica vigente y no inventa pruebas",async()=>{
  const blocked=fixture({unavailable:true});assert.equal((await blocked.service.status(actor,"work",blocked.grant)).available,false);
  await assert.rejects(blocked.service.approve(actor,"work",blocked.input(),blocked.grant));assert.equal(blocked.counts().domainCalls,0);
  const fresh=fixture(),withoutChecks={...fresh.input(),action:"record_existing"};delete withoutChecks.checks;
  await assert.rejects(fresh.service.approve(actor,"work",withoutChecks,fresh.grant),/No existe/);assert.equal(fresh.counts().domainCalls,0);
  const existing=fixture({existing:true}),input={...existing.input(),action:"record_existing"};delete input.checks;
  assert.equal((await existing.service.status(actor,"work",existing.grant)).status,"approved");
  const outcome=await existing.service.approve(actor,"work",input,existing.grant);assert.equal(outcome.complete,true);assert.equal(outcome.result.source,"existing_review");assert.equal(outcome.result.checks,null);assert.equal(outcome.result.alreadyApproved,true);
});

test("si la elegibilidad cambia durante la confirmación no se finaliza el caso",async()=>{
  const f=fixture({changedAfterWrite:true});await assert.rejects(f.service.approve(actor,"work",f.input(),f.grant),/no coincide/);
  assert.equal(f.counts().domainCalls,1);
});

test("reintento confirmado recupera el resultado durable aunque haya vencido el token de consulta",async()=>{
  const f=fixture({durable:true}),input=f.input(),first=await f.service.approve(actor,"work",input,f.grant);
  assert.equal(enrollment.verifyIphoneEnrollmentCaseToken(input.caseToken,new Date(Date.now()+2*3600000)),null);
  f.expire();const replay=await f.service.approve(actor,"work",input,f.grant);
  assert.equal(replay.alreadyApplied,true);assert.deepEqual(replay.result,first.result);
  assert.equal(f.counts().domainCalls,1);assert.equal(f.counts().tokenChecks,1,"el replay no vuelve a autorizar ni a validar un token expirado");
});
