import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test, { after } from "node:test";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { loadApprovalModule } from "./credit-approval-test-loader.mjs";

const password = loadApprovalModule("lib/password.ts");
const operationAccess = loadApprovalModule("lib/solicitud-operation-access.ts");
const hash = password.hashPassword("4826");
const temporaryHash = password.hashPassword("8375");
const db = new PGlite();
after(() => db.close());
await db.exec(`CREATE TABLE "Aliado" (id int PRIMARY KEY,codigo text,activo boolean);
CREATE TABLE "Sede" (id int PRIMARY KEY,nombre text,codigo text,activa boolean,"aliadoId" int);
CREATE TABLE "Vendedor" (id int PRIMARY KEY,nombre text,activo boolean,"tipoPerfil" text,"ultimoIngresoAt" timestamptz);
CREATE TABLE "SedeVendedor" ("sedeId" int,"vendedorId" int,activo boolean);
CREATE TABLE "CreditoBorrador" (id int PRIMARY KEY,"usuarioId" int,"vendedorId" int,"sedeId" int,estado text,"creditoId" int,"createdAt" timestamptz,"expiresAt" timestamptz,payload jsonb);`);

const baseUser = { id: 14, activo: true, rolNombre: "USUARIO", sedeId: 14, sedeAccesoId: 14,
  aliadoId: 2, aliadoAccesoId: 2, aliadoAccesoCodigo: "ALIADO_TEST", sedeAccesoActiva: true, aliadoAccesoActivo: true };
