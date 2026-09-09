import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";

function load(path, dependencies = {}) {
  const output = ts.transpileModule(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(output, { module: loadedModule, exports: loadedModule.exports, Buffer, URL, Date, Request, Response, TextDecoder,
    process: { env: { SESSION_SECRET: "approval-link-test-secret-not-production", NODE_ENV: "test" } },
    require(name) {
      if (name === "node:crypto") return crypto;
      if (name === "server-only") return {};
      assert.ok(name in dependencies, "Unexpected dependency " + name);
      return dependencies[name];
    },
  });
  return loadedModule.exports;
}
const session = load("lib/session.ts");
const roles = load("lib/roles.ts");
class CreditApprovalError extends Error {
  constructor(code, message, status = 400) { super(message); Object.assign(this, { code, status }); }
}
const errors = { CreditApprovalError, approvalCreditId: value => Number(value) };
const access = load("lib/approval-access.ts", { "@/lib/session": session, "@/lib/roles": roles, "@/lib/credit-approval": errors });
const grant = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const account = { id: 7, nombre: "Analista", activo: true, claveHash: "fixture-password-hash",
    updatedAt: new Date("2026-09-09T12:00:00Z"), rolNombre: "ANALISTA_APROBACION",
    aliadoCodigo: "FINSERPAY", sedeActiva: true, aliadoActivo: true };
  const state = { account, reads: 0, writes: [], link: null };
  const db = {
    async $queryRawUnsafe(sql) {
      state.reads++;
      if (sql.includes('FROM "Usuario"')) return state.account ? [state.account] : [];
      if (sql.includes('FROM "CreditApprovalAccessLink"')) return state.link ? [state.link] : [];
      throw Error("Unexpected SQL read");
    },
    async $executeRawUnsafe(sql, ...params) {
      state.writes.push({ sql, params });
      if (sql.includes('INSERT INTO "CreditApprovalAccessLink"')) state.link = { userId: params[0], id: params[1], credentialVersion: params[2], issuedByUserId: params[3], createdAt: new Date(), revokedAt: null };
      else if (sql.includes('UPDATE "CreditApprovalAccessLink"')) state.link.revokedAt ??= new Date();
      else throw Error("Unexpected SQL write");
      return 1;
    },
  };
  return { db, state };
}
const tokenFrom = payload => new URLSearchParams(new URL(payload.accessUrl).hash.slice(1)).get("acceso");

test("token personal verifica firma, propósito e identidad sin aceptar enlaces manipulados", () => {
  const token = session.createApprovalAccessToken(7, grant);
  assert.equal(session.verifyApprovalAccessToken(token).userId, 7);
  for (const value of [token.replace(".7.", ".8."), token + ".extra", token.slice(0, -1), "v1.7." + grant + ".inventado", session.createSessionToken(7), null, {}, "x".repeat(2000)]) {
    assert.equal(session.verifyApprovalAccessToken(value), null);
  }
  assert.equal(session.verifySessionToken(token), null);
  const payload = session.verifySessionToken(session.createApprovalAccessSessionToken(7, "credential", grant));
  assert.equal(payload.approvalAccessGrantId, grant);
  assert.ok(payload.exp <= Math.floor(Date.now() / 1000) + 8 * 3600);
});

test("generar y consultar produce el mismo enlace reutilizable; solo el UUID y versión se guardan", async () => {
  const f = fixture();
  assert.equal((await access.getApprovalAccessLink(f.db, 7, "https://finserpay.test")).accessUrl, null);
  const issued = await access.changeApprovalAccessLink(f.db, 7, 1, null, "https://finserpay.test");
  assert.equal(issued.active, true);
  const token = tokenFrom(issued);
  assert.equal((await access.getApprovalAccessLink(f.db, 7, "https://finserpay.test")).accessUrl, issued.accessUrl);
  assert.equal((await access.exchangeApprovalAccess(f.db, token)).userId, 7);
  assert.equal((await access.exchangeApprovalAccess(f.db, token)).grantId, issued.grantId);
  assert.equal(JSON.stringify(f.state.writes).includes(token), false);
});

test("revocar o rotar invalida el enlace anterior y una acción obsoleta no modifica el nuevo", async () => {
  const f = fixture();
  const first = await access.changeApprovalAccessLink(f.db, 7, 1, null, "https://finserpay.test");
  const rotated = await access.changeApprovalAccessLink(f.db, 7, 1, first.grantId, "https://finserpay.test");
  await assert.rejects(access.exchangeApprovalAccess(f.db, tokenFrom(first)), error => error.status === 401);
  await assert.rejects(access.changeApprovalAccessLink(f.db, 7, 1, first.grantId, "https://finserpay.test", true), error => error.code === "LINK_CHANGED");
  assert.equal((await access.exchangeApprovalAccess(f.db, tokenFrom(rotated))).userId, 7);
  const revoked = await access.changeApprovalAccessLink(f.db, 7, 1, rotated.grantId, "https://finserpay.test", true);
  assert.equal(revoked.active, false);
  assert.equal(revoked.accessUrl, null);
  await assert.rejects(access.exchangeApprovalAccess(f.db, tokenFrom(rotated)), error => error.status === 401);
});

