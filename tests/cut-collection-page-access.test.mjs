import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const roles = await jiti.import("../lib/roles.ts");
const allies = await jiti.import("../lib/aliados.ts");
const cutAccess = await jiti.import("../lib/cut-collection-access.ts");
const compile = relative => ts.transpileModule(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const accessSource = compile("lib/dashboard-access.ts");
const pageSource = compile("app/dashboard/reportes/recaudo-por-corte/page.tsx");
const central = { id: 7, nombre: "Administrador de prueba", rolNombre: "ADMIN", sedeId: 10,
  aliadoAccesoId: 1, aliadoAccesoCodigo: "FINSERPAY" };

function fixture({ session = central, seller = null } = {}) {
  const calls = { session: 0, seller: 0, searchParams: 0, parse: 0, client: 0, redirects: [] };
  const redirectError = new Error("NEXT_REDIRECT");
  const Client = () => null;
  const Navigation = () => null;
  const load = (source, dependencies) => {
    const loadedModule = { exports: {} };
    new Function("require", "module", "exports", source)(name => {
      assert.ok(name in dependencies, `Dependencia no simulada: ${name}`);
      return dependencies[name];
    }, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  };
  // Only authentication boundaries are mocked. The complete central guard and
  // its role/ally rules execute here, so a permissive page cannot pass this test.
  const dashboardAccess = load(accessSource, {
    "next/navigation": { redirect(url) { calls.redirects.push(url); throw redirectError; } },
    "@/lib/auth": { getSessionUser: async () => { calls.session++; return session; } },
    "@/lib/seller-auth": { getSellerSessionUser: async () => { calls.seller++; return seller; } },
    "@/lib/roles": roles,
    "@/lib/aliados": allies,
  });
  const trackedJsx = factory => (type, props, key) => {
    if (type === Client) calls.client++;
    return factory(type, props, key);
  };
  const Page = load(pageSource, {
    "react/jsx-runtime": { ...jsxRuntime, jsx: trackedJsx(jsxRuntime.jsx), jsxs: trackedJsx(jsxRuntime.jsxs) },
    "@/lib/dashboard-access": dashboardAccess,
    "@/lib/aliados": allies,
    "@/lib/cut-collection-access": { ...cutAccess, parseCutFilters(...args) { calls.parse++; return cutAccess.parseCutFilters(...args); } },
    "@/app/dashboard/_components/finser-navigation": { default: Navigation },
    "./recaudo-por-corte-client": { default: Client },
    "./recaudo-por-corte.module.css": { default: {} },
  }).default;
  return { calls, redirectError, Client, Navigation, render: (query = {}) => Page({
    searchParams: { then(resolve) { calls.searchParams++; resolve(query); } },
  }) };
}

test("la página sin sesión redirige a aliados antes de leer filtros o crear el cliente", async () => {
  const f = fixture({ session: null });
  await assert.rejects(f.render({ central: "true", aliadoId: "1" }), error => error === f.redirectError);
  assert.deepEqual(f.calls, { session: 1, seller: 0, searchParams: 0, parse: 0, client: 0, redirects: ["/aliados"] });
});

for (const [name, session, seller] of [
  ["administrador aliado", { ...central, aliadoAccesoId: 2, aliadoAccesoCodigo: "ALIADO" }, null],
  ["supervisor aliado", { ...central, rolNombre: "VENDEDOR", aliadoAccesoId: 2, aliadoAccesoCodigo: "ALIADO" }, { tipoPerfil: "SUPERVISOR" }],
  ["supervisor central sin rol administrador", { ...central, rolNombre: "VENDEDOR" }, { tipoPerfil: "SUPERVISOR" }],
  ["vendedor", { ...central, rolNombre: "VENDEDOR" }, { tipoPerfil: "VENDEDOR" }],
  ["analista central", { ...central, rolNombre: "ANALISTA_APROBACION" }, null],
]) {
  test(`la página niega ${name} sin renderizar el informe ni consultar searchParams`, async () => {
    const f = fixture({ session, seller });
    await assert.rejects(f.render({ central: "true", rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY", aliadoId: "1" }),
      error => error === f.redirectError);
    assert.deepEqual(f.calls.redirects, ["/dashboard"]);
    assert.equal(f.calls.searchParams, 0);
    assert.equal(f.calls.parse, 0);
    assert.equal(f.calls.client, 0);
    assert.equal(f.calls.session, 1);
  });
}

test("administrador central conserva el informe y sus filtros de corte, aliado, sede y estado", async () => {
  for (const [query, expected] of [
    [{ day: "17", month: "10", year: "2026", aliadoId: "2", sedeId: "21", status: "parcial" },
      { day: 17, month: 10, year: 2026, aliadoId: 2, sedeId: 21, status: "parcial" }],
    [{ day: ["02", "17"], month: ["11", "10"], year: ["2026", "2025"], aliadoId: ["3", "2"], sedeId: ["30", "21"], status: ["pagado", "pendiente"] },
      { day: 2, month: 11, year: 2026, aliadoId: 3, sedeId: 30, status: "pagado" }],
  ]) {
    const f = fixture();
    const tree = await f.render(query);
    const [navigation, main] = tree.props.children;
    assert.equal(navigation.type, f.Navigation);
    assert.equal(navigation.props.admin, true);
    assert.equal(navigation.props.adminCentral, true);
    assert.equal(navigation.props.activeSection, "portfolio");
    assert.equal(main.props.children.type, f.Client);
    assert.deepEqual(main.props.children.props.initialFilters, expected);
    assert.deepEqual(f.calls, { session: 1, seller: 0, searchParams: 1, parse: 1, client: 1, redirects: [] });
  }
});