const body = (patch = {}) => ({ vendedorId: 17, pin: "4826", sedeId: 2, recoveryDraftId: 4276, expectedUserId: 14, ...patch });
const getRequest = (id = 4276) => new Request(`https://finser.test/api/vendedores/session?recoveryDraftId=${id}`);
const postRequest = value => new Request("https://finser.test/api/vendedores/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
class JsonResponse extends Response {
  constructor(value, init) { super(JSON.stringify(value), init); this.savedCookies = []; this.cookies = { set: (...args) => this.savedCookies.push(args) }; }
  static json(value, init) { return new JsonResponse(value, init); }
}

async function fixture({ user = baseUser, temp = false } = {}) {
  await db.exec(`TRUNCATE "CreditoBorrador","SedeVendedor","Vendedor","Sede","Aliado";
    INSERT INTO "Aliado" VALUES (2,'ALIADO_TEST',true),(3,'OTHER_ALLY',true);
    INSERT INTO "Sede" VALUES (14,'VENTAS','VENTAS',true,2),(2,'SEDE1','SEDE1',true,2),(3,'Otra sede','SEDE2',true,3);
    INSERT INTO "Vendedor" VALUES (17,'Asesor sintético',true,'VENDEDOR',NULL),(18,'Otro asesor',true,'VENDEDOR',NULL);
    INSERT INTO "SedeVendedor" VALUES (14,17,true),(14,18,true);
    INSERT INTO "CreditoBorrador" VALUES (4276,14,17,2,'ABIERTO',NULL,now(),now()+interval '15 days','{"preserved":"original fields and evidence","wizardStep":2}');`);
  const queries = [], mutations = [], cookies = [];
  const prisma = {
    $queryRawUnsafe: async (sql, ...values) => { queries.push({ sql, values }); return (await db.query(sql, values)).rows; },
    sedeVendedor: { findFirst: async ({ where }) => {
      assert.equal(where.activo, true); assert.equal(where.vendedor.activo, true);
      const result = await db.query(`SELECT v.id,v.nombre,v.activo,v."tipoPerfil",s.id AS "siteId",s.nombre AS "siteName",s.codigo AS "siteCode"
        FROM "SedeVendedor" sv JOIN "Vendedor" v ON v.id=sv."vendedorId" JOIN "Sede" s ON s.id=sv."sedeId"
        WHERE sv."sedeId"=$1 AND sv."vendedorId"=$2 AND sv.activo AND v.activo`,[where.sedeId,where.vendedorId]);
      const row = result.rows[0];
      return row ? { vendedor: { id: row.id, nombre: row.nombre, activo: row.activo, tipoPerfil: row.tipoPerfil,
        pinHash: hash, pinTemporalHash: temp ? temporaryHash : null, debeCambiarPin: false, avatarKey: null,
        documento: null, telefono: null, email: null }, sede: { id: row.siteId, nombre: row.siteName, codigo: row.siteCode } } : null;
    } },
    sede: {
      findFirst: async ({ where }) => {
        assert.equal(where.activa, true);
        return (await db.query(`SELECT s.id,s.nombre,s.codigo FROM "Sede" s JOIN "Aliado" a ON a.id=s."aliadoId"
          WHERE s.id=$1 AND s.activa AND ($2::int IS NULL OR s."aliadoId"=$2) AND ($3::text IS NULL OR a.codigo<>$3)`,
        [where.id,where.aliadoId ?? null,where.aliado?.codigo?.not ?? null])).rows[0] || null;
      },
      findMany: async () => [{ id: 2, nombre: "SEDE1", codigo: "SEDE1" }],
    },
    vendedor: { update: async ({ where, data }) => {
      assert.deepEqual(Object.keys(data), ["ultimoIngresoAt"]);
      mutations.push({ where, data });
      await db.query('UPDATE "Vendedor" SET "ultimoIngresoAt"=$2 WHERE id=$1',[where.id,data.ultimoIngresoAt]);
      return { id: where.id };
    } },
  };
  const route = loadApprovalModule("app/api/vendedores/session/route.ts", {
    "next/server": { NextResponse: JsonResponse }, "@/lib/prisma": { default: prisma },
    "@/lib/auth": { getSessionUser: async () => user }, "@/lib/seller-auth": { getSellerSessionUser: async () => null, resolveSellerProfileType: () => "VENDEDOR" },
    "@/lib/password": password, "@/lib/profile-avatars": { normalizarAvatarPerfil: () => "seller", normalizarTipoPerfilVendedor: value => value || "VENDEDOR" },
    "@/lib/vendor-profile-schema": { ensureVendorProfileVisualColumns: async () => {} },
    "@/lib/session": { SELLER_SESSION_COOKIE_NAME: "seller_session", createSellerSessionToken: value => { cookies.push(value); return "synthetic-signed-token"; }, getSessionCookieOptions: () => ({ httpOnly: true, secure: true, sameSite: "lax" }) },
    "@/lib/aliados": { ALIADO_FINSER_PAY: { codigo: "FINSERPAY" }, isFinserPayCentralAlly: value => value === "FINSERPAY" },
    "@/lib/solicitud-operation-access": operationAccess,
  });
  return { route, queries, mutations, cookies };
}

test("recuperación GET expone sólo contexto del perfil original sin cookies, PIN, cliente ni cambios", async () => {
  const f = await fixture();
  const response = await f.route.GET(getRequest());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(await response.json(), { ok: true, recoveryContext: { draftId: 4276, userId: 14, sellerId: 17, sellerName: "Asesor sintético", siteId: 2, siteName: "SEDE1" } });
  assert.equal(f.mutations.length, 0); assert.equal(f.cookies.length, 0);
  assert.ok(f.queries.every(item => /^\s*SELECT/.test(item.sql)));
});

test("GET impide revelar el perfil de solicitudes ajenas, cerradas, vencidas o sin acceso vigente", async () => {
  for (const sql of [
    `UPDATE "CreditoBorrador" SET "usuarioId"=99`, `UPDATE "CreditoBorrador" SET estado='CERRADO'`,
    `UPDATE "CreditoBorrador" SET "expiresAt"=now()-interval '1 second'`, `UPDATE "CreditoBorrador" SET "creditoId"=100`,
    `UPDATE "CreditoBorrador" SET "sedeId"=3`, `UPDATE "Vendedor" SET activo=false`,
    `UPDATE "Vendedor" SET "tipoPerfil"='ADMIN'`, `UPDATE "SedeVendedor" SET activo=false`,
    `UPDATE "Sede" SET activa=false WHERE id=2`, `UPDATE "Aliado" SET activo=false WHERE id=2`,
  ]) {
    const f = await fixture(); await db.exec(sql);
    const response = await f.route.GET(getRequest());
    assert.equal(response.status, 403, sql); assert.equal((await response.json()).code, "SESSION_RECOVERY_FORBIDDEN");
    assert.equal(f.cookies.length, 0); assert.equal(f.mutations.length, 0);
  }
});

test("POST valida PIN y contexto y emite una sesión ligada al mismo usuario, perfil y sede sin tocar solicitud", async () => {
  const f = await fixture();
  const before = (await db.query('SELECT to_jsonb(d) AS data FROM "CreditoBorrador" d')).rows;
  const response = await f.route.POST(postRequest(body()));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.recovery, { draftId: 4276, userId: 14, sellerId: 17, sedeId: 2 });
  assert.equal(payload.seller.id, 17); assert.equal(payload.operationalSede.id, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.cookies)), [{ accesoSedeId: 14, sedeId: 2, userId: 14, vendedorId: 17 }]);
  assert.equal(response.savedCookies.length, 1); assert.equal(response.savedCookies[0][2].httpOnly, true);
  assert.equal(response.savedCookies[0][2].secure, true); assert.equal(f.mutations.length, 1);
  assert.deepEqual((await db.query('SELECT to_jsonb(d) AS data FROM "CreditoBorrador" d')).rows, before);
  assert.doesNotMatch(JSON.stringify(payload), /4826|8375|pinHash|payload|original fields/);
});

