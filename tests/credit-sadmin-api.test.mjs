import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(path, dependencies = {}) {
  const loadedModule = { exports: {} };
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    module: loadedModule, exports: loadedModule.exports, URL, Request, Response, Uint8Array, TextDecoder, console,
    require(name) {
      if (name === "server-only") return {};
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return loadedModule.exports;
}

const errors = load("lib/credit-approval-errors.ts");
const actors = load("lib/credit-approval-actor.ts");
const roles = load("lib/roles.ts");
const centralAnalyst = {
  id: 17, nombre: "Analista de prueba", activo: true,
  rolNombre: "ANALISTA_APROBACION", aliadoAccesoCodigo: "FINSERPAY",
};
const sharedActor = {
  kind: "SHARED_LINK", id: null, nombre: "Acceso compartido",
  grantId: "10000000-0000-4000-8000-000000000001",
  sessionId: "20000000-0000-4000-8000-000000000002",
};
const clone = value => JSON.parse(JSON.stringify(value));

function setup({ user = centralAnalyst, shared, serviceError } = {}) {
  const calls = [];
  const prisma = {};
  const http = load("lib/credit-approval-http.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/auth": { getCreditApprovalSessionUser: async () => { calls.push({ name: "user" }); return user; } },
    "@/lib/roles": roles,
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => { calls.push({ name: "shared" }); return shared; } },
    "@/lib/credit-approval-actor": actors,
    "@/lib/credit-approval": errors,
  });
  const service = {
    listSadminCredits: async (...args) => {
      calls.push({ name: "list", args });
      if (serviceError) throw serviceError;
      return {
        items: [{ id: 712, folio: "FC-HISTORICO" }],
        page: 2,
        pageSize: 20,
        total: 21,
        totalPages: 2,
        counts: { all: 41, pending: 20, created: 21 },
      };
    },
    updateSadminRegistration: async (...args) => {
      calls.push({ name: "update", args });
      if (serviceError) throw serviceError;
      return { version: 2, numeroCredito: "000123-A", status: "CREADO_SADMIN" };
    },
  };
  const dependencies = {
    "next/server": { NextResponse: Response },
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-approval-http": http,
    "@/lib/credit-approval": { ...errors, approvalCreditId: Number },
    "@/lib/credit-sadmin": service,
  };
  return {
    calls, prisma,
    list: load("app/api/aprobaciones/sadmin/route.ts", dependencies),
    update: load("app/api/aprobaciones/sadmin/[id]/route.ts", dependencies),
  };
}

const context = { params: Promise.resolve({ id: "712" }) };
const request = (body = { version: 1, field: "codeudorCreado", value: true }, headers = {}) => new Request("https://finserpay.test/api/aprobaciones/sadmin/712", {
  method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "content-type": "application/json", origin: "https://finserpay.test", ...headers },
});
const listRequest = (status = "created") => new Request(`https://finserpay.test/api/aprobaciones/sadmin?page=3&q=Cliente%20hist%C3%B3rico&status=${status}`);
function privateResponse(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("SADMIN niega usuarios sin acceso antes de leer o actualizar datos", async t => {
  const cases = [
    ["sin sesión", null, 401],
    ["vendedor central", { ...centralAnalyst, rolNombre: "VENDEDOR" }, 403],
    ["administrador de aliado", { ...centralAnalyst, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO" }, 403],
    ["analista de aliado", { ...centralAnalyst, aliadoAccesoCodigo: "ALIADO" }, 403],
    ["analista inactivo", { ...centralAnalyst, activo: false }, 403],
  ];
  for (const [name, user, status] of cases) await t.test(name, async () => {
    const api = setup({ user });
    const incoming = request();
    for (const response of [await api.list.GET(listRequest()), await api.update.PATCH(incoming, context)]) {
      assert.equal(response.status, status);
      privateResponse(response);
      assert.equal((await response.json()).ok, false);
    }
    assert.equal(incoming.bodyUsed, false);
    assert.equal(api.calls.some(call => ["list", "update"].includes(call.name)), false);
  });
});

test("un enlace revocado no usa como respaldo una cuenta administrativa abierta", async () => {
  const api = setup({ user: { ...centralAnalyst, rolNombre: "ADMIN" }, shared: null });
  const incoming = request();
  for (const response of [await api.list.GET(listRequest()), await api.update.PATCH(incoming, context)]) {
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "SHARED_ACCESS_REVOKED");
    privateResponse(response);
  }
  assert.deepEqual(api.calls.map(call => call.name), ["shared", "shared"]);
  assert.equal(incoming.bodyUsed, false);
});

test("la lista pasa página, búsqueda y estado al servicio con actor personal o compartido", async () => {
  for (const shared of [undefined, sharedActor]) {
    const api = setup({ shared });
    const response = await api.list.GET(listRequest());
    assert.equal(response.status, 200);
    privateResponse(response);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.items[0].id, 712);
    assert.equal(body.pageSize, 20);
    assert.deepEqual(clone(body.counts), { all: 41, pending: 20, created: 21 });
    const call = api.calls.find(item => item.name === "list");
    assert.equal(call.args[0], api.prisma);
    assert.deepEqual(clone(call.args[1]), shared || { id: centralAnalyst.id, nombre: centralAnalyst.nombre });
    assert.deepEqual(clone(call.args[2]), { page: "3", q: "Cliente histórico", status: "created" });
    if (shared) assert.equal(api.calls.some(item => item.name === "user"), false);
  }
});

test("la lista conserva el error de estado SADMIN inválido y no lo convierte en un fallo interno", async () => {
  const invalid = new errors.CreditApprovalError("INVALID_SADMIN_STATUS", "Selecciona un estado SADMIN válido.", 400);
  const api = setup({ serviceError: invalid });
  const response = await api.list.GET(listRequest("desconocido"));
  assert.equal(response.status, 400);
  privateResponse(response);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "INVALID_SADMIN_STATUS");
  const call = api.calls.find(item => item.name === "list");
  assert.equal(call.args[2].status, "desconocido");
});

