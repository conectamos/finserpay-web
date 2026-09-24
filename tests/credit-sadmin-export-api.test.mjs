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
    module: loadedModule,
    exports: loadedModule.exports,
    URL,
    Request,
    Response,
    Uint8Array,
    Date,
    console,
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
  id: 17,
  nombre: "Analista de prueba",
  activo: true,
  rolNombre: "ANALISTA_APROBACION",
  aliadoAccesoCodigo: "FINSERPAY",
};
const sharedActor = {
  kind: "SHARED_LINK",
  id: null,
  nombre: "Acceso compartido",
  grantId: "10000000-0000-4000-8000-000000000001",
  sessionId: "20000000-0000-4000-8000-000000000002",
};
const clone = value => JSON.parse(JSON.stringify(value));
const xlsxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x53, 0x41, 0x44, 0x4d, 0x49, 0x4e]);
const exportResult = { items: [{ id: 712, folio: "FC-HISTORICO" }], status: "created" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup({ user = centralAnalyst, shared, serviceError, workbookError, exportImpl, writeBufferImpl } = {}) {
  const calls = [];
  const prisma = {};
  const http = load("lib/credit-approval-http.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/auth": {
      getCreditApprovalSessionUser: async () => {
        calls.push({ name: "user" });
        return user;
      },
    },
    "@/lib/roles": roles,
    "@/lib/approval-shared-session": {
      getApprovalSharedRequestActor: async () => {
        calls.push({ name: "shared" });
        return shared;
      },
    },
    "@/lib/credit-approval-actor": actors,
    "@/lib/credit-approval": errors,
  });
  const service = {
    exportSadminCredits: async (...args) => {
      calls.push({ name: "export", args });
      if (serviceError) throw serviceError;
      return exportImpl ? exportImpl(...args) : exportResult;
    },
  };
  const excel = {
    buildSadminWorkbook: items => {
      calls.push({ name: "workbook", items });
      return {
        xlsx: {
          writeBuffer: async () => {
            calls.push({ name: "write" });
            if (workbookError) throw workbookError;
            return writeBufferImpl ? writeBufferImpl() : xlsxBytes;
          },
        },
      };
    },
  };
  const route = load("app/api/aprobaciones/sadmin/export/route.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-sadmin": service,
    "@/lib/credit-sadmin-excel": excel,
    "@/lib/credit-approval-http": http,
    "@/lib/credit-approval-errors": errors,
  });
  return { route, calls, prisma };
}

const request = (status = "created") => new Request(
  `https://finserpay.test/api/aprobaciones/sadmin/export?q=Cliente%20hist%C3%B3rico&status=${status}`,
);

