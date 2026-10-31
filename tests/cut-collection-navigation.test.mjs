import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const route = "/dashboard/reportes/recaudo-por-corte";
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
    "next/link": component(Link), "next/image": component(Empty),
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/app/_components/finser-brand": component(Empty),
    "@/app/_components/finser-ui": { Card: ({ children }) => jsxRuntime.jsx("div", { children }) },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/credit-display-number": { creditDisplayNumber: () => "" },
    "./central-dashboard-menu": component(Menu),
    "./central-dashboard-filters": component(Empty),
    "./logout-button": component(Empty),
    "./attention-notifications": { AttentionNotificationBell: Empty },
    "./seller-client-app-dialog": component(Empty),
    "./seller-commissions": component(Empty),
    "./seller-dashboard-refresh": component(Empty),
    ...extra,
  };
  runInNewContext(source, {
    module: loaded, exports: loaded.exports,
    require(name) {
      if (name.endsWith(".module.css")) return component(styles);
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
  });
  return loaded.exports;
}

const Navigation = load("app/dashboard/_components/finser-navigation.tsx").default;
const CommercialSidebar = load("app/dashboard/_components/seller-commercial-dashboard.tsx").CommercialSidebar;
const CentralDashboard = load("app/dashboard/_components/admin-central-dashboard.tsx").default;
const render = (type, props) => renderToStaticMarkup(jsxRuntime.jsx(type, props));
const hrefs = html => Array.from(html.matchAll(/href="([^"]+)"/g), match => match[1]);

function menu(html, name) {
  return Array.from(html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g), match => match[1])
    .find(content => content.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1].replace(/<[^>]*>/g, "") === name);
}

for (const variant of ["sale", "requests", "reports", "settlement"]) {
  test(`Cartera conserva Recaudo después de Riesgo y Gestión de cartera central en ${variant}`, () => {
    for (const adminCentral of [false, true]) {
      const html = render(Navigation, { admin: true, adminCentral, nombreUsuario: "Administrador", rolUsuario: "ADMIN", variant, activeSection: "portfolio" });
      const portfolio = menu(html, "Cartera");
      assert.ok(portfolio);
      const links = hrefs(portfolio);
      assert.deepEqual(links.slice(links.indexOf("/dashboard/riesgo-referencia") + 1),
        adminCentral ? ["/dashboard/aprobaciones/gestion-cartera", route] : [route]);
      assert.equal(links.filter(href => href === route).length, 1);
      assert.ok(!hrefs(menu(html, "Operación")).includes(route));
      assert.match(html, /class="active"><details><summary>[\s\S]*?Cartera/);
    }
  });

  test(`el supervisor accede a Recaudo por corte sin mostrar módulos de cartera restringidos en ${variant}`, () => {
    const html = render(Navigation, { admin: false, adminCentral: false, isSupervisor: true, nombreUsuario: "Supervisor", rolUsuario: "SUPERVISOR", variant });
    assert.deepEqual(hrefs(menu(html, "Cartera")), [route]);
    assert.doesNotMatch(html, /href="\/dashboard\/(?:cartera(?:\/detalle-mora)?|riesgo-referencia)"/);
    const seller = render(Navigation, { admin: false, adminCentral: false, isSupervisor: false, nombreUsuario: "Vendedor", rolUsuario: "VENDEDOR", variant });
    assert.equal(menu(seller, "Cartera"), undefined);
    assert.ok(!hrefs(seller).includes(route));
  });
}

test("el inicio de los administradores central y aliado conserva el orden solicitado en Cartera", () => {
  const product = { totalBalance: 0, healthyPercent: 0, earlyPercent: 0, criticalPercent: 0 };
  const data = { productHealth: { IPHONE: product, ANDROID: product }, creditPerformance: [], daily: [] };
  for (const adminCentral of [true, false]) {
    const tree = CentralDashboard({ adminCentral, rolUsuario: "ADMIN", nombreUsuario: "Administrador", data, availableSedes: [], allies: [], selectedSede: null, selectedAlly: null });
    const header = tree.props.children[0];
    const html = renderToStaticMarkup(header);
    const links = hrefs(menu(html, "Cartera"));
    assert.equal(links.indexOf(route), links.indexOf("/dashboard/riesgo-referencia") + 1);
    assert.ok(!hrefs(menu(html, "Operación")).includes(route));
  }
});

test("el sidebar comercial muestra Cartera sólo al supervisor en escritorio y móvil", () => {
  const html = render(CommercialSidebar, { avatarSrc: null, isSupervisor: true, nombre: "Supervisor", activeHref: route });
  const sections = Array.from(html.matchAll(/<nav[^>]*aria-label="Cartera"[^>]*>([\s\S]*?)<\/nav>/g), match => match[1]);
  assert.equal(sections.length, 2);
  for (const section of sections) {
    assert.deepEqual(hrefs(section), [route]);
    assert.match(section, /aria-current="page"/);
  }
  const seller = render(CommercialSidebar, { avatarSrc: null, isSupervisor: false, nombre: "Vendedor" });
  assert.ok(!hrefs(seller).includes(route));
  assert.doesNotMatch(seller, /aria-label="Cartera"/);
});

test("la ruta del reporte marca Cartera como sección activa después de validar el rol", async () => {
  let accessChecked = false;
  const Page = load("app/dashboard/reportes/recaudo-por-corte/page.tsx", {
    "@/app/dashboard/_components/finser-navigation": component("CutNavigation"),
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/cut-collection-access": { parseCutFilters: () => ({ day: 17, month: 10, year: 2026 }) },
    "@/lib/dashboard-access": { requireAdminOrSupervisorDashboardAccess: async () => {
      accessChecked = true;
      return { admin: true, supervisor: false, session: { nombre: "Administrador", rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" } };
    } },
    "./recaudo-por-corte-client": component("CutClient"),
  }).default;
  const tree = await Page({ searchParams: Promise.resolve({}) });
  assert.equal(accessChecked, true);
  assert.equal(tree.props.children[0].props.activeSection, "portfolio");
});
