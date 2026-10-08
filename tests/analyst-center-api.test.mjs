import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(path, dependencies = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { module, exports: module.exports, Date, Request, Response, URL,
    require(name) {
      if (name === "server-only") return {};
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return module.exports;
}

const errors = load("lib/credit-approval-errors.ts");
const roles = load("lib/roles.ts");
const operational = load("lib/approval-operations-read.ts", {
  "@/lib/prisma": { default: {} }, "@/lib/ally-payments-core": {},
  "@/lib/credit-amortization-contract": {}, "@/lib/firmaseguro-status": {},
  "@/lib/credit-device-replacement-remission": {}, "@/lib/approval-operations-core": {},
});
const plain = value => JSON.parse(JSON.stringify(value));
const paths = {
  search: "app/api/aprobaciones/centro/buscar/route.ts",
  detail: "app/api/aprobaciones/centro/expediente/[kind]/[id]/route.ts",
  management: "app/api/aprobaciones/centro/gestiones/route.ts",
};
const nominalCookie = "nominal-cookie";
const personalCookie = "personal-link";

function harness({ cookies = [nominalCookie], shared, active = true, role = "ANALISTA_APROBACION",
  siteActive = true, allyActive = true, allyCode = "FINSERPAY", expired = false, staleCredential = false,
  serviceError } = {}) {
  const calls = [];
  const auth = load("lib/auth.ts", {
    "next/headers": { cookies: async () => ({ get: name => cookies.includes(name) ? { value: name } : undefined }) },
    "@/lib/prisma": { default: {
      usuario: { findUnique: async () => ({ id: 17, nombre: "Analista QA", usuario: "analista", activo: active,
        claveHash: "version", updatedAt: new Date(), sedeId: 1, rolId: 8, rol: { id: 8, nombre: role },
        sede: { id: 1, nombre: "Central", activa: siteActive, aliadoId: 1,
          aliado: { id: 1, nombre: "FINSER PAY", codigo: allyCode, activo: allyActive } } }) },
      $queryRawUnsafe: async () => { calls.push(["personal-grant-read"]); return [{ id: "grant" }]; },
    } },
    "@/lib/session": {
      SELLER_SESSION_COOKIE_NAME: "seller", SESSION_COOKIE_NAME: "regular", APPROVAL_ANALYST_SESSION_COOKIE_NAME: nominalCookie,
      APPROVAL_ACCESS_COOKIE_NAME: personalCookie, getSessionCredentialVersion: () => "current",
      verifyApprovalAnalystSessionToken: value => value === nominalCookie && !expired
        ? { userId: 17, credentialVersion: staleCredential ? "old" : "current" } : null,
      verifySessionToken: value => value ? { userId: 17, credentialVersion: "current", approvalAccessGrantId: value === personalCookie ? "grant" : null } : null,
      verifySellerSessionToken: () => null,
    },
    "@/lib/roles": roles,
    "@/lib/aliados": { ensureAliadoSchema: async () => {}, ensureFinserPayCentralAdmin: async () => {} },
  });
  const http = load("lib/analyst-center-http.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": auth,
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    "@/lib/credit-approval-errors": errors, "@/lib/approval-operations-read": operational,
  });
  const dependencies = {
    "next/server": { NextResponse: Response }, "@/lib/analyst-center-http": http,
    "@/lib/analyst-center-read": {
      searchAnalystCenterCases: async q => {
        calls.push(["search", q]);
        if (serviceError) throw serviceError;
        operational.operationalSearchTerm(q);
        return [{ id: 31, document: "001234567890", numeroSadmin: "00003001", imei: "000123456789012" }];
      },
      getAnalystCenterCase: async (kind, id) => {
        calls.push(["detail", kind, id]);
        if (serviceError) throw serviceError;
        return { item: { id: 31, kind, numeroSadmin: null },
          welcome: { creditFinalized: false, available: false, reason: "Disponible cuando finalice la creación del crédito." } };
      },
    },
    "@/lib/analyst-center-history": { getAnalystCenterManagements: async (actor, input) => {
      calls.push(["history", actor, plain(input)]);
      if (serviceError) throw serviceError;
      return { ok: true, items: [], page: 2, pageSize: 10, total: 15, totalPages: 2 };
    } },
  };
  return { calls, auth, ...Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, load(path, dependencies)])) };
}

