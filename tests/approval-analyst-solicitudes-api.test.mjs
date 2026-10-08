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

function fixture({ nominal = analyst, user = null, changed = true } = {}) {
  const calls = [];
  const route = load("app/api/solicitudes/route.ts", {
    "next/server": {
      NextResponse: { json: (body, init) => Response.json(body, init) },
    },
    "@/lib/auth": {
      getSessionUser: async () => user,
      getNominalApprovalAnalystSessionUser: async () => nominal,
    },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
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
      desistSolicitudAsApprovalAnalyst: async input => {
        calls.push({ name: "desist-analyst", input });
        return { changed, identityReleased: changed };
      },
      desistSolicitudAsCentralAdmin: async input => {
        calls.push({ name: "desist-admin", input });
        return { changed: true, identityReleased: true };
      },
    },
  });
  return { route, calls };
}

test("el analista nominal consulta el muro global con su identidad nominal", async () => {
  const f = fixture();
  const response = await f.route.GET(new Request("https://finser.test/api/solicitudes?q=cliente"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  const call = f.calls.find(item => item.name === "list");
  assert.equal(call.input.viewer.kind, "APPROVAL_ANALYST");
  assert.equal(call.input.viewer.userId, analyst.id);
  assert.equal(call.input.viewer.aliadoId, null);
});

function desistRequest(body = { id: "D-7", action: "DESISTIR" }) {
  return new Request("https://finser.test/api/solicitudes", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("el analista nominal desiste solo el expediente seleccionado con su usuario en la auditoría", async () => {
  const f = fixture();
  const response = await f.route.PATCH(desistRequest());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(await response.json(), { ok: true, id: "D-7", estado: "CANCELADA", identityReleased: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, "desist-analyst");
  assert.equal(f.calls[0].input.solicitudId, 7);
  assert.equal(f.calls[0].input.userId, analyst.id);
});

test("el analista no desiste créditos convertidos ni acepta ids inválidos u otras acciones", async () => {
  for (const body of [
    { id: "C-7", action: "DESISTIR" }, { id: "D-0", action: "DESISTIR" },
    { id: "D-9007199254740992", action: "DESISTIR" }, { id: "D-7", action: "ELIMINAR" },
  ]) {
    const f = fixture();
    assert.equal((await f.route.PATCH(desistRequest(body))).status, 400);
    assert.equal(f.calls.length, 0);
  }
});

test("un cierre concurrente o un expediente no disponible devuelve conflicto", async () => {
  const f = fixture({ changed: false });
  const response = await f.route.PATCH(desistRequest());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "La solicitud ya no está disponible para desistir");
});

test("accesos compartidos y administradores de aliado no reciben permiso de desistimiento", async () => {
  for (const user of [{ id: 80, rolNombre: "ANALISTA_APROBACION" }, { id: 81, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO" }]) {
    const f = fixture({ nominal: null, user });
    const request = desistRequest();
    assert.equal((await f.route.PATCH(request)).status, 403);
    assert.equal(f.calls.length, 0);
  }
});

test("el administrador central conserva su flujo existente", async () => {
  const f = fixture({ nominal: null, user: { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" } });
  assert.equal((await f.route.PATCH(desistRequest())).status, 200);
  assert.equal(f.calls[0].name, "desist-admin");
  assert.equal(f.calls[0].input.userId, 1);
});

test("un acceso sin cuenta nominal no consulta solicitudes", async () => {
  const f = fixture({ nominal: null });
  const response = await f.route.GET(new Request("https://finser.test/api/solicitudes"));
  assert.equal(response.status, 401);
  assert.equal(f.calls.length, 0);
});
