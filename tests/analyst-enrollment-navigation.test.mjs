import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compile = file => ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pageSource = compile("app/dashboard/aprobaciones/enrolamiento/page.tsx");
const enrollmentHelpers = { exports: {} };
runInNewContext(compile("lib/iphone-enrollment.ts"), {
  module: enrollmentHelpers, exports: enrollmentHelpers.exports,
  process: { env: {} }, require: () => ({}),
});

function harness({ centralAdmin = false, denied = false, databaseDenied = false } = {}) {
  const events = [];
  const Portal = () => null, Shell = () => null, Topbar = () => null;
  const loadedModule = { exports: {} };
  const prisma = {};
  runInNewContext(pageSource, {
    module: loadedModule, exports: loadedModule.exports,
    require(name) {
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "next/navigation") return { redirect: href => { events.push(["redirect", href]); throw new Error("REDIRECT:" + href); } };
      if (name === "@/app/dashboard/_components/admin-workspace-topbar") return { default: Topbar };
      if (name === "@/app/enrolamiento-iphone/iphone-enrollment-portal") return { default: Portal };
      if (name === "../approval-dashboard-shell") return { default: Shell };
      if (name === "@/lib/prisma") return { default: prisma };
      if (name === "@/lib/iphone-enrollment") return enrollmentHelpers.exports;
      if (name === "@/lib/analyst-mora-access") return {
        getMoraActor: async () => {
          events.push(["session"]);
          if (denied) throw new Error("FORBIDDEN");
          return { id: 17, nombre: "Nombre de sesión", centralAdmin };
        },
        assertMoraActor: async (database, actor) => {
          assert.equal(database, prisma); assert.equal(actor.id, 17); events.push(["database"]);
          if (databaseDenied) throw new Error("FORBIDDEN");
          return { ...actor, nombre: "Usuario vigente" };
        },
      };
      throw new Error("Importación inesperada: " + name);
    },
  });
  return { events, Portal, Shell, Topbar, page: params => loadedModule.exports.default({ searchParams: Promise.resolve(params) }) };
}

for (const centralAdmin of [false, true]) {
  test(`la página privada permite ${centralAdmin ? "admin central" : "analista nominal"} revalidado y reutiliza el portal operativo`, async () => {
    const ui = harness({ centralAdmin });
    const tree = await ui.page({ documento: "1.001.234.567", imei: "351 168 083 278 358" });
    assert.deepEqual(ui.events, [["session"], ["database"]]);
    assert.equal(tree.type, ui.Shell); assert.equal(tree.props.activeHref, "/dashboard/aprobaciones/enrolamiento");
    assert.equal(tree.props.user.nombre, "Usuario vigente");
    assert.equal(tree.props.user.rolNombre, centralAdmin ? "ADMIN" : "ANALISTA_APROBACION");
    const portal = tree.props.children.find(child => child.type === ui.Portal);
    assert.equal(portal.props.mode, "ANALYST"); assert.equal(portal.props.initialDocument, "1001234567");
    assert.equal(portal.props.initialImei, "351168083278358");
    assert.deepEqual(Object.keys(portal.props).sort(), ["initialDocument", "initialImei", "mode"], "solo precarga identificadores, no inicia consultas ni administra accesos");
  });
}

for (const options of [{ denied: true }, { databaseDenied: true }]) {
  test(`sin acceso nominal vigente redirige antes de renderizar el portal (${Object.keys(options)[0]})`, async () => {
    const ui = harness(options);
    await assert.rejects(ui.page({}), /REDIRECT:\/dashboard\/aprobaciones/);
    assert.deepEqual(ui.events.at(-1), ["redirect", "/dashboard/aprobaciones"]);
  });
}

test("los parámetros vacíos, repetidos o demasiado largos no precargan identificadores inválidos", async () => {
  for (const params of [{}, { documento: ["1001234567"], imei: ["351168083278358"] },
    { documento: "texto", imei: "123" }, { documento: "1".repeat(101), imei: "x".repeat(101) }]) {
    const ui = harness(); const tree = await ui.page(params);
    const portal = tree.props.children.find(child => child.type === ui.Portal);
    assert.equal(portal.props.initialDocument, ""); assert.equal(portal.props.initialImei, "");
  }
});

test("la precarga conserva ceros iniciales y los límites admitidos por enrolamiento", async () => {
  const ui = harness(); const tree = await ui.page({ documento: "000123", imei: "001168083278358" });
  const portal = tree.props.children.find(child => child.type === ui.Portal);
  assert.equal(portal.props.initialDocument, "000123"); assert.equal(portal.props.initialImei, "001168083278358");
});
