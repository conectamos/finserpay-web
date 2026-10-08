import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { loadWelcomeModule, errors, actors, roles, reader, plain } from "./credit-approval-welcome-alerts-fixture.mjs";

const grantId = randomUUID();
const sharedSessionId = randomUUID();
const nominal = {
  id: 7, nombre: "Analista sintético", usuario: "analyst", activo: true,
  claveHash: "hash-1", updatedAt: "2026-09-01", sedeId: 10, rolId: 2,
  rol: { id: 2, nombre: "ANALISTA_APROBACION" },
  sede: { id: 10, nombre: "Central", activa: true, aliadoId: 10,
    aliado: { id: 10, nombre: "FINSER PAY", codigo: "FINSERPAY", activo: true } },
};
const summary = { pendingCount: 4, attentionCount: 2, fingerprint: "a".repeat(32) };

function harness(options = {}) {
  const mode = options.mode ?? "analyst";
  const events = [];
  const transactions = [];
  const cookieMap = new Map();
  if (mode === "analyst") cookieMap.set("analyst", options.token ?? "valid-analyst");
  if (mode === "admin" || mode === "seller" || mode === "ally-admin") cookieMap.set("session", "valid-regular");
  if (mode === "personal") cookieMap.set("access", options.token ?? "valid-personal");
  if (mode === "shared") cookieMap.set("shared", options.token ?? "valid-shared");
  if (options.regularAlongsideShared) cookieMap.set("session", "valid-regular");
  const cookies = async () => ({ get: name => cookieMap.has(name) ? { value: cookieMap.get(name) } : undefined });
  let user = structuredClone(nominal);
  if (["admin", "ally-admin"].includes(mode)) {
    user.id = 1;
    user.rol.nombre = "ADMIN";
  }
  if (mode === "seller") user.rol.nombre = "VENDEDOR";
  if (mode === "ally-admin") user.sede.aliado.codigo = "OTHER_ALLY";
  if (options.user) user = options.user(user);
  const session = {
    SESSION_COOKIE_NAME: "session", SELLER_SESSION_COOKIE_NAME: "seller",
    APPROVAL_ANALYST_SESSION_COOKIE_NAME: "analyst", APPROVAL_ACCESS_COOKIE_NAME: "access",
    APPROVAL_SHARED_COOKIE_NAME: "shared",
    verifyApprovalAnalystSessionToken: token => token === "valid-analyst" ? { userId: 7, credentialVersion: "hash-1:2026-09-01" } : null,
    verifySessionToken: token => token === "valid-regular" ? { userId: user.id }
      : token === "valid-personal" ? { userId: 7, credentialVersion: "hash-1:2026-09-01", approvalAccessGrantId: grantId } : null,
    verifySellerSessionToken: () => null,
    verifyApprovalSharedSessionToken: token => token === "valid-shared" ? { sessionId: sharedSessionId, grantId } : null,
    getSessionCredentialVersion: (hash, updatedAt) => `${hash}:${updatedAt}`,
  };
  const transactionDb = { $queryRawUnsafe: async sql => {
    if (sql.includes('"CreditApprovalSharedGrant"')) {
      events.push("shared-active-check");
      return options.revokedDuringTransaction ? [] : [{ id: sharedSessionId }];
    }
    if (sql.includes('SELECT "id" FROM "CreditApprovalPolicy"')) {
      events.push("policy");
      return options.missingPolicy ? [] : [{ id: 1 }];
    }
    assert.match(sql, /^WITH pending/);
    events.push("summary");
    if (options.readError) throw options.readError;
    return [summary];
  } };
  const prisma = {
    usuario: { findUnique: async () => { events.push("current-identity"); return user; } },
    sede: { findFirst: async () => assert.fail("No sesión operativa del vendedor en estas pruebas.") },
    $queryRawUnsafe: async sql => {
      if (sql.includes('"CreditApprovalAccessLink"')) {
        events.push("personal-grant");
        return options.revokedGrant ? [] : [{ id: grantId }];
      }
      assert.match(sql, /CreditApprovalSharedSession/);
      events.push("shared-session");
      return options.revokedGrant ? [] : [{ id: sharedSessionId }];
    },
    $transaction: async (callback, transactionOptions) => {
      events.push("transaction");
      transactions.push(transactionOptions);
      return callback(transactionDb);
    },
  };
  const auth = loadWelcomeModule("lib/auth.ts", {
    "next/headers": { cookies }, "@/lib/prisma": { default: prisma }, "@/lib/session": session,
    "@/lib/roles": roles,
    "@/lib/aliados": { ensureAliadoSchema: async () => {}, ensureFinserPayCentralAdmin: async () => {} },
  });
  const shared = loadWelcomeModule("lib/approval-shared-session.ts", {
    "next/headers": { cookies }, "@/lib/prisma": { default: prisma }, "@/lib/session": session,
  });
  const http = loadWelcomeModule("lib/credit-approval-http.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": auth, "@/lib/roles": roles,
    "@/lib/approval-shared-session": shared, "@/lib/credit-approval-actor": actors,
    "@/lib/credit-approval": errors,
  });
  const route = loadWelcomeModule("app/api/aprobaciones/bienvenidas-pendientes/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/prisma": { default: prisma },
    "@/lib/approval-welcome-alerts-read": reader,
    "@/lib/credit-approval-actor": actors, "@/lib/credit-approval-http": http,
  });
  return { route, events, transactions };
}
function privateResponse(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("GET nominal, central y enlaces anteriores leen solo un resumen global privado dentro de una instantánea", async t => {
  for (const mode of ["analyst", "admin", "personal", "shared"]) await t.test(mode, async () => {
    const f = harness({ mode });
    const response = await f.route.GET(new Request("https://test.invalid/api/aprobaciones/bienvenidas-pendientes?limit=1&q=nobody&aliado=nobody"));
    assert.equal(response.status, 200);
    privateResponse(response);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["attentionCount", "checkedAt", "fingerprint", "href", "ok", "pendingCount"]);
    assert.equal(body.ok, true);
    assert.equal(body.pendingCount, 4);
    assert.equal(body.attentionCount, 2);
    assert.equal(body.fingerprint, summary.fingerprint);
    assert.equal(body.href, "/dashboard/aprobaciones");
    assert.equal(new Date(body.checkedAt).toISOString(), body.checkedAt);
    assert.deepEqual(plain(f.transactions), [{ isolationLevel: "RepeatableRead", timeout: 10_000 }]);
    assert.deepEqual(f.events.slice(-2), ["policy", "summary"]);
    if (mode === "shared") assert.deepEqual(f.events, ["shared-session", "transaction", "shared-active-check", "policy", "summary"]);
  });
});