test("desactivación, cambio de clave, rol o sede no permiten canjear el enlace", async () => {
  for (const change of [{ activo: false }, { claveHash: "new" }, { updatedAt: new Date() }, { rolNombre: "ADMIN" }, { aliadoCodigo: "OTRO" }, { sedeActiva: false }, { aliadoActivo: false }]) {
    const f = fixture();
    const issued = await access.changeApprovalAccessLink(f.db, 7, 1, null, "https://finserpay.test");
    Object.assign(f.state.account, change);
    await assert.rejects(access.exchangeApprovalAccess(f.db, tokenFrom(issued)), error => error.status === 401);
  }
});

test("tokens inventados no consultan la base; entradas de mutación se validan estrictamente", async () => {
  const f = fixture();
  await assert.rejects(access.exchangeApprovalAccess(f.db, "inventado"), error => error.status === 401);
  assert.equal(f.state.reads, 0);
  for (const body of [null, [], {}, { expectedGrantId: "invalid" }, { expectedGrantId: grant, userId: 9 }]) assert.throws(() => access.parseApprovalLinkMutation(body));
  assert.equal(access.parseApprovalLinkMutation({ expectedGrantId: null }), null);
  assert.throws(() => access.parseApprovalLinkMutation({ expectedGrantId: null }, true));
});

function apiHarness(actor = { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" }) {
  const f = fixture();
  let transactions = 0;
  const cookies = [];
  const NextResponse = { json(body, options) {
    const response = Response.json(body, options);
    response.cookies = { set: (...args) => cookies.push(args), delete: (...args) => cookies.push(args) };
    return response;
  } };
  const http = load("lib/credit-approval-http.ts", { "next/server": { NextResponse }, "@/lib/auth": {}, "@/lib/roles": roles, "@/lib/credit-approval": errors });
  const dependencies = { "next/server": { NextResponse }, "@/lib/prisma": { default: { $transaction: async callback => { transactions++; return callback(f.db); } } },
    "@/lib/auth": { getSessionUser: async () => actor }, "@/lib/roles": roles, "@/lib/credit-approval": errors,
    "@/lib/credit-approval-http": http, "@/lib/approval-access": access, "@/lib/session": session };
  return { ...f, cookies, transactions: () => transactions,
    admin: load("app/api/usuarios/analistas/[id]/enlace/route.ts", dependencies),
    public: load("app/api/public/approval-access/route.ts", dependencies) };
}
const request = (path, method = "GET", body, origin = "https://finserpay.test") => new Request("https://finserpay.test" + path, {
  method, headers: { host: "finserpay.test", ...(origin ? { origin } : {}), "content-type": "application/json", "sec-fetch-site": "same-origin" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const context = () => ({ params: Promise.resolve({ id: "7" }) });

test("solo el administrador central puede consultar, generar o revocar enlaces", async () => {
  for (const actor of [null, { id: 2, rolNombre: "ADMIN", aliadoAccesoCodigo: "OTRO" }, { id: 7, rolNombre: "ANALISTA_APROBACION", aliadoAccesoCodigo: "FINSERPAY" }]) {
    const api = apiHarness(actor);
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await api.admin[method](request("/api/usuarios/analistas/7/enlace", method, method === "GET" ? undefined : { expectedGrantId: grant }), context());
      assert.equal(response.status, actor ? 403 : 401);
    }
    assert.equal(api.transactions(), 0);
  }
});

test("el canje fija cookie dedicada de 8 horas y no sobrescribe el login administrativo", async () => {
  const api = apiHarness();
  const issued = await api.admin.POST(request("/api/usuarios/analistas/7/enlace", "POST", { expectedGrantId: null }), context());
  assert.equal(issued.status, 200);
  const token = tokenFrom(await issued.json());
  const opened = await api.public.POST(request("/api/public/approval-access", "POST", { token }));
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).destination, "/dashboard/aprobaciones");
  assert.equal(api.cookies.length, 1);
  assert.equal(api.cookies[0][0], session.APPROVAL_ACCESS_COOKIE_NAME);
  assert.equal(api.cookies[0][2].maxAge, 8 * 3600);
  assert.equal(api.cookies[0][2].httpOnly, true);
  assert.match(opened.headers.get("cache-control"), /no-store/);
});

test("el canje rechaza CSRF, ausencia de origen y token falso antes de tocar la base", async () => {
  for (const origin of ["https://attacker.test", null, "null"]) {
    const api = apiHarness();
    const response = await api.public.POST(request("/api/public/approval-access", "POST", { token: session.createApprovalAccessToken(7, grant) }, origin));
    assert.equal(response.status, 403);
    assert.equal(api.transactions(), 0);
    assert.equal(api.cookies.length, 0);
  }
  const api = apiHarness();
  assert.equal((await api.public.POST(request("/api/public/approval-access", "POST", { token: "false" }))).status, 401);
  assert.equal(api.transactions(), 0);
});
