import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const catalogRoute = "/dashboard/catalogo-equipos";
const policyRoute = "/dashboard/parametros-credito";
const Empty = () => null;
const component = (value) => ({ __esModule: true, default: value });
const Link = ({ href, children, ...props }) => jsxRuntime.jsx("a", { href, ...props, children });
const Menu = ({ label, children }) => jsxRuntime.jsxs("details", { children: [jsxRuntime.jsx("summary", { children: label }), children] });
const Icon = () => jsxRuntime.jsx("svg", { "aria-hidden": true });
const styles = new Proxy({}, { get: (_, key) => String(key) });

function load(file, extra = {}) {
  const loaded = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies = {
    "react/jsx-runtime": jsxRuntime,
    "next/link": component(Link),
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/app/_components/finser-brand": component(Empty),
    "@/app/_components/finser-ui": { Card: ({ children }) => jsxRuntime.jsx("div", { children }) },
    "@/lib/roles": {
      isAdminRole: role => String(role || "").trim().toUpperCase() === "ADMIN",
      isApprovalAnalystRole: role => role === "ANALISTA_APROBACION",
    },
    "./central-dashboard-menu": component(Menu),
    "./central-dashboard-filters": component(Empty),
    "./logout-button": component(Empty),
    ...extra,
  };
  runInNewContext(source, {
    module: loaded,
    exports: loaded.exports,
    require(name) {
      if (name.endsWith(".module.css")) return component(styles);
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
  });
  return loaded.exports;
}

const Navigation = load("app/dashboard/_components/finser-navigation.tsx").default;
const Sidebar = load("app/dashboard/_components/admin-sidebar.tsx").default;
const Dashboard = load("app/dashboard/_components/admin-central-dashboard.tsx").default;
const render = (type, props) => renderToStaticMarkup(jsxRuntime.jsx(type, props));
const hrefs = html => Array.from(html.matchAll(/href="([^"]+)"/g), match => match[1]);

for (const variant of ["sale", "requests", "reports", "settlement"]) {
  test(`el catálogo aparece una vez para administradores central y aliado en navegación ${variant}`, () => {
    for (const adminCentral of [false, true]) {
      const html = render(Navigation, { admin: true, adminCentral, variant, nombreUsuario: "Administradora conectada", rolUsuario: "ADMIN", activeSection: "administration" });
      const links = hrefs(html);
      assert.equal(links.filter(href => href === catalogRoute).length, 1);
      assert.equal(links.includes(policyRoute), adminCentral, "Las políticas conservan su alcance central");
      assert.match(html, />Catálogo de equipos<\/a>/);
    }
  });

  test(`el catálogo permanece oculto a vendedor, supervisor y analista en navegación ${variant}`, () => {
    for (const rolUsuario of ["VENDEDOR", "SUPERVISOR", "ANALISTA_APROBACION"]) {
      const html = render(Navigation, { admin: false, adminCentral: false, isSupervisor: rolUsuario === "SUPERVISOR", variant, nombreUsuario: "Usuario conectado", rolUsuario });
      assert.ok(!hrefs(html).includes(catalogRoute), `El rol ${rolUsuario} no recibe el acceso`);
      assert.ok(!hrefs(html).includes(policyRoute));
    }
  });
}

test("el sidebar incluye el catálogo activo en móvil y escritorio para ambos administradores", () => {
  for (const adminCentral of [false, true]) {
    const html = render(Sidebar, { adminCentral, activeHref: catalogRoute, nombreUsuario: "Administradora conectada", rolUsuario: "ADMIN" });
    const menus = Array.from(html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/g), match => match[1]);
    assert.equal(menus.length, 2, "Se conservan las navegaciones móvil y de escritorio");
    for (const menu of menus) {
      const links = hrefs(menu);
      assert.equal(links.filter(href => href === catalogRoute).length, 1);
      assert.equal(links.includes(policyRoute), adminCentral);
      assert.match(menu, /href="\/dashboard\/catalogo-equipos" aria-current="page"/);
      assert.match(menu, />Catálogo de equipos<\/span>/);
    }
  }
});

test("el sidebar no ofrece el catálogo a perfiles no administradores", () => {
  for (const rolUsuario of ["VENDEDOR", "SUPERVISOR", "ANALISTA_APROBACION"]) {
    const html = render(Sidebar, { adminCentral: false, activeHref: "/dashboard", nombreUsuario: "Usuario conectado", rolUsuario });
    assert.ok(!hrefs(html).includes(catalogRoute), `El rol ${rolUsuario} no recibe el acceso`);
  }
});

