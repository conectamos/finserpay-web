import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const policy=await jiti.import('../lib/collection-voice-policy.ts');
const source=readFileSync(new URL('../lib/collection-voice-runtime.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup({verified=false,expired=false,persistenceFails=false}={}) {
  const secret='synthetic-runtime-test-secret-00000000';
  const state={id:'00000000-0000-4000-8000-000000000081',creditoId:81,phone:'573001234567',status:'ACCEPTED',createdAt:new Date(Date.now()-(expired?7200000:1000)),identityAttempts:0,identityVerifiedAt:verified?new Date():null,managementId:null,optOut:false};
  const writes=[];
  const db={
    $executeRawUnsafe:async(sql,...args)=>{if(sql.includes('"identityVerifiedAt"=CURRENT_TIMESTAMP'))state.identityVerifiedAt=new Date();if(sql.includes('"managementId"=$2'))state.managementId=args[1];return 1;},
    $queryRawUnsafe:async(sql,...args)=>{
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
    '@/lib/analyst-mora-management':{getMoraManagement:async()=>({credit:{clienteNombre:'Cliente Sintetico',clienteDocumento:'100000001',numeroCreditoVisible:'TEST-81',valorVencido:50000,diasMora:5,enMora:true},history:[]}),
      createMoraManagement:async(_id,input)=>{if(persistenceFails)throw new Error('simulated database failure');writes.push(input);return{item:{id:'00000000-0000-4000-8000-000000000082',...input}};},parseMoraManagement:v=>v,listMoraPortfolio:async()=>({items:[],hasMore:false})},
    '@/lib/analyst-mora-schema':{ensureAnalystMoraSchema:async()=>{}},
    '@/lib/credit-welcome-voice-core':{matchWelcomeVoiceIdentity:(expected,provided)=>expected.document===provided.document&&expected.name===provided.name},
    '@/lib/credit-welcome-voice-document':{parseWelcomeVoiceSpokenDocument:v=>v},
    '@/lib/dapta-welcome':{normalizeColombianMobile:v=>v},'@/lib/dapta-collections-http':{collectionCallKey:()=>state.id},'@/lib/collection-voice-policy':policy,
  };
  const loaded={exports:{}};
  runInNewContext(code,{module:loaded,exports:loaded.exports,require:n=>{assert.ok(n in modules,n);return modules[n];},process:{env:{FINSERPAY_COBRANZA_API_TOKEN:secret,FINSERPAY_COBRANZA_AGENT_ID:'synthetic-agent',FINSERPAY_COBRANZA_ACTOR_ID:'51'}},Buffer,Uint8Array,URL,URLSearchParams,Date,Request,Response,AbortSignal,fetch:()=>{throw new Error('No external calls allowed in tests');}});
  const call=async(body,auth=secret)=>loaded.exports.collectionVoiceOperation(new Request('https://example.test',{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify({event_token:policy.collectionSessionToken(state.id,secret),...body})}));
  return{call,state,writes,token:policy.collectionSessionToken(state.id,secret)};
}
test('la autorización y la firma de sesión son obligatorias',async()=>{
  const s=setup();assert.equal((await s.call({action:'identity'},'wrong')).status,401);
  assert.equal((await s.call({action:'identity',event_token:'altered'})).status,409);
  assert.equal(s.writes.length,0);
});
test('máximo tres verificaciones, sin datos financieros cuando no coincide',async()=>{
  const s=setup();for(let n=0;n<4;n++){const body=await(await s.call({action:'identity',name:'Otro',document:'999999999'})).json();assert.equal(body.verified,false);assert.equal(body.credito,undefined);}
  assert.equal(s.state.identityAttempts,3);
});
test('sesiones vencidas y acuerdos sin verificar no llegan al repositorio',async()=>{
  assert.equal((await setup({expired:true}).call({action:'identity',name:'Cliente Sintetico',document:'100000001'})).status,409);
  const s=setup();assert.equal((await s.call({action:'register',result:'ACUERDO_PAGO',confirmed:'true',agreementDate:'2026-10-20',agreementAmount:'50000'})).status,409);assert.equal(s.writes.length,0);
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