test("PIN incorrecto o ausente, cambio de usuario y recuperación incompleta no producen cookies ni escrituras", async () => {
  for (const [patch, status, code] of [
    [{ pin: "9999" },401,"INVALID_SELLER_PIN"], [{ pin: "" },400,undefined],
    [{ expectedUserId: 99 },409,"SESSION_USER_CHANGED"], [{ expectedUserId: undefined },400,"INVALID_SESSION_RECOVERY"],
    [{ recoveryDraftId: undefined },400,"INVALID_SESSION_RECOVERY"], [{ recoveryDraftId: 0 },400,"INVALID_SESSION_RECOVERY"],
    [{ sedeId: 0 },400,"INVALID_SESSION_RECOVERY"],
  ]) {
    const f = await fixture(); const response = await f.route.POST(postRequest(body(patch)));
    assert.equal(response.status,status); if (code) assert.equal((await response.json()).code,code);
    assert.equal(f.cookies.length,0); assert.equal(f.mutations.length,0);
  }
});

test("POST conserva los rechazos por titularidad, vigencia, sede, aliado, perfil y asignación", async () => {
  for (const [sql, status] of [
    [`UPDATE "CreditoBorrador" SET "vendedorId"=18`,403], [`UPDATE "CreditoBorrador" SET "sedeId"=3`,403],
    [`UPDATE "CreditoBorrador" SET estado='CERRADO'`,403], [`UPDATE "CreditoBorrador" SET "expiresAt"=now()-interval '1 second'`,403],
    [`UPDATE "CreditoBorrador" SET "creditoId"=100`,403], [`UPDATE "Aliado" SET activo=false WHERE id=2`,403],
    [`UPDATE "Sede" SET activa=false WHERE id=2`,400], [`UPDATE "Vendedor" SET activo=false WHERE id=17`,404],
    [`UPDATE "SedeVendedor" SET activo=false`,404], [`UPDATE "Vendedor" SET "tipoPerfil"='ADMIN' WHERE id=17`,403],
  ]) {
    const f = await fixture(); await db.exec(sql);
    const response = await f.route.POST(postRequest(body()));
    assert.equal(response.status,status,sql); assert.equal(f.cookies.length,0); assert.equal(f.mutations.length,0);
  }
});

test("sesión base ausente o acceso desactivado nunca se restaura desde datos del formulario", async () => {
  for (const user of [null,{...baseUser,activo:false},{...baseUser,sedeAccesoActiva:false},{...baseUser,aliadoAccesoActivo:false},{...baseUser,rolNombre:"ADMIN"}]) {
    const f = await fixture({user});
    for (const response of [await f.route.GET(getRequest()),await f.route.POST(postRequest(body()))]) {
      assert.equal(response.status,user?403:401); assert.equal((await response.json()).code,user?"SESSION_RECOVERY_FORBIDDEN":"AUTH_REQUIRED");
    }
    assert.equal(f.cookies.length,0); assert.equal(f.mutations.length,0);
  }
});

test("el acceso normal y el PIN temporal siguen usando el mecanismo existente", async () => {
  const normal = await fixture();
  const response = await normal.route.POST(postRequest({vendedorId:17,pin:"4826",sedeId:2}));
  assert.equal(response.status,200); assert.equal((await response.json()).recovery,undefined);
  assert.equal(normal.cookies.length,1);
  const temporary = await fixture({temp:true});
  assert.equal((await temporary.route.POST(postRequest(body({pin:"8375"})))).status,200);
});

test("guardado y confirmación de IMEI distinguen sesión comercial ausente antes de leer o mutar el caso", async () => {
  const source = readFileSync(new URL('../app/api/creditos/borradores/route.ts',import.meta.url),'utf8');
  const post = source.slice(source.indexOf('export async function POST('),source.indexOf('export async function PATCH('));
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(post,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {module:loaded,exports:loaded.exports,NextResponse:JsonResponse,getAccess:async()=>({admin:false,central:false,user:baseUser,seller:null})});
  const blocked = await loaded.exports.POST({json:()=>{throw Error('Must not read body');}});
  assert.equal(blocked.status,403); assert.equal((await blocked.json()).code,'SELLER_SESSION_REQUIRED');
  let confirmations=0;
  const imeiRoute = loadApprovalModule('app/api/creditos/borradores/[id]/confirmar-imei/route.ts',{
    'next/server':{NextResponse:JsonResponse},'@/lib/auth':{getSessionUser:async()=>baseUser},
    '@/lib/aliados':{isFinserPayCentralAlly:()=>false},'@/lib/roles':{isAdminRole:()=>false},
    '@/lib/seller-auth':{getSellerSessionUser:async()=>null},'@/lib/solicitud-operation-access':operationAccess,
    '@/lib/credit-imei-confirmation':{},'@/lib/credit-imei-confirmation-storage':{confirmDraftImei:async()=>{confirmations++;}},
  });
  const denied = await imeiRoute.POST({json:()=>{throw Error('Must not read body');}},{params:Promise.resolve({id:'4276'})});
  assert.equal(denied.status,403); assert.equal((await denied.json()).code,'SELLER_SESSION_REQUIRED'); assert.equal(confirmations,0);
});
