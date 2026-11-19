import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsx from "react/jsx-runtime";
import ts from "typescript";

const href = "/dashboard/cupos-consultas";
const Empty = () => null;
const component = value => ({ __esModule: true, default: value });
const Link = ({ children, ...props }) => jsx.jsx("a", { ...props, children });
const Menu = ({ label, children }) => jsx.jsxs("details", { children: [jsx.jsx("summary", { children: label }), children] });
const styles = new Proxy({}, { get: (_, key) => String(key) });
function load(file, extra = {}) {
  const loaded = { exports: {} };
  const dependencies = {
    "react/jsx-runtime": jsx,
    "next/link": component(Link),
    "lucide-react": new Proxy({}, { get: () => Empty }),
    "@/app/_components/finser-brand": component(Empty),
    "./central-dashboard-menu": component(Menu),
    "./central-dashboard-filters": component(Empty),
    "./logout-button": component(Empty),
    "./attention-notifications": { AttentionNotificationBell: Empty },
    "./ally-dashboard-fpd-panel": component(Empty),
    ...extra,
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: loaded, exports: loaded.exports, require: name => {
    if (name.endsWith(".module.css")) return component(styles);
    assert.ok(name in dependencies, `Dependencia no simulada: ${name}`);
    return dependencies[name];
  } });
  return loaded.exports;
}
const roles = load("lib/roles.ts");
const ui = load("app/_components/finser-ui.tsx");
const shared = { "@/lib/roles": roles, "@/app/_components/finser-ui": ui };
const Navigation = load("app/dashboard/_components/finser-navigation.tsx", shared).default;
const Sidebar = load("app/dashboard/_components/admin-sidebar.tsx", shared).default;
const Dashboard = load("app/dashboard/_components/admin-central-dashboard.tsx", shared).default;
const render = (type, props) => renderToStaticMarkup(jsx.jsx(type, props));
const links = html => Array.from(html.matchAll(/href="([^"]+)"/g), match => match[1]);

test("el administrador aliado encuentra Cupos de consultas en todas las navegaciones sin acceder a políticas", () => {
  for (const variant of ["sale", "requests", "reports", "settlement", "administration"]) {
    const html = render(Navigation, { admin: true, adminCentral: false, rolUsuario: "ADMIN", nombreUsuario: "Admin aliado", variant });
    assert.equal(links(html).filter(item => item === href).length, 1, variant);
    assert.match(html, />Cupos de consultas<\/a>/);
    assert.ok(!links(html).includes("/dashboard/parametros-credito"));
  }
  const html = render(Sidebar, { adminCentral: false, rolUsuario: "ADMIN", nombreUsuario: "Admin aliado", activeHref: href });
  const menus = Array.from(html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/g), match => match[1]);
  assert.equal(menus.length, 2);
  for (const menu of menus) assert.equal(links(menu).filter(item => item === href).length, 1);
});

test("central conserva Parámetros de crédito y los demás perfiles no reciben el acceso de aliado", () => {
  for (const props of [
    { admin: true, adminCentral: true, rolUsuario: "ADMIN" },
    ...["VENDEDOR", "SUPERVISOR", "ANALISTA_APROBACION"].map(rolUsuario => ({ admin: false, adminCentral: false, rolUsuario })),
  ]) {
    assert.ok(!links(render(Navigation, { ...props, nombreUsuario: "Perfil" })).includes(href));
    assert.ok(!links(render(Sidebar, { ...props, nombreUsuario: "Perfil", activeHref: "/dashboard" })).includes(href));
  }
  const central = render(Navigation, { admin: true, adminCentral: true, rolUsuario: "ADMIN", nombreUsuario: "Central" });
  assert.ok(links(central).includes("/dashboard/parametros-credito"));
});

test("el menú Administración del inicio del aliado ofrece la nueva distribución", () => {
  const product = { totalBalance: 0, healthyPercent: 0, earlyPercent: 0, criticalPercent: 0 };
  for (const adminCentral of [false, true]) {
    const tree = Dashboard({ adminCentral, rolUsuario: "ADMIN", nombreUsuario: "Admin", aliadoNombre: "Aliado",
      availableSedes: [], allies: [], selectedSede: null, selectedAlly: null,
      data: { productHealth: { IPHONE: product, ANDROID: product }, creditPerformance: [], daily: [], alertsCount: 0 } });
    const header = renderToStaticMarkup(tree.props.children[0]);
    assert.equal(links(header).includes(href), !adminCentral);
    assert.equal(links(header).includes("/dashboard/parametros-credito"), adminCentral);
  }
});
