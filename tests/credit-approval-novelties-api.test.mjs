import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
function load(path,deps={}) { const loadedModule={exports:{}}; const output=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(output,{module:loadedModule,exports:loadedModule.exports,URL,Uint8Array,Buffer,Request,Response,TextDecoder,console,require(name){assert.ok(name in deps,`Dependency ${name}`);return deps[name];}},{filename:path});return loadedModule.exports;
}
const {CreditApprovalError}=load('lib/credit-approval-errors.ts');
const next={NextResponse:class extends Response {static json(data,options){return new Response(JSON.stringify(data),{...options,headers:{'Content-Type':'application/json',...options?.headers}});}}};
class AccessError extends Error {}
const http=load('lib/credit-approval-http.ts',{
  'next/server':next,'@/lib/auth':{getCreditApprovalSessionUser:async()=>null},'@/lib/roles':{canReviewCreditApprovals:()=>false},
  '@/lib/approval-shared-session':{getApprovalSharedRequestActor:async()=>undefined},
  '@/lib/credit-approval-actor':{ApprovalActorAccessError:AccessError,ApprovalActorCreditAccessError:AccessError},
  '@/lib/credit-approval':{CreditApprovalError},
});
const context={params:Promise.resolve({id:'31'})};
const request=(body,headers={})=>new Request('https://finser.test/api/pendientes/31/respuesta',{method:'POST',headers:{'Content-Type':'application/json',origin:'https://finser.test',...headers},body:JSON.stringify(body)});

test('pendientes exige sesión normal ADMIN aliado y nunca solicita cookie de analista',async()=>{
  let current=null;const calls=[];
  const guard=load('lib/credit-approval-novelty-http.ts',{'@/lib/auth':{getSessionUser:async(...args)=>{calls.push(args);return current;}},'@/lib/credit-approval-errors':{CreditApprovalError}});
  await assert.rejects(guard.getPendingAllyActor(),e=>e.status===401);
  for(const user of [{rolNombre:'ANALISTA',aliadoAccesoId:10},{rolNombre:'VENDEDOR',aliadoAccesoId:10},{rolNombre:'ADMIN',aliadoAccesoId:1,aliadoAccesoCodigo:'FINSERPAY'}]){current={id:2,nombre:'Prueba',...user};await assert.rejects(guard.getPendingAllyActor(),e=>e.status===403);}
  current={id:2,nombre:'Admin',rolNombre:'ADMIN',aliadoAccesoId:10,aliadoAccesoCodigo:'ALLY'};
  assert.equal((await guard.getPendingAllyActor()).aliadoId,10);assert.ok(calls.every(args=>args.length===0));
});
function allyRoute(file,{authenticated=true}={}) {
  const state={writes:[],reads:[],options:[]};
  const route=load(file,{'next/server':next,'@/lib/prisma':{default:{$transaction:async(fn,options)=>{state.options.push(options);return fn({});}}},
    '@/lib/credit-approval':{approvalCreditId:Number},'@/lib/credit-approval-novelty-http':{getPendingAllyActor:async()=>{if(!authenticated)throw new CreditApprovalError('UNAUTHENTICATED','Sin sesión',401);return{id:2,nombre:'Admin',aliadoId:10};}},
    '@/lib/credit-approval-http':http,'@/lib/credit-approval-novelties':{
      prepareNoveltyResponse:async(body,photo)=>({...body,photo}),respondCreditApprovalNovelty:async(...args)=>{state.writes.push(args);return{unchanged:false};},
      getPendingAllyEvidence:async(...args)=>{state.reads.push(args);return{bytes:Buffer.from('test image'),mime:'image/png'};},
      getPendingAllyCredit:async(_db,id,actor)=>({id,canRespond:true,aliadoId:actor.aliadoId}),listPendingAllyCredits:async(_db,actor,input)=>{state.reads.push({actor,input});return{items:[],hasMore:false,nextCursor:null};},
    }});return{route,state};
}
test('POST aliado rechaza CSRF y exceso antes de escribir; guarda una vez sin segunda acción',async()=>{
  const {route,state}=allyRoute('app/api/pendientes/[id]/respuesta/route.ts');
  let response=await route.POST(request({text:'Respuesta'}, {origin:'https://other.test'}),context);assert.equal(response.status,403);assert.equal(state.writes.length,0);
  response=await route.POST(request({text:'x'.repeat(17000)}),context);assert.equal(response.status,400);assert.equal(state.writes.length,0);
  response=await route.POST(request({text:'Respuesta documentada'}),context);assert.equal(response.status,200);assert.equal(state.writes.length,1);assert.equal(state.writes[0][1],31);assert.equal(state.writes[0][3].aliadoId,10);assert.equal(state.options[0].isolationLevel,'ReadCommitted');assert.match(response.headers.get('cache-control'),/no-store/);
});
test('POST sin sesión no procesa fotografía ni inicia transacción',async()=>{
  const {route,state}=allyRoute('app/api/pendientes/[id]/evidencias/route.ts',{authenticated:false});const response=await route.POST(request({dataUrl:'fake'}),context);assert.equal(response.status,401);assert.equal(state.writes.length,0);assert.equal(state.options.length,0);
});
test('GET foto conserva scope/key y respuestas privadas sin caché',async()=>{
  const {route,state}=allyRoute('app/api/pendientes/[id]/evidencias/route.ts');const response=await route.GET(new Request('https://finser.test/api/pendientes/31/evidencias?tipo=foto-entrega'),context);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(state.reads[0][2],'foto-entrega');assert.equal(state.reads[0][3].aliadoId,10);assert.equal(await response.text(),'test image');
});
test('GET lista y detalle pasan filtros/cursor bajo snapshot de lectura',async()=>{
  const {route,state}=allyRoute('app/api/pendientes/route.ts');const response=await route.GET(new Request('https://finser.test/api/pendientes?limit=20&cursor=abc&status=WAITING_ALLY'));
  assert.equal(response.status,200);assert.equal(state.reads[0].input.limit,'20');assert.equal(state.reads[0].input.cursor,'abc');assert.equal(state.options[0].isolationLevel,'RepeatableRead');
  const detail=allyRoute('app/api/pendientes/[id]/route.ts');assert.equal((await(await detail.route.GET(new Request('https://finser.test/api/pendientes/31'),context)).json()).item.id,31);
});
test('cola compartida no usa compatibilidad histórica por cédula',async()=>{
  for(const kind of ['USER','SHARED_LINK']){
    let legacy=0,queue=0,approved=0;const route=load('app/api/aprobaciones/route.ts',{'next/server':next,'@/lib/prisma':{default:{}},
      '@/lib/credit-approval':{CreditApprovalError,approvalDocumentNumber:v=>v,listCreditApprovals:async()=>{legacy++;return[];}},
      '@/lib/credit-approval-actor':{assertApprovalActorActive:async()=>{}},
      '@/lib/credit-approval-queue':{approvalQueueSearch:value=>value?.trim()||null,listCreditApprovalQueue:async()=>{queue++;return{items:[],nextCursor:null,hasMore:false};},listApprovedCreditQueue:async()=>{approved++;return{items:[],nextCursor:null,hasMore:false};},approvalQueueLimit:()=>50},
      '@/lib/credit-approval-http':{...http,getApprovalActor:async()=>({kind,id:kind==='USER'?1:null})}});
    assert.equal((await route.GET(new Request('https://finser.test/api/aprobaciones?documento=100000'))).status,200);assert.equal(legacy,kind==='USER'?1:0);assert.equal(queue,kind==='SHARED_LINK'?1:0);
    await route.GET(new Request('https://finser.test/api/aprobaciones'));assert.equal(queue,kind==='SHARED_LINK'?2:1);
    assert.equal((await route.GET(new Request('https://finser.test/api/aprobaciones?view=approved&documento=100000'))).status,200);assert.equal(approved,1);assert.equal(legacy,kind==='USER'?1:0);
    assert.equal((await route.GET(new Request('https://finser.test/api/aprobaciones?view=history'))).status,400);assert.equal(approved,1);
  }
});
test('API de analista verifica grant y scope también al leer historial',async()=>{
  const order=[];const actor={kind:'SHARED_LINK',id:null,grantId:'grant',sessionId:'session'};
  const route=load('app/api/aprobaciones/[id]/novedades/route.ts',{'next/server':next,'@/lib/prisma':{default:{$transaction:fn=>fn({})}},'@/lib/credit-approval':{approvalCreditId:Number},
    '@/lib/credit-approval-actor':{assertApprovalActorActive:async()=>order.push('active'),assertApprovalActorCreditAccess:async()=>order.push('scope')},
    '@/lib/credit-approval-http':{...http,getApprovalActor:async()=>actor},
    '@/lib/credit-approval-novelties':{getCreditApprovalNoveltyHistory:async()=>{order.push('history');return{state:{},history:[]};},parseCreateNovelty:v=>v,createCreditApprovalNovelty:async()=>({unchanged:false})}});
  const response=await route.GET(new Request('https://finser.test/api/aprobaciones/31/novedades'),context);assert.equal(response.status,200);assert.deepEqual(order,['active','scope','history']);
});

