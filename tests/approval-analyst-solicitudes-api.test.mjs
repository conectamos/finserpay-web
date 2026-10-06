import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(path, dependencies) {
  const loadedModule = { exports: {} };
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    module: loadedModule,
    exports: loadedModule.exports,
    URL,
    Request,
    Response,
    console,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return loadedModule.exports;
}

const analyst = {
  id: 17,
  nombre: "Analista soporte",
  rolNombre: "ANALISTA_APROBACION",
  aliadoAccesoCodigo: "FINSERPAY",
};

function fixture({ nominal = analyst } = {}) {
  const calls = [];
  const route = load("app/api/solicitudes/route.ts", {
    "next/server": {
      NextResponse: { json: (body, init) => Response.json(body, init) },
    },
    "@/lib/auth": {
      getSessionUser: async () => null,
      getNominalApprovalAnalystSessionUser: async () => nominal,
    },
    "@/lib/aliados": { isFinserPayCentralAlly: () => false },
    "@/lib/roles": { isAdminRole: () => false },
    "@/lib/seller-auth": { getSellerSessionUser: async () => null },
    "@/lib/solicitudes": {
      normalizeSolicitudFilters: params => ({ id: params.get("id") }),
    },
    "@/lib/solicitudes-storage": {
      listSolicitudes: async input => {
        calls.push({ name: "list", input });
        return { items: [], total: 0, page: 1, pageSize: 25 };
      },
      getSolicitudDetail: async input => {
        calls.push({ name: "detail", input });
        return { id: "D-7" };
      },
      desistSolicitud: async () => {
        calls.push({ name: "desist" });
        return { changed: true, identityReleased: true };
      },
      desistSolicitudAsCentralAdmin: async () => {
        calls.push({ name: "desist-admin" });
        return { changed: true, identityReleased: true };
      },
    },
  });
  return { route, calls };
}

test("el analista nominal consulta el muro global con un visor de solo lectura", async () => {
  const f = fixture();
  const response = await f.route.GET(new Request("https://finser.test/api/solicitudes?q=cliente"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  const call = f.calls.find(item => item.name === "list");
  assert.equal(call.input.viewer.kind, "APPROVAL_ANALYST");
  assert.equal(call.input.viewer.userId, analyst.id);
  assert.equal(call.input.viewer.aliadoId, null);
});

test("el analista no puede desistir y el API rechaza antes de leer el cuerpo", async () => {
  const f = fixture();
  const request = new Request("https://finser.test/api/solicitudes", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "D-7", action: "DESISTIR" }),
  });
  const response = await f.route.PATCH(request);
  assert.equal(response.status, 403);
  assert.equal(request.bodyUsed, false);
  assert.equal(f.calls.length, 0);
});

test("un acceso sin cuenta nominal no consulta solicitudes", async () => {
  const f = fixture({ nominal: null });
  const response = await f.route.GET(new Request("https://finser.test/api/solicitudes"));
  assert.equal(response.status, 401);
  assert.equal(f.calls.length, 0);
});
