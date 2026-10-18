import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const policy=await jiti.import('../lib/collection-voice-policy.ts');
const source=readFileSync(new URL('../lib/collection-voice-runtime.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup({verified=false,expired=false,persistenceFails=false,ownedPhone=false,history=[],followupCompleted=false,portfolio=false,auditAttempts=[],auditContacts=[],auditOther=[],manualRequested=false,enMora=true,extension=false}={}) {
  const secret='synthetic-runtime-test-secret-00000000';
  const state={id:'00000000-0000-4000-8000-000000000081',creditoId:81,phone:'573001234567',status:'ACCEPTED',createdAt:new Date(Date.now()-(expired?7200000:1000)),identityAttempts:0,identityVerifiedAt:verified?new Date():null,managementId:null,optOut:false,manualRequested};
  const writes=[],allCreditWrites=[],sqlMutations=[],auditQueries=[];
  const db={
    $executeRawUnsafe:async(sql,...args)=>{sqlMutations.push(sql);if(sql.includes('"identityVerifiedAt"=CURRENT_TIMESTAMP'))state.identityVerifiedAt=new Date();if(sql.includes('"managementId"=$2'))state.managementId=args[1];return 1;},
    $queryRawUnsafe:async(sql,...args)=>{
      if(sql.includes('collection-audit-'))auditQueries.push({sql,args});
      if(sql.includes('collection-audit-attempts'))return auditAttempts;
      if(sql.includes('collection-audit-contacts'))return auditContacts;
      if(sql.includes('collection-audit-other'))return auditOther;
      if(sql.includes('SELECT "id" FROM "CreditMoraManagementEvent"'))return writes.length?[{id:'00000000-0000-4000-8000-000000000082'}]:[];
      if(sql.includes('WHERE "followupFor"=$1::uuid AND "contactedAt" IS NOT NULL'))return [{n:followupCompleted?1:0}];
      if(sql.includes('SELECT * FROM "CollectionVoiceAttempt"'))return [state];
      if(sql.includes('"callbackHash" IS NULL RETURNING')){
        if(state.callbackHash)return [];
        state.callbackHash=args[3];state.outcome=JSON.parse(args[2]);return [{id:state.id}];
      }
      if(sql.includes('SELECT "callbackHash"'))return [{callbackHash:state.callbackHash}];
      if(sql.includes('"identityAttempts"="identityAttempts"+1'))return state.identityAttempts<3?[{identityAttempts:++state.identityAttempts}]:[];
      throw new Error('Unexpected query '+sql);
    },
  };
  const modules={
    'server-only':{},'node:crypto':crypto,'@/lib/prisma':{default:db},
    '@/lib/analyst-mora-management':{getMoraManagement:async()=>({credit:{clienteNombre:'Cliente Sintetico',clienteDocumento:'100000001',clienteTelefono:ownedPhone?'573001234567':null,numeroCreditoVisible:'TEST-81',valorVencido:50000,valorUnaCuotaVencida:25000,diasMora:5,enMora,prorrogaActiva:extension?{id:'extension'}:null},history}),
      createMoraManagement:async(_id,input)=>{if(persistenceFails)throw new Error('simulated database failure');writes.push(input);return{item:{id:'00000000-0000-4000-8000-000000000082',...input}};},
      createCreditManagement:async(_id,input)=>{if(persistenceFails)throw new Error('simulated database failure');allCreditWrites.push(input);return{item:{id:'00000000-0000-4000-8000-000000000082',...input}};},
      parseMoraManagement:v=>v,listMoraPortfolio:async()=>({items:portfolio?[{id:81}]:[],hasMore:false})},
    '@/lib/analyst-mora-schema':{ensureAnalystMoraSchema:async()=>{}},
    '@/lib/credit-welcome-voice-core':{matchWelcomeVoiceIdentity:(expected,provided)=>expected.document===provided.document&&expected.name===provided.name},
    '@/lib/credit-welcome-voice-document':{parseWelcomeVoiceSpokenDocument:v=>v},
    '@/lib/dapta-welcome':{normalizeColombianMobile:v=>v},'@/lib/dapta-collections-http':{collectionCallKey:()=>state.id},'@/lib/collection-voice-policy':policy,
  };
  const loaded={exports:{}};
  runInNewContext(code,{module:loaded,exports:loaded.exports,require:n=>{assert.ok(n in modules,n);return modules[n];},process:{env:{FINSERPAY_COBRANZA_API_TOKEN:secret,FINSERPAY_COBRANZA_AGENT_ID:'synthetic-agent',FINSERPAY_COBRANZA_ACTOR_ID:'51'}},Buffer,Uint8Array,URL,URLSearchParams,Date,Request,Response,AbortSignal,fetch:()=>{throw new Error('No external calls allowed in tests');}});
  const call=async(body,auth=secret)=>loaded.exports.collectionVoiceOperation(new Request('https://example.test',{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify({event_token:policy.collectionSessionToken(state.id,secret),...body})}));
  return{call,state,writes,allCreditWrites,sqlMutations,auditQueries,token:policy.collectionSessionToken(state.id,secret)};
}

test('cierre de llamada iniciada desde cartera conserva resultado si el crédito ya está al día',async()=>{
  const s=setup({manualRequested:true,enMora:false});
  const call={call_id:'synthetic-call-81',dynamic_variables:{event_token:s.token},disconnection_reason:'dial_no_answer',call_analysis:{custom_analysis_data:{}}};
  const result=await(await s.call({action:'postcall',call})).json();
  assert.equal(result.registrado,true);assert.equal(s.allCreditWrites.length,1);assert.equal(s.allCreditWrites[0].result,'SIN_RESPUESTA');assert.equal(s.writes.length,0);
  const automatic=setup({enMora:false});
  const unchanged=await(await automatic.call({action:'postcall',call:{...call,dynamic_variables:{event_token:automatic.token}}})).json();
  assert.equal(unchanged.registrado,false);assert.equal(automatic.allCreditWrites.length,0);assert.equal(automatic.writes.length,0);
});
test('informe explícito de pago de una llamada manual ya iniciada se conserva aunque el abono ya figure',async()=>{
  const s=setup({manualRequested:true,enMora:false,verified:true});
  const result=await(await s.call({action:'register',result:'PAGO_REALIZADO',comment:'Cliente confirma que ya realizó el pago.'})).json();
  assert.equal(result.registrado,true);assert.equal(s.allCreditWrites.length,1);assert.equal(s.allCreditWrites[0].result,'PAGO_REALIZADO');assert.equal(s.writes.length,0);
  const agreement=setup({manualRequested:true,enMora:false,verified:true});
  const stopped=await(await agreement.call({action:'register',result:'ACUERDO_PAGO',agreementConfirmed:'true',agreementDate:'2099-10-20',agreementAmount:'50000'})).json();
  assert.equal(stopped.registrado,false);assert.equal(stopped.suspend,true);assert.equal(agreement.allCreditWrites.length,0);
});
test('una prórroga aprobada durante llamada manual suspende cobranza sin borrar el cierre',async()=>{
  const s=setup({manualRequested:true,extension:true,ownedPhone:true});
  const identity=await(await s.call({action:'identity',name:'Cliente Sintetico',holderConfirmed:'true'})).json();
  assert.equal(identity.verified,true);assert.equal(identity.suspend,true);
  const agreement=await(await s.call({action:'register',result:'ACUERDO_PAGO',agreementConfirmed:'true',agreementDate:'2099-10-20',agreementAmount:'50000'})).json();
  assert.equal(agreement.registrado,false);assert.equal(agreement.suspend,true);assert.equal(s.allCreditWrites.length,0);
});

test('auditoría explica bloqueos sin llamadas, registros de cartera ni exponer documentos o sesiones',async()=>{
  const s=setup({portfolio:true,ownedPhone:true,auditAttempts:[{id:'held',createdAt:new Date(),status:'UNKNOWN',outcome:{pago_informado:true},managementId:null,optOut:false}],auditContacts:[{id:'contact',creditoId:81,action:'LLAMADA',actedAt:new Date(),resultCode:'LLAMADA_INCOMPLETA',comment:'Cierre del proveedor: inactivity.'}],auditOther:[{source:'Recordatorio WhatsApp',status:'ACCEPTED',at:new Date()}]});
  const r=await s.call({action:'audit'});assert.equal(r.status,200);
  const body=await r.json();assert.equal(body.readOnly,true);assert.equal(body.total,1);
  const item=body.items[0],codes=item.reasons.map(r=>r.code);
  for(const code of ['LLAMADA_ACTIVA_O_INCIERTA','PAGO_INFORMADO_EN_LLAMADA','GESTION_LLAMADA_HOY','OTRA_CAMPANA'])assert.ok(codes.includes(code),code);
  assert.ok(item.reviews.some(r=>r.includes('no demuestra entrega')));
  assert.ok(item.reviews.some(r=>r.includes('inactividad/destino inválido')));
  assert.equal(item.eligible,false);assert.equal(s.writes.length,0);
  assert.equal(s.sqlMutations.filter(sql=>/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)).length,0);
  assert.equal(JSON.stringify(body).includes('100000001'),false);assert.equal(JSON.stringify(body).includes(s.token),false);
  assert.equal((await s.call({action:'audit'},'wrong')).status,401);
});

