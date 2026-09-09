import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import test from "node:test";
import ts from "typescript";

function load(file, dependencies = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL("../" + file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loadedModule = { exports: {} };
  runInNewContext(outputText, {
    module: loadedModule, exports: loadedModule.exports, Buffer, URL, Request, Response, Date,
    process: { env: { SESSION_SECRET: "isolated-test-session-secret-32-characters" } },
    console,
    require(name) {
      if (name === "node:crypto") return crypto;
      assert.ok(name in dependencies, "Unexpected dependency: " + name);
      return dependencies[name];
    },
  }, { filename: file });
  return loadedModule.exports;
}

const roles = load("lib/roles.ts");
const session = load("lib/session.ts");
const central = { rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", activo: true };
const analyst = { ...central, rolNombre: "ANALISTA_APROBACION" };

function authFixture() {
  let user = {
    id: 7, nombre: "Analista de prueba", usuario: "analista.prueba", activo: true,
    claveHash: "isolated-password-hash", updatedAt: new Date("2026-09-09T10:00:00.000Z"),
    sedeId: 1, rolId: 4, rol: { nombre: "ANALISTA_APROBACION" },
    sede: { nombre: "Central", aliadoId: 1, aliado: { id: 1, codigo: "FINSERPAY", nombre: "Finser" } },
  };
  const values = new Map();
  let operatingSedeReads = 0;
  const token = () => session.createSessionToken(user.id, session.getSessionCredentialVersion(user.claveHash, user.updatedAt));
  values.set("session", token());
  const auth = load("lib/auth.ts", {
    "next/headers": { cookies: async () => ({ get: (name) => ({ value: values.get(name) }) }) },
    "@/lib/prisma": { default: {
      usuario: { findUnique: async () => user },
      sede: { findFirst: async () => { operatingSedeReads++; throw new Error("Analyst cannot select an operating sede"); } },
    } },
    "@/lib/session": session, "@/lib/roles": roles,
    "@/lib/aliados": { ensureAliadoSchema: async () => {}, ensureFinserPayCentralAdmin: async () => {} },
  });
  return { auth, values, token, setUser: (value) => { user = { ...user, ...value }; }, operatingSedeReads: () => operatingSedeReads };
}

test("la capacidad de revisar exige perfil autorizado, cuenta activa y aliado central", () => {
  assert.equal(roles.canReviewCreditApprovals(analyst), true);
  assert.equal(roles.canReviewCreditApprovals(central), true);
  for (const user of [null, { ...analyst, activo: false }, { ...analyst, aliadoAccesoCodigo: "OTRO" },
    { ...central, aliadoAccesoCodigo: null }, { ...central, rolNombre: "SUPERVISOR" }]) {
    assert.equal(roles.canReviewCreditApprovals(user), false);
  }
  assert.equal(roles.isSellerRole(analyst.rolNombre), false);
  assert.equal(roles.canManageApprovalAnalysts(analyst), false);
  assert.equal(roles.canManageApprovalAnalysts(central), true);
});

test("la sesion analista falla cerrada para todos los consumidores operativos y permite el guard dedicado", async () => {
  const f = authFixture();
  assert.equal(await f.auth.getSessionUser(), null);
  assert.equal((await f.auth.getCreditApprovalSessionUser()).id, 7);
  const dto = await f.auth.getCreditApprovalSessionUser();
  assert.equal("claveHash" in dto, false);
  assert.equal("credentialVersion" in dto, false);
});

test("un perfil vendedor firmado no cambia el alcance ni habilita al analista", async () => {
  const f = authFixture();
  f.values.set("seller_session", session.createSellerSessionToken({ userId: 7, vendedorId: 22, sedeId: 99, accesoSedeId: 1 }));
  const dto = await f.auth.getCreditApprovalSessionUser();
  assert.equal(dto.sedeId, 1);
  assert.equal(dto.aliadoAccesoCodigo, "FINSERPAY");
  assert.equal(f.operatingSedeReads(), 0);
  const sellers = load("lib/seller-auth.ts", {
    "next/headers": { cookies: async () => { throw new Error("No debe leer la cookie vendedor"); } },
    "@/lib/prisma": { default: {} }, "@/lib/auth": f.auth, "@/lib/session": session,
    "@/lib/roles": roles, "@/lib/profile-avatars": {}, "@/lib/vendor-profile-schema": {},
  });
  assert.equal(await sellers.getSellerSessionUser(dto), null);
});

test("desactivar, restablecer clave o reactivar invalida sesiones analistas anteriores", async () => {
  const f = authFixture();
  f.setUser({ activo: false });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  f.setUser({ activo: true, updatedAt: new Date("2026-09-09T11:00:00.000Z") });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  f.values.set("session", f.token());
  assert.ok(await f.auth.getCreditApprovalSessionUser());
  f.setUser({ claveHash: "replacement-test-password-hash" });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
});

test("sesiones sin firma, sin version o de analista no central son rechazadas", async () => {
  const f = authFixture();
  f.values.set("session", "forged.cookie");
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  f.values.set("session", session.createSessionToken(7));
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  f.values.set("session", f.token());
  f.setUser({ sede: { nombre: "Aliado", aliadoId: 2, aliado: { codigo: "OTRO" } } });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
});

test("las sesiones administrativas existentes conservan acceso sin version de credencial", async () => {
  const f = authFixture();
  f.setUser({ rol: { nombre: "ADMIN" } });
  f.values.set("session", session.createSessionToken(7));
  assert.equal((await f.auth.getSessionUser()).rolNombre, "ADMIN");
});

function accountApi(actor = central, overrides = {}) {
  const mutations = [];
  const prisma = {
    sede: { findFirst: async () => ({ id: 1 }), findMany: async () => [] },
    vendedor: { findMany: async () => [] },
    rol: { upsert: async (input) => { mutations.push(input); return { id: 4 }; } },
    usuario: {
      findMany: async () => [],
      create: async (input) => { mutations.push(input); return { id: 7 }; },
      updateMany: async (input) => { mutations.push(input); return { count: 1 }; },
    },
    ...overrides,
  };
  prisma.$transaction = async (work) => work(prisma);
  const api = load("app/api/usuarios/admin/route.ts", {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/prisma": { default: prisma },
    "@/lib/auth": { getSessionUser: async () => actor },
    "@/lib/password": { hashPassword: (value) => "HASH:" + value },
    "@/lib/seller-auth": {},
    "@/lib/profile-avatars": { normalizarAvatarPerfil: () => "avatar", normalizarTipoPerfilVendedor: () => "VENDEDOR" },
    "@/lib/aliados": { isFinserPayCentralAlly: (value) => value === "FINSERPAY" },
    "@/lib/vendor-profile-schema": { ensureVendorProfileVisualColumns: async () => {} },
    "@/lib/user-profile-schema": { ensureUserProfileVisualColumns: async () => {} },
    "@/lib/roles": roles,
  });
  return { api, mutations };
}
const request = (body) => new Request("https://finser.test/api/usuarios/admin", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const createBody = { tipoPerfil: "ANALISTA_APROBACION", nombre: "Persona de prueba", usuario: "analista.prueba", clave: "test-passphrase", sedeId: 1 };
const actionBody = { tipoPerfil: "ANALISTA_APROBACION", analistaId: 7, action: "SET_ACTIVE", activo: false, expectedUpdatedAt: "2026-09-09T10:00:00.000Z" };

test("solo administrador central crea analistas; el API fija el rol y guarda hash", async () => {
  for (const actor of [analyst, { ...central, aliadoAccesoCodigo: "OTRO" }]) {
    const f = accountApi(actor);
    assert.equal((await f.api.POST(request(createBody))).status, 403);
    assert.equal(f.mutations.length, 0);
  }
  const f = accountApi();
  assert.equal((await f.api.POST(request(createBody))).status, 200);
  assert.equal(f.mutations[0].create.nombre, "ANALISTA_APROBACION");
  assert.equal(f.mutations[1].data.claveHash, "HASH:test-passphrase");
  assert.equal(f.mutations[1].data.rolId, 4);
});

test("no crea analistas en sedes externas ni acepta claves incompletas", async () => {
  const noSite = accountApi(central, { sede: { findFirst: async () => null } });
  assert.equal((await noSite.api.POST(request(createBody))).status, 400);
  assert.equal(noSite.mutations.length, 0);
  const short = accountApi();
  assert.equal((await short.api.POST(request({ ...createBody, clave: "1234" }))).status, 400);
  assert.equal(short.mutations.length, 0);
});

test("desactivar y reset exigen central, rol analista, sede central y version esperada", async () => {
  const denied = accountApi({ ...central, aliadoAccesoCodigo: "OTRO" });
  assert.equal((await denied.api.PATCH(request(actionBody))).status, 403);
  assert.equal(denied.mutations.length, 0);
  const f = accountApi();
  assert.equal((await f.api.PATCH(request(actionBody))).status, 200);
  assert.equal(f.mutations[0].where.rol.nombre, "ANALISTA_APROBACION");
  assert.equal(f.mutations[0].where.sede.aliado.codigo, "FINSERPAY");
  assert.equal(f.mutations[0].where.updatedAt.toISOString(), actionBody.expectedUpdatedAt);
  assert.equal(f.mutations[0].data.activo, false);
  const reset = accountApi();
  assert.equal((await reset.api.PATCH(request({ ...actionBody, action: "RESET_PASSWORD", clave: "next-test-passphrase" }))).status, 200);
  assert.equal(reset.mutations[0].data.claveHash, "HASH:next-test-passphrase");
  assert.equal("activo" in reset.mutations[0].data, false);
});

test("una cuenta modificada o fuera del alcance devuelve conflicto y no éxito", async () => {
  const f = accountApi(central, { usuario: { updateMany: async () => ({ count: 0 }) } });
  assert.equal((await f.api.PATCH(request(actionBody))).status, 409);
});


test("el guard de dashboard no abre modulos operativos al analista por heredar el layout", async () => {
  const f = authFixture();
  const access = load("lib/dashboard-access.ts", {
    "next/navigation": { redirect: (path) => { throw new Error("REDIRECT:" + path); } },
    "@/lib/auth": f.auth,
    "@/lib/seller-auth": { getSellerSessionUser: async () => { throw new Error("No debe abrir vendedor"); } },
    "@/lib/roles": roles, "@/lib/aliados": { isFinserPayCentralAlly: (value) => value === "FINSERPAY" },
  });
  assert.equal(await access.getDashboardAccess(), null);
  assert.equal((await access.getDashboardAccess({ allowApprovalAnalyst: true })).approvalAnalyst, true);
  await assert.rejects(access.requireAdminDashboardAccess(), /REDIRECT:/);
  await assert.rejects(access.requireAdminOrSupervisorDashboardAccess(), /REDIRECT:/);
});

function loginApi(overrides = {}) {
  const user = {
    id: 7, nombre: "Analista", usuario: "analista.prueba", claveHash: "test-hashed-password",
    updatedAt: new Date("2026-09-09T10:00:00.000Z"), rol: { nombre: "ANALISTA_APROBACION" },
    sedeId: 1, sede: { aliado: { codigo: "FINSERPAY" } }, activo: true, ...overrides,
  };
  const cookies = new Map();
  const api = load("app/api/login/route.ts", {
    "next/server": { NextResponse: { json(body, options) {
      const response = Response.json(body, options);
      response.cookies = { set: (name, value) => cookies.set(name, value), delete: (name) => cookies.delete(name) };
      return response;
    } } },
    "@/lib/prisma": { default: { usuario: { findUnique: async () => user } } },
    "@/lib/password": { verifyPassword: (value) => value === "test-login-passphrase", isPasswordHash: () => true },
    "@/lib/session": session, "@/lib/roles": roles,
  });
  return { api, user, cookies };
}

test("el login del analista devuelve destino acotado, cookie revocable y borra perfil vendedor", async () => {
  const f = loginApi();
  const response = await f.api.POST(request({ usuario: f.user.usuario, clave: "test-login-passphrase" }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.destination, "/dashboard/aprobaciones");
  assert.equal("claveHash" in payload.usuario, false);
  const signed = session.verifySessionToken(f.cookies.get("session"));
  assert.equal(signed.credentialVersion, session.getSessionCredentialVersion(f.user.claveHash, f.user.updatedAt));
  assert.equal(f.cookies.get("seller_session"), "");
});

test("el login rechaza analista externo, inactivo o con clave equivocada y conserva destino admin", async () => {
  const external = loginApi({ sede: { aliado: { codigo: "OTRO" } } });
  assert.equal((await external.api.POST(request({ usuario: "analista", clave: "test-login-passphrase" }))).status, 403);
  assert.equal(external.cookies.size, 0);
  const inactive = loginApi({ activo: false });
  assert.equal((await inactive.api.POST(request({ usuario: "analista", clave: "test-login-passphrase" }))).status, 401);
  const invalid = loginApi();
  assert.equal((await invalid.api.POST(request({ usuario: "analista", clave: "wrong" }))).status, 401);
  const admin = loginApi({ rol: { nombre: "ADMIN" } });
  const response = await admin.api.POST(request({ usuario: "admin", clave: "test-login-passphrase" }));
  assert.equal((await response.json()).destination, "/dashboard");
});
