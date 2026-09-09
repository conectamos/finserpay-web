import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const pageSource = readFileSync(new URL("../app/dashboard/lista-negra/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(pageSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

async function renderPage(access) {
  const pageModule = { exports: {} };
  const Shell = () => null;
  const Sidebar = () => null;
  const Topbar = () => null;
  const Console = () => null;
  const dependencies = {
    "next/navigation": { redirect: (path) => { throw Object.assign(new Error("Redirect"), { path }); } },
    "@/app/_components/finser-ui": { AppShell: Shell },
    "@/app/dashboard/_components/admin-sidebar": { default: Sidebar },
    "@/app/dashboard/_components/admin-workspace-topbar": { default: Topbar },
    "@/lib/ally-payment-access": { getAllyPaymentAccess: async () => access },
    "./blacklist-console": { default: Console },
  };
  const pageRequire = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name === "react/jsx-runtime") return require(name);
    throw new Error(`Unexpected page dependency: ${name}`);
  };
  new Function("require", "module", "exports", compiled)(pageRequire, pageModule, pageModule.exports);
  return { tree: await pageModule.exports.default(), Shell, Sidebar, Topbar, Console };
}

test("la página de lista negra exige autenticación antes de mostrar el módulo", async () => {
  await assert.rejects(renderPage({ ok: false, status: 401 }), (error) => error.path === "/");
});

test("la página no permite administrar la lista a roles sin acceso", async () => {
  await assert.rejects(renderPage({ ok: false, status: 403 }), (error) => error.path === "/dashboard");
});

test("un administrador de aliado no puede abrir el módulo central de lista negra", async () => {
  await assert.rejects(renderPage({ ok: true, kind: "ALLY_ADMIN", allyId: 7, user: {} }), (error) => error.path === "/dashboard");
});

test("el administrador central accede a la consola con su identidad en la navegación", async () => {
  const { tree, Shell, Sidebar, Topbar, Console } = await renderPage({
    ok: true,
    kind: "CENTRAL_ADMIN",
    allyId: null,
    user: { nombre: "Administrador de prueba", rolNombre: "ADMIN" },
  });
  assert.equal(tree.type, Shell);
  assert.equal(tree.props.sidebar.type, Sidebar);
  assert.equal(tree.props.sidebar.props.adminCentral, true);
  assert.equal(tree.props.sidebar.props.activeHref, "/dashboard/lista-negra");
  assert.equal(tree.props.sidebar.props.nombreUsuario, "Administrador de prueba");
  assert.equal(tree.props.children[0].type, Topbar);
  assert.equal(tree.props.children[1].type, Console);
});
