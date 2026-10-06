import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(path, dependencies) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = { exports: {} };
  runInNewContext(compiled, {
    module: loadedModule,
    exports: loadedModule.exports,
    Response,
    console,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return loadedModule.exports;
}

const analyst = { id: 17, nombre: "Analista QA", rolNombre: "ANALISTA_APROBACION" };

function fixture({ nominal = analyst, shared, rows = [{ nombre: "Aliado Uno" }, { nombre: "Aliado Dos" }] } = {}) {
  const queries = [];
  class CreditApprovalError extends Error {
    constructor(code, message, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  const privateHeaders = { "Cache-Control": "private, no-store" };
  const route = load("app/api/aprobaciones/aliados/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/prisma": { default: { $queryRawUnsafe: async (sql) => { queries.push(sql); return rows; } } },
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    "@/lib/auth": { getNominalApprovalAnalystSessionUser: async () => nominal },
    "@/lib/credit-approval-errors": { CreditApprovalError },
    "@/lib/credit-approval-http": {
      approvalPrivateHeaders: privateHeaders,
      approvalErrorResponse: (error) => Response.json({ ok: false, error: error.message }, { status: error.status || 500, headers: privateHeaders }),
    },
    "@/lib/credit-approval-queue": { buildCreditApprovalQueueScopeSql: () => "credit_scope = TRUE" },
  });
  return { route, queries };
}

test("el catálogo nominal devuelve únicamente nombres del alcance de aprobaciones", async () => {
  const f = fixture();
  const response = await f.route.GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual((await response.json()).items, ["Aliado Uno", "Aliado Dos"]);
  assert.equal(f.queries.length, 1);
  assert.match(f.queries[0], /credit_scope = TRUE/);
  assert.match(f.queries[0], /FINSERPAY/);
  assert.doesNotMatch(f.queries[0], /clienteDocumento|clienteNombre|imei/i);
});

test("sin cuenta nominal no consulta aliados", async () => {
  const f = fixture({ nominal: null });
  const response = await f.route.GET();
  assert.equal(response.status, 401);
  assert.equal(f.queries.length, 0);
});

test("un contexto compartido no reutiliza el catálogo nominal", async () => {
  const f = fixture({ shared: { kind: "SHARED_LINK" } });
  const response = await f.route.GET();
  assert.equal(response.status, 403);
  assert.equal(f.queries.length, 0);
});