function dashboardProps(adminCentral) {
  const product = { totalBalance: 0, healthyPercent: 0, earlyPercent: 0, criticalPercent: 0 };
  return {
    adminCentral,
    nombreUsuario: "Administradora conectada",
    rolUsuario: "ADMIN",
    aliadoNombre: "Aliado de prueba",
    availableSedes: [],
    allies: [],
    selectedSede: null,
    selectedAlly: null,
    data: {
      productHealth: { IPHONE: product, ANDROID: product },
      creditPerformance: [], daily: [],
      investedCapital: 0, activePlacedCapital: 0, accumulatedCollection: 0,
      totalCredits: 0, activeCredits: 0, closedCredits: 0, alertsCount: 0,
      monthlyCreditCount: 0, monthlyPaymentCount: 0, monthlyPlacedCapital: 0,
      monthlyCollection: 0, healthyPercent: 0, earlyPercent: 0, criticalPercent: 0,
      dueToday: 0, earlyClients: 0, criticalCredits: 0,
    },
  };
}

test("el inicio aliado ofrece catálogo en Administración y como acción directa con icono", () => {
  const tree = Dashboard(dashboardProps(false));
  const header = renderToStaticMarkup(tree.props.children[0]);
  const main = renderToStaticMarkup(tree.props.children[1]);
  assert.equal(hrefs(header).filter(href => href === catalogRoute).length, 1);
  assert.ok(!hrefs(header).includes(policyRoute));
  assert.equal(hrefs(main).filter(href => href === catalogRoute).length, 1);
  assert.match(main, /href="\/dashboard\/catalogo-equipos"[^>]*><svg[^>]*><\/svg>Catálogo de equipos<\/a>/);
});

test("el inicio central conserva catálogo y políticas en Administración", () => {
  const tree = Dashboard(dashboardProps(true));
  const header = renderToStaticMarkup(tree.props.children[0]);
  assert.equal(hrefs(header).filter(href => href === catalogRoute).length, 1);
  assert.ok(hrefs(header).includes(policyRoute));
});

function catalogPage({ central = false, deny = false } = {}) {
  let checks = 0;
  const session = { nombre: "Administradora real", rolNombre: "ADMIN", aliadoAccesoCodigo: central ? "FINSERPAY" : "ALIADO" };
  const marker = name => () => jsxRuntime.jsx("div", { "data-catalog-component": name });
  const Page = load("app/dashboard/catalogo-equipos/page.tsx", {
    "@/app/_components/finser-ui": { AppShell: ({ sidebar, children }) => jsxRuntime.jsxs("div", { "data-shell": "central", children: [sidebar, children] }) },
    "@/app/dashboard/_components/admin-sidebar": component(marker("sidebar")),
    "@/app/dashboard/_components/admin-workspace-topbar": component(marker("topbar")),
    "@/app/dashboard/_components/finser-navigation": component(marker("navigation")),
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/dashboard-access": { requireAdminDashboardAccess: async () => {
      checks += 1;
      if (deny) throw new Error("ADMIN_ACCESS_DENIED");
      return { session };
    } },
    "./ally-equipment-catalog": component(marker("readonly")),
    "./equipment-catalog-console": component(marker("management")),
  }).default;
  return { Page, checks: () => checks, session };
}

test("la ruta del administrador aliado muestra consulta sin herramientas de edición", async () => {
  const fixture = catalogPage();
  const tree = await fixture.Page();
  const html = renderToStaticMarkup(tree);
  assert.equal(fixture.checks(), 1);
  assert.match(html, /data-catalog-component="readonly"/);
  assert.match(html, /data-catalog-component="navigation"/);
  assert.doesNotMatch(html, /data-catalog-component="management"/);
  const navigation = tree.props.children[0];
  assert.equal(navigation.props.nombreUsuario, fixture.session.nombre);
  assert.equal(navigation.props.rolUsuario, fixture.session.rolNombre);
  assert.equal(navigation.props.admin, true);
  assert.equal(navigation.props.adminCentral, false);
  assert.equal(navigation.props.activeSection, "administration");
});

test("la ruta central conserva la consola de administración existente", async () => {
  const fixture = catalogPage({ central: true });
  const tree = await fixture.Page();
  const html = renderToStaticMarkup(tree);
  assert.equal(fixture.checks(), 1);
  assert.match(html, /data-catalog-component="management"/);
  assert.doesNotMatch(html, /data-catalog-component="readonly"/);
  assert.equal(tree.props.sidebar.props.activeHref, catalogRoute);
  assert.equal(tree.props.sidebar.props.adminCentral, true);
  assert.equal(tree.props.sidebar.props.nombreUsuario, fixture.session.nombre);
});

test("la ruta exige acceso de administrador antes de mostrar cualquier catálogo", async () => {
  const fixture = catalogPage({ deny: true });
  await assert.rejects(fixture.Page(), /ADMIN_ACCESS_DENIED/);
  assert.equal(fixture.checks(), 1);
});
