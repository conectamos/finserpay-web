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
    require(name) {
      if (name === "server-only") return {};
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return loadedModule.exports;
}

const roles = load("lib/roles.ts");
const centralAdmin = {
  id: 7,
  activo: true,
  rolNombre: "ADMIN",
  aliadoAccesoCodigo: "FINSERPAY",
};
const centralAnalyst = {
  id: 17,
  activo: true,
  rolNombre: "ANALISTA_APROBACION",
  aliadoAccesoCodigo: "FINSERPAY",
  sedeAccesoActiva: true,
  aliadoAccesoActivo: true,
};

function accessFixture({ regular = null, analyst = null } = {}) {
  const calls = [];
  const access = load("lib/datacredito/admin-access.ts", {
    "@/lib/aliados": {
      isFinserPayCentralAlly: value => String(value || "").toUpperCase() === "FINSERPAY",
    },
    "@/lib/auth": {
      getSessionUser: async () => {
        calls.push("regular");
        return regular;
      },
      getNominalApprovalAnalystSessionUser: async () => {
        calls.push("analyst");
        return analyst;
      },
    },
    "@/lib/roles": roles,
  });
  return { access, calls };
}

test("la liberación conserva al administrador central", async () => {
  const fixture = accessFixture({ regular: centralAdmin });
  const result = await fixture.access.getDataCreditoRetryReleaseActor();
  assert.equal(result.ok, true);
  assert.equal(result.user.id, centralAdmin.id);
  assert.deepEqual(fixture.calls, ["regular"]);
});

test("la liberación acepta al analista nominal con su identidad", async () => {
  const fixture = accessFixture({ analyst: centralAnalyst });
  const result = await fixture.access.getDataCreditoRetryReleaseActor();
  assert.equal(result.ok, true);
  assert.equal(result.user.id, centralAnalyst.id);
  assert.deepEqual(fixture.calls, ["regular", "analyst"]);
});

test("la liberación rechaza enlaces, vendedores y administradores externos", async t => {
  const cases = [
    ["enlace sin cuenta nominal", null, 401],
    ["vendedor", { ...centralAnalyst, rolNombre: "VENDEDOR" }, 403],
    ["administrador externo", { ...centralAdmin, aliadoAccesoCodigo: "OTRO" }, 403],
  ];
  for (const [name, regular, status] of cases) await t.test(name, async () => {
    const fixture = accessFixture({ regular });
    const result = await fixture.access.getDataCreditoRetryReleaseActor();
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.deepEqual(fixture.calls, ["regular", "analyst"]);
  });
});