const request = query => new Request("https://finserpay.test/api/aprobaciones/centro/" + query);
const context = { params: Promise.resolve({ kind: "DRAFT", id: "31" }) };

test("centro acepta únicamente cuenta nominal central vigente; niega enlaces, otros roles y cuentas inactivas antes de leer datos", async () => {
  const scenarios = [
    {}, { cookies: [] }, { cookies: [personalCookie] }, { cookies: ["regular"], role: "ADMIN" },
    { role: "ADMIN" }, { role: "ADMIN_ALIADO" }, { role: "VENDEDOR" }, { active: false },
    { siteActive: false }, { allyActive: false }, { allyCode: "OTRO" }, { expired: true }, { staleCredential: true },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const api = harness(scenario);
    for (const [name, path] of [["search", "buscar?q=001234"], ["detail", "expediente/DRAFT/31"], ["management", "gestiones?page=2&pageSize=10"]]) {
      const response = await api[name].GET(request(path), context);
      assert.equal(response.status, index === 0 ? 200 : 401, `${name}: ${JSON.stringify(scenario)}`);
      assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
      assert.equal(response.headers.get("vary"), "Cookie");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
    if (index !== 0) assert.equal(api.calls.length, 0, "Un enlace no consulta siquiera su grant desde el nuevo Centro.");
  }
});

test("un contexto compartido activo, expirado o revocado nunca hereda la cuenta nominal", async () => {
  for (const shared of [null, { kind: "SHARED_LINK", id: null, nombre: "Compartido" }]) {
    const api = harness({ shared });
    for (const name of Object.keys(paths)) {
      const response = await api[name].GET(request("buscar?q=000"), context);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "SHARED_ACCESS");
    }
    assert.equal(api.calls.length, 0);
  }
});

test("gestiones usa actor de sesión y rechaza actor externo, duplicados y parámetros inesperados", async () => {
  const api = harness();
  const valid = await api.management.GET(request("gestiones?page=2&pageSize=10"));
  assert.equal(valid.status, 200);
  assert.deepEqual(api.calls, [["history", 17, { page: "2", pageSize: "10" }]]);
  api.calls.length = 0;
  for (const query of ["actorUserId=999", "userId=999", "actorId=999", "usuarioId=999", "page=1&page=2", "foo=bar"]) {
    assert.equal((await api.management.GET(request("gestiones?" + query))).status, 400);
  }
  assert.equal((await api.search.GET(request("buscar?q=000&q=001"))).status, 400);
  assert.equal((await api.detail.GET(request("expediente/DRAFT/31?actorUserId=999"), context)).status, 400);
  assert.equal(api.calls.length, 0);
});

test("búsqueda preserva ceros como texto, errores de búsqueda son 400 y fallos de lectura no aparentan un historial vacío", async () => {
  const api = harness();
  const response = await api.search.GET(request("buscar?q=00003001"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items[0].numeroSadmin, "00003001");
  assert.deepEqual(api.calls[0], ["search", "00003001"]);
  assert.equal((await api.search.GET(request("buscar?q=aa"))).status, 400);
  const failed = harness({ serviceError: new Error("PRIVATE DATABASE DETAIL") });
  for (const name of Object.keys(paths)) {
    const query = name === "search" ? "buscar?q=001234" : name === "detail" ? "expediente/DRAFT/31" : "gestiones";
    const failure = await failed[name].GET(request(query), context);
    assert.equal(failure.status, 503);
    assert.doesNotMatch(JSON.stringify(await failure.json()), /PRIVATE DATABASE/);
  }
});

test("las nuevas rutas solo exponen GET y no llaman proveedores ni lógica financiera", () => {
  for (const path of [...Object.values(paths), "lib/analyst-center-read.ts", "lib/analyst-center-history.ts"]) {
    const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|sendDaptaWelcome|ensure.*Schema|\$executeRaw|INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM/);
    assert.doesNotMatch(source, /montoCredito|valorCuota|saldoBaseFinanciado|calculateAmort/);
  }
  const api = harness();
  for (const name of Object.keys(paths)) for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    assert.equal(api[name][method], undefined);
  }
});
