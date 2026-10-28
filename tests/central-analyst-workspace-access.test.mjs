import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import test from "node:test";
import ts from "typescript";

function load(path, dependencies = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { module, exports: module.exports, Date, Buffer, Request, Response, URL,
    process: { env: { SESSION_SECRET: "isolated-workspace-session-secret-32-characters" } },
    require(name) {
      if (name === "node:crypto") return crypto;
      if (name === "server-only") return {};
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return module.exports;
}
const session = load("lib/session.ts");
const roles = load("lib/roles.ts");

function fixture({ role = "ADMIN", central = true, active = true, siteActive = true, allyActive = true } = {}) {
  const user = { id: role === "ADMIN" ? 82 : 17, nombre: "Cuenta personal", usuario: "cuenta.personal", activo: active,
    claveHash: "isolated-password-hash", updatedAt: new Date("2026-10-01T12:00:00.000Z"), sedeId: 1, rolId: 1,
    rol: { nombre: role }, sede: { id: 1, nombre: "Central", activa: siteActive, aliadoId: 1,
      aliado: { id: 1, codigo: central ? "FINSERPAY" : "ALIADO", nombre: "Finser", activo: allyActive } } };
  const cookies = new Map();
  const version = session.getSessionCredentialVersion(user.claveHash, user.updatedAt);
  const regular = session.createSessionToken(user.id, version);
  const analyst = session.createApprovalAnalystSessionToken(user.id, version);
  cookies.set(role === "ANALISTA_APROBACION" ? session.APPROVAL_ANALYST_SESSION_COOKIE_NAME : session.SESSION_COOKIE_NAME,
    role === "ANALISTA_APROBACION" ? analyst : regular);
  const auth = load("lib/auth.ts", {
    "next/headers": { cookies: async () => ({ get: key => ({ value: cookies.get(key) }) }) },
    "@/lib/session": session, "@/lib/roles": roles,
    "@/lib/aliados": { ensureAliadoSchema: async () => {}, ensureFinserPayCentralAdmin: async () => {} },
    "@/lib/prisma": { default: { usuario: { findUnique: async () => user } } },
  });
  return { auth, cookies, user, regular, analyst };
}

test("Admin Central entra con su usuario y el helper exclusivo del analista sigue cerrado", async () => {
  const f = fixture();
  const user = await f.auth.getNominalApprovalWorkspaceSessionUser();
  assert.equal(user.id, 82);
  assert.equal(user.rolNombre, "ADMIN");
  assert.equal(await f.auth.getNominalApprovalAnalystSessionUser(), null);
  assert.equal("claveHash" in user, false);
  assert.equal(f.cookies.size, 1, "Abrir el muro no crea sesiones ni suplanta cuentas");
});

test("analista nominal conserva identidad y permisos; no se convierte en administrador", async () => {
  const f = fixture({ role: "ANALISTA_APROBACION" });
  const user = await f.auth.getNominalApprovalWorkspaceSessionUser();
  assert.equal(user.id, 17);
  assert.equal(user.rolNombre, "ANALISTA_APROBACION");
  assert.equal(await f.auth.getSessionUser(), null);
});

test("perfiles aliados, vendedores e identidades inactivas no entran al muro central", async () => {
  for (const options of [{ central: false }, { role: "VENDEDOR" }, { role: "SUPERVISOR" },
    { active: false }, { siteActive: false }, { allyActive: false }, { role: "ANALISTA_APROBACION", central: false }]) {
    assert.equal(await fixture(options).auth.getNominalApprovalWorkspaceSessionUser(), null, JSON.stringify(options));
  }
});

test("cookies de enlaces o nominales inválidas nunca heredan una sesión administrativa", async () => {
  for (const cookie of [session.APPROVAL_SHARED_COOKIE_NAME, session.APPROVAL_ACCESS_COOKIE_NAME,
    session.APPROVAL_ANALYST_SESSION_COOKIE_NAME]) {
    const f = fixture();
    f.cookies.set(cookie, "expired-or-invalid-token");
    assert.equal(await f.auth.getNominalApprovalWorkspaceSessionUser(), null, cookie);
  }
  const f = fixture();
  f.cookies.set(session.APPROVAL_ANALYST_SESSION_COOKIE_NAME, f.analyst);
  assert.equal(await f.auth.getNominalApprovalWorkspaceSessionUser(), null, "Una cookie analista no sirve tras promoción a ADMIN");
  f.cookies.clear();
  f.cookies.set(session.APPROVAL_ACCESS_COOKIE_NAME, f.regular);
  assert.equal(await f.auth.getNominalApprovalWorkspaceSessionUser(), null);
});

test("la página protegida admite admin y rechaza contexto compartido incluso con cookie regular", async () => {
  for (const shared of [undefined, null, { kind: "SHARED_LINK" }]) {
    const f = fixture();
    const gate = load("app/dashboard/aprobaciones/approval-dashboard-access.ts", {
      "next/navigation": { redirect: location => { throw new Error("redirect:" + location); } },
      "@/lib/auth": f.auth,
      "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    });
    if (shared === undefined) assert.equal((await gate.requireNominalApprovalDashboardAccess()).id, 82);
    else await assert.rejects(gate.requireNominalApprovalDashboardAccess(), /redirect:/);
  }
});

test("las correcciones existentes reciben el ID real del administrador y no aceptan actor del cuerpo", async () => {
  const f = fixture();
  const calls = [];
  class CorrectionError extends Error {}
  const route = load("app/api/aprobaciones/solicitudes/[id]/datos/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": f.auth,
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => undefined },
    "@/lib/credit-approval-http": { readApprovalRequest: request => request.json(),
      approvalErrorResponse: error => { throw error; } },
    "@/lib/approval-request-correction-core": { RequestDataCorrectionError: CorrectionError,
      parseRequestDataCorrection: body => ({ values: body.values, reason: body.reason }) },
    "@/lib/firmaseguro-draft-dispatch-ledger": { DraftDispatchError: CorrectionError },
    "@/lib/approval-request-correction": { parseCorrectionDraftId: () => 7,
      getAnalystRequestCorrection: async () => ({}),
      correctAnalystRequestData: async (id, data, actor) => { calls.push({ id, data, actor }); return { revision: 1 }; } },
  });
  const response = await route.PATCH(new Request("https://finser.test/api/aprobaciones/solicitudes/D-7/datos", {
    method: "PATCH", body: JSON.stringify({ values: { clienteTelefono: "3101234567" }, reason: "Corrección autorizada",
      actor: { id: 999, nombre: "Actor externo" }, userId: 999 }),
  }), { params: Promise.resolve({ id: "D-7" }) });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor.id, 82);
  assert.equal(calls[0].actor.nombre, "Cuenta personal");
  assert.equal(calls[0].data.actor, undefined);
  assert.equal((await response.json()).item.revision, 1);
});

test("el proxy permite la sesión regular del admin en el Centro y todas sus operaciones existentes", () => {
  const { proxy } = load("proxy.ts", {
    "next/server": { NextResponse: { next: () => ({ kind: "next" }),
      redirect: () => ({ kind: "redirect" }), json: (_body, options) => ({ status: options.status }) } },
  });
  for (const path of ["centro", "", "cambio-imei", "enrolamiento", "firma-seguro", "sadmin", "liberar-consulta",
    "excepciones-mora", "gestion-cartera", "cartera-mora", "solicitudes"]
    .map(path => `/dashboard/aprobaciones${path ? "/" + path : ""}`)) {
    const url = new URL("https://finser.test" + path);
    assert.equal(proxy({ nextUrl: { pathname: path, clone: () => new URL(url) }, method: "GET",
      cookies: { get: key => key === session.SESSION_COOKIE_NAME ? { value: "signed-admin-session" } : undefined } }).kind, "next", path);
  }
});