test('PostgreSQL valida las consultas de auditoría y sus ventanas por canal',async t=>{
  const s=setup({portfolio:true,ownedPhone:true});await s.call({action:'audit'});
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE "Credito" ("id" int,"clienteDocumento" text);
    CREATE TABLE "CollectionVoiceAttempt" ("debtorKey" text,"createdAt" timestamptz);
    CREATE TABLE "CreditMoraManagementEvent" ("id" text,"creditoId" int,"action" text,"actedAt" timestamptz,"resultCode" text,"comment" text);
    CREATE TABLE "CreditDueReminder" ("creditoId" int,"status" text,"claimedAt" timestamptz);
    CREATE TABLE "CreditOverdueDataAttempt" ("creditoId" int,"status" text,"claimedAt" timestamptz);
    CREATE TABLE "CreditWelcomeVoiceEvent" ("creditoId" int,"status" text,"createdAt" timestamptz,"identityVerifiedAt" timestamptz);
    INSERT INTO "Credito" VALUES (81,'100000001');
    INSERT INTO "CreditMoraManagementEvent" VALUES ('incomplete',81,'LLAMADA',CURRENT_TIMESTAMP,'LLAMADA_INCOMPLETA','inactivity'),('missed',81,'LLAMADA',CURRENT_TIMESTAMP,'SIN_RESPUESTA','no answer');
    INSERT INTO "CreditDueReminder" VALUES (81,'ACCEPTED',CURRENT_TIMESTAMP),(81,'ACCEPTED',CURRENT_TIMESTAMP-interval '8 days');
    INSERT INTO "CreditWelcomeVoiceEvent" VALUES (81,'COMPLETED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);`);
  const counts=[];for(const q of s.auditQueries)counts.push((await db.query(q.sql,q.args)).rows.length);
  assert.deepEqual(counts,[0,1,1]);
  const otherQuery=s.auditQueries.find(q=>q.sql.includes('collection-audit-other'));
  await db.exec(`DELETE FROM "CreditWelcomeVoiceEvent";
    INSERT INTO "CreditOverdueDataAttempt" VALUES (81,'ACCEPTED',CURRENT_TIMESTAMP);`);
  assert.equal((await db.query(otherQuery.sql,otherQuery.args)).rows.length,0,'provider acceptance of either WhatsApp campaign is not human contact');
  await db.exec(`INSERT INTO "CreditOverdueDataAttempt" VALUES (81,'UNKNOWN',CURRENT_TIMESTAMP);
    INSERT INTO "CreditDueReminder" VALUES (81,'CLAIMED',CURRENT_TIMESTAMP);`);
  assert.equal((await db.query(otherQuery.sql,otherQuery.args)).rows.length,2,'pending and uncertain sends retain their reconciliation hold');
});
test('la autorización y la firma de sesión son obligatorias',async()=>{
  const s=setup();assert.equal((await s.call({action:'identity'},'wrong')).status,401);
  assert.equal((await s.call({action:'identity',event_token:'altered'})).status,409);
  assert.equal(s.writes.length,0);
});
test('máximo tres verificaciones, sin datos financieros cuando no coincide',async()=>{
  const s=setup();for(let n=0;n<4;n++){const body=await(await s.call({action:'identity',name:'Otro',document:'999999999'})).json();assert.equal(body.verified,false);assert.equal(body.credito,undefined);}
  assert.equal(s.state.identityAttempts,3);
});
test('confirmación breve exige nombre exacto y teléfono autorizado del titular',async()=>{
  const s=setup();
  for(const body of [{name:'Cliente Sintetico',holderConfirmed:true},{name:'Otro',holderConfirmed:'true'},{name:'Cliente Sintetico',holderConfirmed:'true'}]){
    const result=await(await s.call({action:'identity',...body})).json();
    assert.equal(result.verified,false);assert.equal(result.credito,undefined);
  }
  const isolated=setup();isolated.state.testCall=true;
  // A test flag alone does not authorize an arbitrary destination.
  assert.equal((await(await isolated.call({action:'identity',name:'Cliente Sintetico',holderConfirmed:'true'})).json()).verified,false);
  const owned=setup({ownedPhone:true});
  const accepted=await(await owned.call({action:'identity',name:'cliente sintetico',holderConfirmed:'true'})).json();
  assert.equal(accepted.verified,true);assert.equal(accepted.credito.valorUnaCuotaVencida,25000);assert.equal(accepted.evaluacionJudicialDecidida,null);
  const expired=setup({ownedPhone:true,expired:true});
  assert.equal((await expired.call({action:'identity',name:'Cliente Sintetico',holderConfirmed:'true'})).status,409);
});

test('sesiones vencidas y acuerdos sin verificar no llegan al repositorio',async()=>{
  assert.equal((await setup({expired:true}).call({action:'identity',name:'Cliente Sintetico',document:'100000001'})).status,409);
  const s=setup();assert.equal((await s.call({action:'register',result:'ACUERDO_PAGO',confirmed:'true',agreementDate:'2026-10-20',agreementAmount:'50000'})).status,409);assert.equal(s.writes.length,0);
});

test('la consulta respeta acuerdos en Seguimiento y libera cobro ordinario después del seguimiento realizado',async()=>{
  const identity={action:'identity',name:'Cliente Sintetico',document:'100000001'};
  const future={id:'promise',managementStatus:'SEGUIMIENTO',resultCode:'ACUERDO_PAGO',agreementDate:'2099-10-16',nextFollowUpAt:'2099-10-16T15:00:00Z'};
  assert.equal((await(await setup({history:[future]}).call(identity)).json()).suspend,true);
  const due={...future,agreementDate:'2000-01-01',nextFollowUpAt:'2000-01-01T15:00:00Z'};
  const follow=setup({history:[due]});follow.state.followupFor='promise';
  const response=await(await follow.call(identity)).json();assert.equal(response.suspend,false);assert.equal(response.followup,true);
  const ordinary=setup({history:[due],followupCompleted:true});
  const resumed=await(await ordinary.call(identity)).json();assert.equal(resumed.suspend,false);assert.equal(resumed.followup,false);
});
test('verificación real libera únicamente el crédito vinculado y no estados jurídicos inventados',async()=>{
  const s=setup();const result=await(await s.call({action:'identity',name:'Cliente Sintetico',document:'100000001'})).json();
  assert.equal(result.verified,true);assert.equal(result.credito.valorVencido,50000);assert.equal(result.trasladoPrejuridico,null);assert.ok(s.state.identityVerifiedAt);
});
test('un fallo del repositorio nunca confirma el acuerdo; un pago informado conserva seguimiento',async()=>{
  const failed=setup({verified:true,persistenceFails:true});const r=await failed.call({action:'register',result:'PAGO_REALIZADO'});assert.equal(r.status,409);assert.equal((await r.json()).registrado,undefined);
  const saved=setup({verified:true});assert.equal((await(await saved.call({action:'register',result:'PAGO_REALIZADO',comment:'Cliente informa pago pendiente de validación'})).json()).registrado,true);assert.equal(saved.writes[0].managementStatus,'SEGUIMIENTO');
  const second=await(await saved.call({action:'register',result:'ACUERDO_PAGO',confirmed:'true'})).json();assert.equal(second.registrado,false);assert.equal(saved.writes.length,1);
});

test('un acuerdo exige el campo de confirmación utilizado por la herramienta de voz',async()=>{
  const s=setup({verified:true});
  const body={action:'register',result:'ACUERDO_PAGO',agreementDate:'2026-10-20',agreementAmount:'50000'};
  assert.equal((await s.call(body)).status,409);
  assert.equal((await s.call({...body,confirmed:'true'})).status,409);
  assert.equal((await s.call({...body,agreementConfirmed:'true',agreementAmount:'50.000'})).status,409);
  const response=await(await s.call({...body,agreementConfirmed:'true'})).json();
  assert.equal(response.registrado,true);
  assert.equal(s.writes[0].agreementDate,'2026-10-20');
  assert.equal(s.writes[0].agreementAmount,50000);
  assert.equal(s.writes[0].managementStatus,'ACUERDO_PAGO');
});

test('el cierre registra medios en cartera una sola vez y no acepta otro cierre contradictorio',async()=>{
  const s=setup({verified:true});
  const call={call_id:'synthetic-call-81',dynamic_variables:{event_token:s.token},disconnection_reason:'user_hangup',call_analysis:{custom_analysis_data:{resultado_gestion:'MEDIOS_PAGO',observacion_gestion:'Se compartió el portal de pagos.'}}};
  const first=await(await s.call({action:'postcall',call})).json();
  assert.equal(first.registrado,true);assert.equal(s.writes[0].result,'MEDIOS_PAGO');
  const repeated=await(await s.call({action:'postcall',call})).json();assert.equal(repeated.duplicate,true);assert.equal(s.writes.length,1);
  assert.equal((await s.call({action:'postcall',call:{...call,disconnection_reason:'dial_no_answer'}})).status,409);
});

test('la llamada al celular de pruebas jamás crea acuerdos en la cartera real',async()=>{
  const s=setup({verified:true});s.state.testCall=true;
  const result=await(await s.call({action:'register',result:'ACUERDO_PAGO',agreementConfirmed:'true',agreementDate:'2026-10-20',agreementAmount:'50000'})).json();
  assert.equal(result.registrado,false);assert.equal(result.test,true);assert.equal(s.writes.length,0);
});

test('inactividad, número inválido y cuelgue dejan un intento auditable sin fabricar acuerdos',async()=>{
  for(const reason of ['inactivity','invalid_destination','user_hangup']) {
    const s=setup();
    const call={call_id:'synthetic-call-81',dynamic_variables:{event_token:s.token},disconnection_reason:reason,call_analysis:{custom_analysis_data:{acuerdo_confirmado:true,fecha_acuerdo:'2026-10-20',valor_acuerdo:50000}}};
    const response=await(await s.call({action:'postcall',call})).json();
    assert.equal(response.registrado,true);assert.equal(s.writes.length,1);
    assert.equal(s.writes[0].result,reason==='invalid_destination'?'SIN_RESPUESTA':'LLAMADA_INCOMPLETA');assert.equal(s.writes[0].managementStatus,reason==='invalid_destination'?'SIN_RESPUESTA':'SEGUIMIENTO');
    assert.equal(s.writes[0].agreementDate,undefined);assert.ok(s.writes[0].comment.includes(reason));
    // Simulate a crash after the portfolio insert but before attaching its ID.
    s.state.managementId=null;
    assert.equal((await(await s.call({action:'postcall',call})).json()).registrado,true);assert.equal(s.writes.length,1);
    assert.equal((await(await s.call({action:'postcall',call})).json()).duplicate,true);assert.equal(s.writes.length,1);
  }
  const failed=setup({persistenceFails:true});
  const response=await(await failed.call({action:'postcall',call:{call_id:'synthetic-call-81',dynamic_variables:{event_token:failed.token},disconnection_reason:'inactivity',call_analysis:{custom_analysis_data:{}}}})).json();
  assert.equal(response.registrado,false);
});