function privateResponse(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("exporta un XLSX con búsqueda, estado, actor y encabezados privados", async () => {
  for (const shared of [undefined, sharedActor]) {
    const api = setup({ shared });
    const response = await api.route.GET(request());
    assert.equal(response.status, 200);
    privateResponse(response);
    assert.equal(
      response.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    assert.match(
      response.headers.get("content-disposition"),
      /^attachment; filename="creacion-sadmin-creados-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), xlsxBytes);

    const call = api.calls.find(item => item.name === "export");
    assert.equal(call.args[0], api.prisma);
    assert.deepEqual(clone(call.args[1]), shared || { id: centralAnalyst.id, nombre: centralAnalyst.nombre });
    assert.deepEqual(clone(call.args[2]), { q: "Cliente histórico", status: "created" });
    assert.deepEqual(api.calls.find(item => item.name === "workbook").items, [{ id: 712, folio: "FC-HISTORICO" }]);
    assert.equal(api.calls.filter(item => item.name === "write").length, 1);
    if (shared) assert.equal(api.calls.some(item => item.name === "user"), false);
  }
});

test("solo genera un XLSX por proceso, responde 429 al segundo y libera el turno al terminar", async () => {
  const entered = deferred();
  const release = deferred();
  let writes = 0;
  const api = setup({
    writeBufferImpl: async () => {
      writes++;
      if (writes === 1) {
        entered.resolve();
        await release.promise;
      }
      return xlsxBytes;
    },
  });

  const firstPromise = api.route.GET(request());
  await entered.promise;

  const busy = await api.route.GET(request("pending"));
  assert.equal(busy.status, 429);
  privateResponse(busy);
  assert.deepEqual(clone(await busy.json()), {
    ok: false,
    error: "Ya se está generando otra exportación de SADMIN. Espera a que termine e intenta de nuevo.",
    code: "SADMIN_EXPORT_BUSY",
  });
  assert.equal(api.calls.filter(call => call.name === "user").length, 2, "el segundo intento debe autenticarse antes del 429");
  for (const name of ["export", "workbook", "write"]) {
    assert.equal(api.calls.filter(call => call.name === name).length, 1, `${name} no debe ejecutarse para el segundo intento`);
  }

  release.resolve();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  const afterSuccess = await api.route.GET(request());
  assert.equal(afterSuccess.status, 200);
  assert.equal(api.calls.filter(call => call.name === "export").length, 2);
  assert.equal(api.calls.filter(call => call.name === "write").length, 2);
});

test("libera la exclusión si falla la consulta o la serialización del XLSX", async t => {
  for (const stage of ["consulta", "serialización"]) await t.test(stage, async () => {
    let attempts = 0;
    const failOnce = async value => {
      attempts++;
      if (attempts === 1) throw new Error(`fallo privado de ${stage}`);
      return value;
    };
    const api = setup(stage === "consulta"
      ? { exportImpl: () => failOnce(exportResult) }
      : { writeBufferImpl: () => failOnce(xlsxBytes) });

    const failed = await api.route.GET(request());
    assert.equal(failed.status, 503);
    privateResponse(failed);
    assert.equal((await failed.json()).code, "APPROVAL_UNAVAILABLE");

    const retry = await api.route.GET(request());
    assert.equal(retry.status, 200, "el siguiente intento debe adquirir el turno liberado en finally");
    assert.equal(api.calls.filter(call => call.name === "export").length, 2);
  });
});

test("el endpoint niega identidades sin acceso antes de consultar o construir el Excel", async t => {
  const cases = [
    ["sin sesión", null, 401],
    ["vendedor central", { ...centralAnalyst, rolNombre: "VENDEDOR" }, 403],
    ["administrador de aliado", { ...centralAnalyst, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALIADO" }, 403],
    ["analista inactivo", { ...centralAnalyst, activo: false }, 403],
  ];
  for (const [name, user, status] of cases) await t.test(name, async () => {
    const api = setup({ user });
    const response = await api.route.GET(request());
    assert.equal(response.status, status);
    privateResponse(response);
    assert.equal((await response.json()).ok, false);
    assert.equal(api.calls.some(call => ["export", "workbook", "write"].includes(call.name)), false);
  });
});

test("un enlace revocado no usa una sesión administrativa como respaldo", async () => {
  const api = setup({ user: { ...centralAnalyst, rolNombre: "ADMIN" }, shared: null });
  const response = await api.route.GET(request());
  assert.equal(response.status, 401);
  privateResponse(response);
  assert.equal((await response.json()).code, "SHARED_ACCESS_REVOKED");
  assert.deepEqual(api.calls.map(call => call.name), ["shared"]);
});

test("conserva los errores 400 y 413 del servicio sin generar un archivo parcial", async () => {
  for (const error of [
    new errors.CreditApprovalError("INVALID_SADMIN_STATUS", "Selecciona un estado SADMIN válido.", 400),
    new errors.CreditApprovalError("SADMIN_EXPORT_TOO_LARGE", "La exportación supera 2.000 registros.", 413),
  ]) {
    const api = setup({ serviceError: error });
    const response = await api.route.GET(request(error.status === 400 ? "desconocido" : "all"));
    assert.equal(response.status, error.status);
    privateResponse(response);
    const body = await response.json();
    assert.equal(body.code, error.code);
    assert.equal(api.calls.some(call => ["workbook", "write"].includes(call.name)), false);
  }
});

test("un fallo inesperado de consulta o serialización no expone detalles internos", async () => {
  for (const options of [
    { serviceError: new Error("password=private-database-secret") },
    { workbookError: new Error("token=private-workbook-secret") },
  ]) {
    const api = setup(options);
    const response = await api.route.GET(request());
    assert.equal(response.status, 503);
    privateResponse(response);
    const body = await response.text();
    assert.doesNotMatch(body, /private-|password=|token=/);
  }
});