test('contadores revalidan el enlace compartido dentro del snapshot antes de leer las colas',async()=>{
  for(const active of [true,false]) {
    const order=[],db={},actor={kind:'SHARED_LINK',id:null};
    const route=load('app/api/aprobaciones/route.ts',{'next/server':next,
      '@/lib/prisma':{default:{$transaction:async(fn,options)=>{assert.equal(options.isolationLevel,'RepeatableRead');return fn(db);}}},
      '@/lib/credit-approval':{CreditApprovalError,approvalDocumentNumber:v=>v,listCreditApprovals:async()=>assert.fail('No acceso histórico')},
      '@/lib/credit-approval-actor':{assertApprovalActorActive:async(received,receivedActor)=>{
        assert.equal(received,db);assert.equal(receivedActor,actor);order.push('active');
        if(!active)throw new CreditApprovalError('SHARED_ACCESS_REVOKED','Enlace revocado',401);
      }},
      '@/lib/credit-approval-queue':{approvalQueueLimit:()=>50,approvalQueueSearch:()=>null,
        listCreditApprovalQueue:async(received)=>{assert.equal(received,db);order.push('page');return{items:[],hasMore:false,nextCursor:null};},
        countCreditApprovalQueues:async(received)=>{assert.equal(received,db);order.push('counts');return{pending:101,approved:4};}},
      '@/lib/credit-approval-http':{...http,getApprovalActor:async()=>actor},
    });
    const response=await route.GET(new Request('https://finser.test/api/aprobaciones?counts=1'));
    assert.equal(response.status,active?200:401);assert.deepEqual(order,active?['active','page','counts']:['active']);
    if(active)assert.deepEqual((await response.json()).counts,{pending:101,approved:4});
  }
});
