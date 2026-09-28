import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const empty = () => null;
const Link = ({ children, ...props }) => jsx("a", { ...props, children });

function load(file, overrides = {}) {
  const { outputText } = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const mod = { exports: {} };
  const resolve = (name) => {
    if (name in overrides) return overrides[name];
    if (name === "next/link") return { __esModule: true, default: Link };
    if (name.endsWith("finser-brand") || name === "./logout-button") return { __esModule: true, default: empty };
    if (name.endsWith(".module.css")) return {};
    if (name === "@/lib/roles") return load("lib/roles.ts");
    if (name === "@/lib/commissions") return load("lib/commissions.ts");
    if (name === "@/app/_components/finser-ui") return load("app/_components/finser-ui.tsx");
    if (name === "@/app/_components/finser-confirm-dialog") return { __esModule: true, default: empty };
    return require(name);
  };
  new Function("require", "module", "exports", outputText)(resolve, mod, mod.exports);
  return mod.exports;
}

const Sidebar = load("app/dashboard/_components/admin-sidebar.tsx").default;
const render = (adminCentral, rolUsuario) => renderToStaticMarkup(jsx(Sidebar, {
  adminCentral, rolUsuario, activeHref: "/dashboard/comisiones", nombreUsuario: "Verificación de permisos",
}));

test("Comisiones aparece únicamente para el administrador central real", () => {
  for (const [central, role, expected] of [
    [true, "ADMIN", true], [false, "ADMIN", false], [true, "ANALISTA_APROBACION", false],
    [false, "ANALISTA_APROBACION", false], [true, "VENDEDOR", false], [true, "SUPERVISOR", false],
  ]) {
    const html = render(central, role);
    assert.equal(html.includes('href="/dashboard/comisiones"'), expected, `${central}/${role}`);
    if (expected) assert.match(html, /href="\/dashboard\/comisiones" aria-current="page"/);
  }
});

test("la integración conserva los módulos recientes y el menú aislado del analista", () => {
  const central = render(true, "ADMIN");
  for (const route of ["aprobaciones", "solicitudes", "pagos-aliados", "lista-negra", "integraciones/enrolamiento-iphone", "datacredito/liberaciones"]) {
    assert.ok(central.includes(`href="/dashboard/${route}"`), route);
  }
  const ally = render(false, "ADMIN");
  assert.ok(ally.includes('href="/dashboard/pendientes"'));
  assert.ok(ally.includes('href="/dashboard/pagos-aliados"'));
  const analyst = render(true, "ANALISTA_APROBACION");
  assert.ok(analyst.includes('href="/dashboard/aprobaciones"'));
  assert.ok(!analyst.includes('href="/dashboard/pagos-aliados"'));
  assert.ok(!analyst.includes('href="/dashboard/creditos"'));
});

test("la página de comisiones exige el guard central antes de devolver contenido", async () => {
  let calls = 0;
  const Page = load("app/dashboard/comisiones/page.tsx", {
    "@/lib/dashboard-access": { requireCentralAdminDashboardAccess: async () => { calls++; throw new Error("CENTRAL_ONLY"); } },
    "@/app/dashboard/_components/admin-sidebar": { default: empty },
    "@/app/dashboard/_components/admin-workspace-topbar": { default: empty },
    "./commission-admin-console": { default: empty },
  }).default;
  await assert.rejects(Page(), /CENTRAL_ONLY/);
  assert.equal(calls, 1);
});

const { CommissionBagsTable } = load("app/dashboard/comisiones/commission-admin-console.tsx");

test("las bolsas muestran la cartera y el estado de aliados incluso sin solicitudes", () => {
  const bags = [
    { allyId: 1, allyName: "Aliado sin solicitudes", overdueBalance: 7999, totalBalance: 100000, overduePercent: 7.999, paused: false },
    { allyId: 2, allyName: "Aliado en el límite", overdueBalance: 8000, totalBalance: 100000, overduePercent: 8, paused: true },
    { allyId: 3, allyName: "Aliado sobre el límite", overdueBalance: 10000, totalBalance: 100000, overduePercent: 10, paused: true },
    { allyId: 4, allyName: "Aliado sin cartera", overdueBalance: 0, totalBalance: 0, overduePercent: 0, paused: false },
  ];
  const html = renderToStaticMarkup(jsx(CommissionBagsTable, { bags, loading: false }));
  for (const bag of bags) assert.ok(html.includes(bag.allyName));
  assert.match(html, /7,999%/);
  assert.match(html, /8,00%/);
  assert.match(html, /10,00%/);
  assert.match(html, /0,00%/);
  assert.equal((html.match(/En pausa/g) || []).length, 2);
  assert.equal((html.match(/Habilitada/g) || []).length, 2);
  assert.match(html, /igual o superior al 8%/);
  assert.match(html, /Las reservas anteriores se conservan/);
});

test("la tabla no inventa bolsas durante carga o sin aliados", () => {
  const loading = renderToStaticMarkup(jsx(CommissionBagsTable, { bags: [], loading: true }));
  assert.match(loading, /Consultando cartera de los aliados/);
  assert.ok(!loading.includes("Habilitada"));
  const emptyHtml = renderToStaticMarkup(jsx(CommissionBagsTable, { bags: [], loading: false }));
  assert.match(emptyHtml, /No hay bolsas de aliados para mostrar/);
  assert.ok(!emptyHtml.includes("En pausa"));
});
