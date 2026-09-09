import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { actorModule,errors,session,roles,loadSharedModule,TestResponse } from "./approval-shared-fixture.mjs";
const plain=value=>JSON.parse(JSON.stringify(value));

test("enlace común y sesión tienen propósito propio, no usuario, y no sirven como login general",()=>{
  const grantId=randomUUID(),sessionId=randomUUID(),token=session.createApprovalSharedToken(grantId);
  assert.deepEqual(plain(session.verifyApprovalSharedToken(token)),{grantId});
  assert.equal(session.verifyApprovalSharedToken(token.slice(0,-1)+"!"),null);
  assert.equal(session.verifyApprovalAccessToken(token),null);
  assert.equal(session.verifyApprovalSharedToken(session.createApprovalAccessToken(1,grantId)),null);
  const cookie=session.createApprovalSharedSessionToken(grantId,sessionId,new Date(Date.now()+8*60*60*1000));
  assert.equal(session.verifySessionToken(cookie),null);
  assert.equal(session.verifySellerSessionToken(cookie),null);
  const value=session.verifyApprovalSharedSessionToken(cookie);
  assert.equal(value.grantId,grantId);assert.equal(value.sessionId,sessionId);assert.equal(value.userId,undefined);
  assert.equal(session.verifyApprovalSharedSessionToken(session.createApprovalSharedSessionToken(grantId,sessionId,new Date(Date.now()-1000))),null);
  assert.equal(session.verifyApprovalSharedSessionToken(cookie+".extra"),null);
});
test("la autoría identifica enlace y sesión sin adjudicar acciones a una persona",()=>{
  const actor={kind:"SHARED_LINK",id:null,nombre:"Nombre no confiable",grantId:randomUUID(),sessionId:randomUUID()};
  assert.deepEqual(plain(actorModule.approvalActorAudit(actor)),{actorKind:"SHARED_LINK",actorUserId:null,actorName:"Acceso compartido",actorGrantId:actor.grantId,actorSessionId:actor.sessionId});
  assert.deepEqual(plain(actorModule.approvalActorAudit({id:7,nombre:"Analista"})),{actorKind:"USER",actorUserId:7,actorName:"Analista",actorGrantId:null,actorSessionId:null});
});
test("cookie compartida prevalece al admin y revocación no cae al usuario administrativo",async()=>{
  const grantId=randomUUID(),sessionId=randomUUID();let token=session.createApprovalSharedSessionToken(grantId,sessionId,new Date(Date.now()+10000)),active=true;
  const access=loadSharedModule("lib/approval-shared-session.ts",{
    "next/headers":{cookies:async()=>({get:()=>token?{value:token}:undefined})},
    "@/lib/prisma":{default:{$queryRawUnsafe:async()=>active?[{id:sessionId}]:[]}},"@/lib/session":session,
  });
  const http=loadSharedModule("lib/credit-approval-http.ts",{
    "next/server":{NextResponse:TestResponse},"@/lib/credit-approval":errors,
    "@/lib/auth":{getCreditApprovalSessionUser:async()=>({id:1,nombre:"Admin",rolNombre:"ADMIN",aliadoAccesoCodigo:"FINSERPAY"})},
    "@/lib/roles":roles,"@/lib/approval-shared-session":access,"@/lib/credit-approval-actor":actorModule,
  });
  assert.equal((await http.getApprovalActor()).kind,"SHARED_LINK");
  active=false;await assert.rejects(http.getApprovalActor(),error=>error.code==="SHARED_ACCESS_REVOKED");
  token="invalid";await assert.rejects(http.getApprovalActor(),error=>error.code==="SHARED_ACCESS_REVOKED");
  token="";assert.equal((await http.getApprovalActor()).id,1);
});
test("gestión de enlace común requiere administrador central, aunque exista sesión compartida",async()=>{
  let user=null,calls=0;
  const route=loadSharedModule("app/api/aprobaciones/enlace-comun/route.ts",{
    "next/server":{NextResponse:TestResponse},"@/lib/prisma":{default:{$transaction:async callback=>callback({})}},
    "@/lib/auth":{getSessionUser:async()=>user},"@/lib/roles":roles,"@/lib/credit-approval-errors":errors,
    "@/lib/credit-approval-http":{approvalPrivateHeaders:{},readApprovalRequest:async()=>({expectedGrantId:null}),approvalErrorResponse:error=>TestResponse.json({error:error.message},{status:error.status||503})},
    "@/lib/approval-access":{approvalAccessOrigin:()=>"https://example.invalid"},
    "@/lib/approval-shared-access":{getSharedApprovalLink:async()=>{calls++;return {ok:true};},changeSharedApprovalLink:async()=>{calls++;return {ok:true};},parseSharedGrantMutation:()=>null},
  });
  const request=new Request("https://example.invalid/api/aprobaciones/enlace-comun");
  assert.equal((await route.GET(request)).status,401);
  user={id:1,rolNombre:"ADMIN",aliadoAccesoCodigo:"ALIADO"};assert.equal((await route.GET(request)).status,403);
  user={id:2,rolNombre:"ANALISTA_APROBACION",aliadoAccesoCodigo:"FINSERPAY"};assert.equal((await route.POST(request)).status,403);
  assert.equal(calls,0);
  user={id:1,rolNombre:"ADMIN",aliadoAccesoCodigo:"FINSERPAY"};assert.equal((await route.GET(request)).status,200);assert.equal(calls,1);
});