test("PATCH conserva cada marca y el número SADMIN textual con ceros y letras", async () => {
  for (const shared of [undefined, sharedActor]) for (const [field, value] of [
    ["codeudorCreado", true], ["creditoCreado", false], ["numeroCreditoConfirmado", true], ["numeroCredito", "000123-A"],
  ]) {
    const api = setup({ shared });
    const input = { version: 1, field, value };
    const response = await api.update.PATCH(request(input), context);
    assert.equal(response.status, 200);
    privateResponse(response);
    assert.equal((await response.json()).ok, true);
    const call = api.calls.find(item => item.name === "update");
    assert.equal(call.args[0], api.prisma);
    assert.deepEqual(clone(call.args[1]), shared || { id: centralAnalyst.id, nombre: centralAnalyst.nombre });
    assert.equal(call.args[2], "712");
    assert.deepEqual(clone(call.args[3]), input);
  }
});

test("PATCH bloquea otros orígenes y Fetch Metadata cruzado antes de consumir el cuerpo", async () => {
  for (const headers of [
    { origin: "https://hostil.test" },
    { "sec-fetch-site": "cross-site" },
    { origin: "null" },
  ]) {
    const api = setup({ shared: sharedActor });
    const incoming = request(undefined, headers);
    const response = await api.update.PATCH(incoming, context);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "INVALID_ORIGIN");
    privateResponse(response);
    assert.equal(incoming.bodyUsed, false);
    assert.equal(api.calls.some(call => call.name === "update"), false);
  }
});

test("PATCH rechaza JSON inválido y cuerpos extensos antes de llamar al servicio", async () => {
  for (const incoming of [
    request("{json roto"),
    request({ version: 1, field: "numeroCredito", value: "x".repeat(20000) }),
    request(undefined, { "content-length": "20000" }),
  ]) {
    const api = setup();
    const response = await api.update.PATCH(incoming, context);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
    privateResponse(response);
    assert.equal(api.calls.some(call => call.name === "update"), false);
  }
});

test("errores de revocación durante la operación y versiones obsoletas conservan su estado HTTP", async () => {
  for (const error of [new actors.ApprovalActorAccessError(), new errors.CreditApprovalError("SADMIN_CHANGED", "Actualiza el registro.", 409)]) {
    const api = setup({ shared: sharedActor, serviceError: error });
    for (const response of [await api.list.GET(listRequest()), await api.update.PATCH(request(), context)]) {
      assert.equal(response.status, error.status);
      assert.equal((await response.json()).code, error.code);
      privateResponse(response);
    }
  }
});

test("un fallo inesperado no expone detalles internos y tampoco se almacena en caché", async () => {
  const api = setup({ serviceError: new Error("password=synthetic-private-detail") });
  for (const response of [await api.list.GET(listRequest()), await api.update.PATCH(request(), context)]) {
    assert.equal(response.status, 503);
    privateResponse(response);
    assert.doesNotMatch(await response.text(), /synthetic-private-detail|password=/);
  }
});