test("las credenciales ausentes, revocadas o con identidad cambiada no consultan ni revelan el resumen", async t => {
  const cases = [
    ["sin sesión", { mode: "none" }, 401],
    ["token nominal inválido", { token: "invalid" }, 401],
    ["contraseña restablecida", { user: user => ({ ...user, claveHash: "hash-reset" }) }, 401],
    ["cuenta desactivada", { user: user => ({ ...user, activo: false }) }, 401],
    ["rol modificado", { user: user => ({ ...user, rol: { ...user.rol, nombre: "ADMIN" } }) }, 401],
    ["sede desactivada", { user: user => ({ ...user, sede: { ...user.sede, activa: false } }) }, 401],
    ["central desactivada", { user: user => ({ ...user, sede: { ...user.sede, aliado: { ...user.sede.aliado, activo: false } } }) }, 401],
    ["vendedor", { mode: "seller" }, 401],
    ["administrador de aliado", { mode: "ally-admin" }, 401],
    ["enlace personal revocado", { mode: "personal", revokedGrant: true }, 401],
    ["enlace compartido inválido sin fallback administrativo", { mode: "shared", token: "invalid", regularAlongsideShared: true }, 401],
    ["enlace compartido revocado", { mode: "shared", revokedGrant: true }, 401],
  ];
  for (const [name, options, status] of cases) await t.test(name, async () => {
    const f = harness(options);
    const response = await f.route.GET();
    assert.equal(response.status, status);
    privateResponse(response);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "ok"]);
    assert.ok(!f.events.includes("policy"));
    assert.ok(!f.events.includes("summary"));
    assert.equal(f.transactions.length, 0);
  });
});

test("una revocación compartida detectada dentro de la transacción detiene la lectura", async () => {
  const f = harness({ mode: "shared", revokedDuringTransaction: true });
  const response = await f.route.GET();
  assert.equal(response.status, 401);
  privateResponse(response);
  assert.equal((await response.json()).code, "SHARED_ACCESS_REVOKED");
  assert.deepEqual(f.events, ["shared-session", "transaction", "shared-active-check"]);
});

test("la política ausente y los errores de consulta entregan 503 privado sin contadores inventados", async () => {
  for (const options of [{ missingPolicy: true }, { readError: new Error("synthetic database failure") }]) {
    const f = harness(options);
    const response = await f.route.GET();
    assert.equal(response.status, 503);
    privateResponse(response);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "APPROVAL_UNAVAILABLE");
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "ok"]);
    assert.doesNotMatch(body.error, /synthetic database failure/);
  }
});

test("el handler solo exporta GET y usa el contrato de métodos de Next para rechazar escrituras", () => {
  const route = harness().route;
  assert.equal(typeof route.GET, "function");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(route[method], undefined);
});
