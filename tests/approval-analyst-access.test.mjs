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
const central = { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", activo: true };
const analyst = {
  ...central,
  rolNombre: "ANALISTA_APROBACION",
  sedeAccesoActiva: true,
  aliadoAccesoActivo: true,
};

function authFixture() {
  let user = {
    id: 7, nombre: "Analista de prueba", usuario: "analista.prueba", activo: true,
    claveHash: "isolated-password-hash", updatedAt: new Date("2026-09-09T10:00:00.000Z"),
    sedeId: 1, rolId: 4, rol: { nombre: "ANALISTA_APROBACION" },
    sede: {
      nombre: "Central", aliadoId: 1, activa: true,
      aliado: { id: 1, codigo: "FINSERPAY", nombre: "Finser", activo: true },
    },
  };
  const values = new Map();
  let operatingSedeReads = 0;
  let liveGrant = true;
  const token = () => session.createApprovalAnalystSessionToken(
    user.id,
    session.getSessionCredentialVersion(user.claveHash, user.updatedAt)
  );
  values.set(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME, token());
  const auth = load("lib/auth.ts", {
    "next/headers": { cookies: async () => ({ get: (name) => ({ value: values.get(name) }) }) },
    "@/lib/prisma": { default: {
      $queryRawUnsafe: async () => liveGrant ? [{ id: "11111111-1111-4111-8111-111111111111" }] : [],
      usuario: { findUnique: async () => user },
      sede: { findFirst: async () => { operatingSedeReads++; throw new Error("Analyst cannot select an operating sede"); } },
    } },
    "@/lib/session": session, "@/lib/roles": roles,
    "@/lib/aliados": { ensureAliadoSchema: async () => {}, ensureFinserPayCentralAdmin: async () => {} },
  });
  return { auth, values, token, revokeLink: () => { liveGrant = false; }, linkToken: () => session.createApprovalAccessSessionToken(user.id, session.getSessionCredentialVersion(user.claveHash, user.updatedAt), "11111111-1111-4111-8111-111111111111"), setUser: (value) => { user = { ...user, ...value }; }, operatingSedeReads: () => operatingSedeReads };
}

test("la capacidad de revisar exige perfil autorizado, cuenta activa y aliado central", () => {
  assert.equal(roles.canReviewCreditApprovals(analyst), true);
  assert.equal(roles.canReviewCreditApprovals(central), true);
  for (const user of [null, { ...analyst, activo: false }, { ...analyst, aliadoAccesoCodigo: "OTRO" },
    { ...analyst, sedeAccesoActiva: false }, { ...analyst, aliadoAccesoActivo: false },
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
  f.values.set(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME, f.token());
  assert.ok(await f.auth.getCreditApprovalSessionUser());
  f.setUser({ claveHash: "replacement-test-password-hash" });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
});

test("sesiones sin firma, sin version o de analista no central son rechazadas", async () => {
  const f = authFixture();
  f.values.set(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME, "forged.cookie");
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  f.values.set(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME, session.createSessionToken(7));
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  f.values.set(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME, f.token());
  f.setUser({ sede: { nombre: "Aliado", aliadoId: 2, activa: true, aliado: { codigo: "OTRO", activo: true } } });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
});

test("las herramientas nominales aceptan la cookie del analista y rechazan enlaces personales", async () => {
  const f = authFixture();
  assert.equal((await f.auth.getNominalApprovalAnalystSessionUser()).id, 7);

  f.values.delete(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME);
  f.values.set(session.APPROVAL_ACCESS_COOKIE_NAME, f.linkToken());
  assert.equal(await f.auth.getNominalApprovalAnalystSessionUser(), null);
  assert.equal((await f.auth.getCreditApprovalSessionUser()).id, 7);
});

test("la sede y el aliado deben seguir activos durante toda la sesion del analista", async () => {
  const f = authFixture();
  f.setUser({
    sede: { nombre: "Central", aliadoId: 1, activa: false, aliado: { codigo: "FINSERPAY", activo: true } },
  });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  f.setUser({
    sede: { nombre: "Central", aliadoId: 1, activa: true, aliado: { codigo: "FINSERPAY", activo: false } },
  });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
});

test("una sesion general nunca autentica una cuenta analista", async () => {
  const f = authFixture();
  f.values.delete(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME);
  f.values.set("session", session.createSessionToken(
    7,
    session.getSessionCredentialVersion("isolated-password-hash", new Date("2026-09-09T10:00:00.000Z"))
  ));
  assert.equal(await f.auth.getSessionUser({ allowApprovalAnalyst: true }), null);
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
  let transactions = 0;
  const prisma = {
    sede: { findFirst: async () => ({ id: 1 }), findMany: async () => [] },
    vendedor: { findMany: async () => [] },
    rol: { upsert: async (input) => { mutations.push(input); return { id: 4 }; } },
    usuario: {
      findMany: async () => [],
      create: async (input) => { mutations.push(input); return { id: 7 }; },
      updateMany: async (input) => { mutations.push(input); return { count: 1 }; },
    },
    $executeRawUnsafe: async (sql, ...params) => { mutations.push({ sql, params }); return 1; },
    ...overrides,
  };
  prisma.$transaction = async (work) => { transactions++; return work(prisma); };
  const accountAudit = load("lib/approval-analyst-account-audit.ts");
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
    "@/lib/approval-analyst-account-audit": accountAudit,
  });
  return { api, mutations, transactions: () => transactions };
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
  assert.equal(f.transactions(), 1);
  assert.match(f.mutations[2].sql, /INSERT INTO "ApprovalAnalystAccountEvent"/);
  assert.deepEqual(f.mutations[2].params, [7, 1, "CREATED", true]);
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
  assert.equal(f.transactions(), 1);
  assert.deepEqual(f.mutations[1].params, [7, 1, "DEACTIVATED", false]);
  const activate = accountApi();
  assert.equal((await activate.api.PATCH(request({ ...actionBody, activo: true }))).status, 200);
  assert.equal(activate.transactions(), 1);
  assert.deepEqual(activate.mutations[1].params, [7, 1, "ACTIVATED", true]);
  const reset = accountApi();
  assert.equal((await reset.api.PATCH(request({ ...actionBody, action: "RESET_PASSWORD", clave: "next-test-passphrase" }))).status, 200);
  assert.equal(reset.mutations[0].data.claveHash, "HASH:next-test-passphrase");
  assert.equal("activo" in reset.mutations[0].data, false);
  assert.equal(reset.transactions(), 1);
  assert.deepEqual(reset.mutations[1].params, [7, 1, "PASSWORD_RESET", null]);
});

test("una cuenta modificada o fuera del alcance devuelve conflicto y no éxito", async () => {
  const f = accountApi(central, { usuario: { updateMany: async () => ({ count: 0 }) } });
  assert.equal((await f.api.PATCH(request(actionBody))).status, 409);
  assert.equal(f.transactions(), 1);
  assert.equal(f.mutations.length, 0);
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
    sedeId: 1, sede: { activa: true, aliado: { codigo: "FINSERPAY", activo: true } }, activo: true, ...overrides,
  };
  const cookies = new Map();
  const api = load("app/api/login/route.ts", {
    "next/server": { NextResponse: { json(body, options) {
      const response = Response.json(body, options);
      response.cookies = {
        set: (name, value, options) => cookies.set(name, { value, options }),
        delete: (name) => cookies.delete(name),
      };
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
  assert.equal(payload.destination, "/dashboard/aprobaciones/centro");
  assert.equal("claveHash" in payload.usuario, false);
  assert.equal(f.cookies.get("session").value, "");
  const analystCookie = f.cookies.get(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME);
  const signed = session.verifyApprovalAnalystSessionToken(analystCookie.value);
  assert.equal(signed.credentialVersion, session.getSessionCredentialVersion(f.user.claveHash, f.user.updatedAt));
  assert.equal(analystCookie.options.maxAge, 8 * 60 * 60);
  assert.equal(f.cookies.get("seller_session").value, "");
});

test("el login rechaza analista externo, inactivo o con clave equivocada y conserva destino admin", async () => {
  const external = loginApi({ sede: { activa: true, aliado: { codigo: "OTRO", activo: true } } });
  assert.equal((await external.api.POST(request({ usuario: "analista", clave: "test-login-passphrase" }))).status, 403);
  assert.equal(external.cookies.size, 0);
  const inactive = loginApi({ activo: false });
  assert.equal((await inactive.api.POST(request({ usuario: "analista", clave: "test-login-passphrase" }))).status, 401);
  const invalid = loginApi();
  assert.equal((await invalid.api.POST(request({ usuario: "analista", clave: "wrong" }))).status, 401);
  const admin = loginApi({ rol: { nombre: "ADMIN" } });
  const response = await admin.api.POST(request({ usuario: "admin", clave: "test-login-passphrase" }));
  assert.equal((await response.json()).destination, "/dashboard");
  assert.ok(session.verifySessionToken(admin.cookies.get("session").value));
  assert.equal(admin.cookies.get(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME).value, "");
});

test("el login rechaza analistas con sede o aliado inactivo", async () => {
  const inactiveSite = loginApi({ sede: { activa: false, aliado: { codigo: "FINSERPAY", activo: true } } });
  assert.equal((await inactiveSite.api.POST(request({ usuario: "analista", clave: "test-login-passphrase" }))).status, 403);
  const inactiveAlly = loginApi({ sede: { activa: true, aliado: { codigo: "FINSERPAY", activo: false } } });
  assert.equal((await inactiveAlly.api.POST(request({ usuario: "analista", clave: "test-login-passphrase" }))).status, 403);
});

test("las sesiones de enlace quedan revocadas y no se convierten en sesiones de administrador", async () => {
  const f = authFixture();
  f.values.delete(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME);
  f.values.set(session.APPROVAL_ACCESS_COOKIE_NAME, f.linkToken());
  assert.equal(await f.auth.getSessionUser(), null);
  assert.equal((await f.auth.getCreditApprovalSessionUser()).id, 7);
  f.revokeLink();
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  const promoted = authFixture();
  promoted.values.delete(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME);
  promoted.values.set(session.APPROVAL_ACCESS_COOKIE_NAME, promoted.linkToken());
  promoted.setUser({ rol: { nombre: "ADMIN" } });
  assert.equal(await promoted.auth.getSessionUser(), null);
  assert.equal(await promoted.auth.getCreditApprovalSessionUser(), null);
});

test("el enlace dedicado válido abre el layout aunque quede una sesión normal obsoleta", async () => {
  const f = authFixture();
  f.values.delete(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME);
  f.values.set("session", "obsolete-cookie");
  f.values.set(session.APPROVAL_ACCESS_COOKIE_NAME, f.linkToken());
  assert.equal(await f.auth.getSessionUser(), null);
  const dashboard = load("lib/dashboard-access.ts", {
    "next/navigation": { redirect: () => { throw new Error("Unexpected redirect"); } },
    "@/lib/auth": f.auth, "@/lib/roles": roles,
    "@/lib/seller-auth": { getSellerSessionUser: async () => null },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
  });
  assert.equal((await dashboard.requireDashboardAccess({ allowApprovalAnalyst: true })).session.id, 7);
  f.revokeLink();
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
});

test("una cookie dedicada inválida nunca cambia silenciosamente al administrador normal", async () => {
  const f = authFixture();
  f.values.delete(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME);
  f.setUser({ rol: { nombre: "ADMIN" } });
  f.values.set("session", session.createSessionToken(7));
  f.values.set(session.APPROVAL_ACCESS_COOKIE_NAME, "revoked-or-invalid-link-session");
  assert.equal((await f.auth.getSessionUser()).rolNombre, "ADMIN");
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
});

test("la cookie nominal dura ocho horas y no puede reutilizarse como sesión general", () => {
  const token = session.createApprovalAnalystSessionToken(7, "credential-version");
  const payload = session.verifyApprovalAnalystSessionToken(token);
  assert.equal(payload.userId, 7);
  assert.equal(payload.credentialVersion, "credential-version");
  assert.ok(payload.exp - Math.floor(Date.now() / 1000) <= 8 * 60 * 60);
  assert.ok(payload.exp - Math.floor(Date.now() / 1000) > 8 * 60 * 60 - 5);
  assert.equal(session.verifySessionToken(token), null);
  assert.equal(session.verifyApprovalAnalystSessionToken(session.createSessionToken(7)), null);
});

test("la cookie nominal deja de servir si la cuenta deja de ser analista", async () => {
  const f = authFixture();
  f.setUser({ rol: { nombre: "ADMIN" } });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  assert.equal(await f.auth.getSessionUser(), null);
});

function proxyRequest(pathname, cookieValues = {}, method = "GET") {
  const nextUrl = {
    pathname,
    search: "?unsafe=1",
    clone() {
      return { pathname: this.pathname, search: this.search };
    },
  };
  return {
    method,
    nextUrl,
    cookies: { get: (name) => cookieValues[name] ? { value: cookieValues[name] } : undefined },
    headers: { get: () => null },
  };
}

const proxyModule = load("proxy.ts", {
  "next/server": { NextResponse: {
    next: () => ({ kind: "next" }),
    json: (body, options) => ({ kind: "json", body, status: options?.status ?? 200 }),
    redirect: (url) => ({ kind: "redirect", pathname: url.pathname, search: url.search }),
  } },
});

test("el proxy limita la cookie nominal al soporte autorizado, sesión y logout", () => {
  const accountCookie = { [session.APPROVAL_ANALYST_SESSION_COOKIE_NAME]: "signed-analyst-cookie" };
  for (const [path, method] of [
    ["/dashboard/aprobaciones", "GET"],
    ["/dashboard/aprobaciones/centro", "GET"],
    ["/dashboard/aprobaciones/centro/gestiones", "GET"],
    ["/dashboard/aprobaciones/cambio-imei", "GET"],
    ["/dashboard/aprobaciones/solicitudes/D-7", "GET"],
    ["/dashboard/aprobaciones/solicitudes/C-81", "GET"],
    ["/api/aprobaciones", "GET"],
    ["/api/aprobaciones/centro/buscar", "GET"],
    ["/api/aprobaciones/solicitudes/D-7/archivo/remision", "GET"],
    ["/api/aprobaciones/sadmin/7", "PATCH"],
    ["/api/solicitudes", "GET"],
    ["/api/solicitudes", "PATCH"],
    ["/api/creditos/datacredito/admin/liberaciones/buscar", "POST"],
    ["/api/creditos/datacredito/admin/evaluaciones/10000000-0000-4000-8000-000000000001/autorizar-reintento", "POST"],
    ["/api/session", "GET"],
    ["/api/login", "POST"],
    ["/api/logout", "POST"],
  ]) {
    assert.equal(proxyModule.proxy(proxyRequest(path, accountCookie, method)).kind, "next", path);
  }
  assert.equal(proxyModule.proxy(proxyRequest("/aliados", accountCookie)).kind, "next");
  for (const [path, method] of [
    ["/api/inventario-principal/buscar", "POST"],
    ["/api/clientes-admin", "POST"],
    ["/api/usuarios/admin", "POST"],
    ["/api/solicitudes", "POST"],
    ["/api/solicitudes", "DELETE"],
    ["/api/creditos", "POST"],
    ["/api/creditos/borradores", "POST"],
    ["/api/creditos/81/command", "POST"],
    ["/api/creditos/borradores/7/corregir-identidad", "PATCH"],
    ["/api/creditos/borradores/7/corregir-financiero", "PATCH"],
    ["/api/creditos/datacredito/admin/liberaciones/buscar", "GET"],
    ["/api/creditos/datacredito/admin/evaluaciones/no-es-uuid/autorizar-reintento", "POST"],
    ["/api/creditos/datacredito/admin/evaluaciones/10000000-0000-4000-8000-000000000001", "GET"],
  ]) {
    const response = proxyModule.proxy(proxyRequest(path, accountCookie, method));
    assert.equal(response.status, 403, path);
  }
  for (const path of ["/dashboard", "/dashboard/financiero", "/dashboard/deuda-sedes", "/dashboard/creditos"]) {
    const response = proxyModule.proxy(proxyRequest(path, accountCookie));
    assert.equal(response.kind, "redirect", path);
    assert.equal(response.pathname, "/dashboard/aprobaciones/centro", path);
    assert.equal(response.search, "", path);
  }
});

test("la sesión del analista no bloquea el portal público de clientes", () => {
  for (const cookieValue of ["signed-analyst-cookie", "expired-analyst-cookie"]) {
    const cookies = { [session.APPROVAL_ANALYST_SESSION_COOKIE_NAME]: cookieValue };
    for (const [path, method] of [
      ["/api/clientes/creditos", "GET"],
      ["/api/clientes/creditos/81/paz-y-salvo", "GET"],
      ["/api/clientes/creditos/81/abonos/7/recibo", "GET"],
      ["/api/clientes/wompi-checkout", "POST"],
      ["/api/clientes/wompi-status", "GET"],
      ["/api/clientes/efecty-liquidacion", "POST"],
      ["/api/clientes/fcm-token", "POST"],
    ]) {
      assert.equal(proxyModule.proxy(proxyRequest(path, cookies, method)).kind, "next", path);
    }
    assert.equal(proxyModule.proxy(proxyRequest("/api/creditos", cookies, "POST")).status, 403);
  }
});

test("una cuenta revocada puede volver al login sin quedar en un ciclo de redirecciones", async () => {
  const f = authFixture();
  f.setUser({ activo: false });
  assert.equal(await f.auth.getCreditApprovalSessionUser(), null);
  const accountCookie = { [session.APPROVAL_ANALYST_SESSION_COOKIE_NAME]: "stale-cookie" };
  assert.equal(proxyModule.proxy(proxyRequest("/api/login", accountCookie, "POST")).kind, "next");
  assert.equal(proxyModule.proxy(proxyRequest("/aliados", accountCookie)).kind, "next");
});

test("el proxy conserva la sesión general del administrador y la contingencia por enlace", () => {
  assert.equal(proxyModule.proxy(proxyRequest("/api/inventario-principal/buscar", { session: "admin" }, "POST")).kind, "next");
  assert.equal(proxyModule.proxy(proxyRequest("/dashboard/financiero", { session: "admin" })).kind, "next");
  assert.equal(proxyModule.proxy(proxyRequest("/api/aprobaciones", { approval_access_session: "legacy" })).kind, "next");
  assert.equal(proxyModule.proxy(proxyRequest("/dashboard/aprobaciones", { approval_access_session: "legacy" })).kind, "next");
});

function guardedLookupRoute(file, actor, result) {
  let queries = 0;
  const prisma = {
    inventarioPrincipal: { findUnique: async () => { queries++; return result; } },
    inventarioSede: { findFirst: async () => { queries++; return result; } },
  };
  const api = load(file, {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/prisma": { default: prisma },
    "@/lib/auth": { getSessionUser: async () => actor },
    "@/lib/roles": roles,
  });
  return { api, queries: () => queries };
}

test("las búsquedas de IMEI niegan al analista antes de consultar inventario", async () => {
  for (const file of ["app/api/inventario-principal/buscar/route.ts", "app/api/prestamos/buscar-imei/route.ts"]) {
    const unauthenticated = guardedLookupRoute(file, null, null);
    assert.equal((await unauthenticated.api.POST(request({ imei: "123" }))).status, 401, file);
    assert.equal(unauthenticated.queries(), 0, file);

    const denied = guardedLookupRoute(file, analyst, null);
    assert.equal((await denied.api.POST(request({ imei: "123" }))).status, 403, file);
    assert.equal(denied.queries(), 0, file);

    const allowed = guardedLookupRoute(file, central, { referencia: "IPHONE", color: "NEGRO", costo: 1 });
    assert.equal((await allowed.api.POST(request({ imei: "123" }))).status, 200, file);
    assert.equal(allowed.queries(), 1, file);
  }
});

test("financiero conserva su acceso por clave y deuda de sedes exige el guard administrativo", () => {
  const financial = readFileSync(new URL("../app/dashboard/financiero/layout.tsx", import.meta.url), "utf8");
  const siteDebt = readFileSync(new URL("../app/dashboard/deuda-sedes/layout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(financial, /requireAdminDashboardAccess/);
  assert.match(financial, /await getFinancialAccessState\(\)/);
  assert.match(financial, /<FinancialAccessGate/);
  assert.match(siteDebt, /await requireAdminDashboardAccess\(\)/);
});

test("logout elimina también la cookie nominal del analista", async () => {
  const deleted = new Map();
  const logout = load("app/api/logout/route.ts", {
    "next/headers": { cookies: async () => ({ get: () => undefined }) },
    "@/lib/prisma": { default: {} },
    "@/lib/approval-shared-access": { revokeSharedApprovalSession: async () => {} },
    "next/server": { NextResponse: { json(body, options) {
      const response = Response.json(body, options);
      response.cookies = {
        set: (name, value, cookieOptions) => deleted.set(name, { value, cookieOptions }),
        delete: () => {},
      };
      return response;
    } } },
    "@/lib/financial-access": { clearFinancialAccessCookie: () => {} },
    "@/lib/session": session,
  });
  assert.equal((await logout.POST()).status, 200);
  const cleared = deleted.get(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME);
  assert.equal(cleared.value, "");
  assert.equal(cleared.cookieOptions.maxAge, 0);
});