test("canje público valida origen antes de BD y fija solo cookie compartida de ocho horas",async()=>{
  const grantId=randomUUID(),sessionId=randomUUID();let calls=0;
  const http=loadSharedModule("lib/credit-approval-http.ts",{
    "next/server":{NextResponse:TestResponse},"@/lib/credit-approval":errors,
    "@/lib/auth":{},"@/lib/roles":roles,"@/lib/approval-shared-session":{},"@/lib/credit-approval-actor":actorModule,
  });
  const route=loadSharedModule("app/api/public/approval-shared-access/route.ts",{
    "next/server":{NextResponse:TestResponse},"@/lib/prisma":{default:{$transaction:async callback=>{calls++;return callback({});}}},
    "@/lib/approval-shared-access":{exchangeSharedApprovalLink:async()=>({grantId,sessionId,expiresAt:new Date(Date.now()+28800000)})},
    "@/lib/credit-approval-errors":errors,"@/lib/credit-approval-http":http,"@/lib/session":session,
  });
  const token=session.createApprovalSharedToken(grantId);
  const request=(body,origin="https://example.invalid")=>new Request("https://example.invalid/api/public/approval-shared-access",{method:"POST",headers:{"content-type":"application/json",...(origin?{origin}:{}),cookie:"session=administrative"},body:JSON.stringify(body)});
  assert.equal((await route.POST(request({token},"https://evil.invalid"))).status,403);
  assert.equal((await route.POST(request({token},""))).status,403);
  assert.equal((await route.POST(request({token:"invalid"}))).status,401);
  assert.equal(calls,0);
  const response=await route.POST(request({token}));assert.equal(response.status,200);assert.equal(calls,1);
  assert.equal(response.body.destination,"/revision-creditos");assert.equal(response.cookieValues.size,1);
  const cookie=response.cookieValues.get(session.APPROVAL_SHARED_COOKIE_NAME);assert.equal(cookie.maxAge,28800);assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,"lax");
  assert.equal(session.verifyApprovalSharedSessionToken(cookie.value).sessionId,sessionId);
  assert.equal(response.headers.get("Referrer-Policy"),"no-referrer");assert.match(response.headers.get("Cache-Control"),/no-store/);
});


test("logout general revoca solo la sesión compartida actual y limpia cookies aunque falle BD",async()=>{
  const grantId=randomUUID(),sessionId=randomUUID();
  let token=session.createApprovalSharedSessionToken(grantId,sessionId,new Date(Date.now()+10000));
  let failure=false;
  const calls=[];
  const db={};
  const route=loadSharedModule("app/api/logout/route.ts",{
    "next/headers":{cookies:async()=>({get:()=>token?{value:token}:undefined})},
    "next/server":{NextResponse:TestResponse},"@/lib/prisma":{default:db},
    "@/lib/session":session,"@/lib/financial-access":{clearFinancialAccessCookie:()=>{}},
    "@/lib/approval-shared-access":{revokeSharedApprovalSession:async(...args)=>{calls.push(args);if(failure)throw new Error("BD sintética no disponible");}},
  });
  const response=await route.POST();
  assert.equal(response.status,200);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],db);
  assert.equal(calls[0][1],grantId);
  assert.equal(calls[0][2],sessionId);
  assert.equal(response.cookieValues.get(session.APPROVAL_SHARED_COOKIE_NAME).maxAge,0);
  failure=true;
  const unavailable=await route.POST();
  assert.equal(unavailable.status,200);
  assert.equal(unavailable.cookieValues.get(session.APPROVAL_SHARED_COOKIE_NAME).maxAge,0);
  token="invalid";
  await route.POST();
  token="";
  await route.POST();
  assert.equal(calls.length,2,"No se revoca ninguna sesión sin una cookie firmada válida");
});
