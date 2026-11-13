import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { cloneElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const Empty = () => null;
const Link = ({ children, ...props }) => jsxRuntime.jsx("a", { ...props, children });
const Menu = ({ label, children }) => jsxRuntime.jsxs("details", { children: [jsxRuntime.jsx("summary", { children: label }), children] });
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const compiled = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(compiled, {
    module: testModule, exports: testModule.exports, Date, Intl, URLSearchParams,
    require(name) {
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (name === "next/link") return { default: Link };
      if (name === "lucide-react") return new Proxy({}, { get: () => Empty });
      if (name === "@/app/_components/finser-ui") return load("app/_components/finser-ui.tsx");
      if (name === "@/lib/roles") return load("lib/roles.ts");
      if (name === "@/lib/cut-risk-presentation") return load("lib/cut-risk-presentation.ts");
      if (name === "./ally-dashboard-fpd-panel") return load("app/dashboard/_components/ally-dashboard-fpd-panel.tsx");
      if (name === "./central-dashboard-menu") return { default: Menu };
      if (name === "./attention-notifications") return { AttentionNotificationBell: Empty };
      if (["@/app/_components/finser-brand", "./logout-button", "./central-dashboard-filters"].includes(name)) return { default: Empty };
      if (name.endsWith(".module.css")) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error(`Dependencia inesperada: ${name}`);
    },
    fetch: () => assert.fail("El panel sólo debe presentar el agregado recibido del servidor"),
  });
  cache.set(file, testModule.exports);
  return testModule.exports;
}
const Panel = load("app/dashboard/_components/ally-dashboard-fpd-panel.tsx").default;
const Dashboard = load("app/dashboard/_components/admin-central-dashboard.tsx").default;
function expand(node, path = "root") {
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`));
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type(node.props), `${path}/component`);
  return cloneElement(node, { key: node.key ?? path }, expand(node.props.children, `${path}/children`));
}
function nodes(node, predicate) {
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => nodes(child, predicate))];
}
function content(node) {
  if (Array.isArray(node)) return node.map(content).join(" ");
  if (node == null || typeof node === "boolean") return "";
  return typeof node === "object" ? content(node.props?.children) : String(node);
}
const text = node => content(node).replace(/\s+/g, " ").trim();
const metric = (day, cases, eligible = 100) => ({ label: `DPF ${day}`, cases, eligible, pending: 55, unavailable: 1 });
function fixture() {
  return { status: "ready", cuts: [
    { cutDate: "2026-10-02", queriedAt: "2026-11-13T18:47:00Z", earlyRisk: [metric(3, 0, 0), metric(7, 0, 0), metric(15, 0, 0)] },
    { cutDate: "2026-09-17", queriedAt: "2026-11-13T18:47:00Z", earlyRisk: [metric(3, 99)] },
    { cutDate: "2026-11-02", queriedAt: "2026-11-13T18:47:00Z", earlyRisk: [metric(3, 0), metric(7, 3), metric(15, 7)] },
    { cutDate: "2026-10-17", queriedAt: "2026-11-13T18:47:00Z", earlyRisk: [metric(3, 10), metric(7, 1, 80), metric(15, 0, 0)] },
  ] };
}
const overview = {
  investedCapital: 2400, activePlacedCapital: 1600, activeCredits: 2, closedCredits: 1, totalCredits: 3,
  accumulatedCollection: 1000, monthlyCollection: 400, monthlyCreditCount: 2, monthlyPlacedCapital: 1600,
  monthlyPaymentCount: 1, alertsCount: 0, dueToday: 0, earlyClients: 0, criticalCredits: 0, daily: [],
  creditPerformance: [{ name: "Sede ejemplo", value: 1600, units: 2 }], monthKey: "2026-11", monthLabel: "noviembre de 2026",
  healthyPercent: 75, earlyPercent: 20, criticalPercent: 5,
  productHealth: { IPHONE: { totalBalance: 1000, healthyPercent: 80, earlyPercent: 15, criticalPercent: 5 }, ANDROID: { totalBalance: 1000, healthyPercent: 70, earlyPercent: 20, criticalPercent: 10 } },
};
const props = { adminCentral: false, aliadoNombre: "Aliado ejemplo", data: overview, nombreUsuario: "Administrador", rolUsuario: "ADMIN", sedeLabel: "Sede ejemplo", availableSedes: [{ id: 9, nombre: "Sede ejemplo" }], selectedSede: 9, allies: [], selectedAlly: null };

test("el resumen presenta los tres cortes más recientes con porcentajes y niveles compartidos, sin conteos ni hora de consulta", () => {
  const data = fixture(), before = JSON.stringify(data);
  const tree = expand(jsxRuntime.jsx(Panel, { data }));
  const table = nodes(tree, node => node.type === "table")[0];
  assert.ok(table);
  assert.deepEqual(nodes(table, node => node.type === "time").map(node => node.props.dateTime), ["2026-11-02", "2026-10-17", "2026-10-02"]);
  const rows = nodes(nodes(table, node => node.type === "tbody")[0], node => node.type === "tr");
  assert.deepEqual(nodes(rows[0], node => node.type === "td").map(text), ["0 % Excelente", "3 % Bueno", "7 % Regular"]);
  assert.deepEqual(nodes(rows[1], node => node.type === "td").map(text), ["10 % Malo", "1,25 % Bueno", "Pendiente"]);
  assert.deepEqual(nodes(rows[2], node => node.type === "td").map(text), ["Pendiente", "Pendiente", "Pendiente"]);
  assert.ok(nodes(rows[1], node => node.type === "span" && text(node) === "Malo")[0].props.className.includes("is-danger"));
  assert.ok(nodes(rows[0], node => node.type === "span" && text(node) === "Regular")[0].props.className.includes("is-warning"));
  assert.equal(nodes(table, node => node.type === "th" && node.props.scope === "col").length, 4);
  assert.equal(nodes(table, node => node.type === "th" && node.props.scope === "row").length, 3);
  assert.doesNotMatch(text(tree), /Por madurar|Sin datos|55|\b100\b|casos|evaluados|18:47|Consulta/);
  assert.equal(JSON.stringify(data), before);
  const link = nodes(tree, node => node.type === "a")[0];
  const query = new URL(link.props.href, "https://finserpay.test").searchParams;
  assert.equal(query.get("day"), "2"); assert.equal(query.get("month"), "11"); assert.equal(query.get("year"), "2026");
});

test("la alternativa móvil conserva cada corte y sus tres métricas, sin columnas horizontales ni pérdida de indicadores", () => {
  const tree = expand(jsxRuntime.jsx(Panel, { data: fixture() }));
  const mobile = nodes(tree, node => node.props.className === "mobile")[0];
  assert.deepEqual(nodes(mobile, node => node.type === "time").map(node => node.props.dateTime), ["2026-11-02", "2026-10-17", "2026-10-02"]);
  const cuts = nodes(mobile, node => node.type === "section");
  assert.equal(cuts.length, 3);
  for (const cut of cuts) {
    assert.deepEqual(nodes(cut, node => node.type === "dt").map(text), ["FPD 3", "FPD 7", "FPD 15"]);
    assert.equal(nodes(cut, node => node.type === "dd").length, 3);
    assert.ok(nodes(cut, node => node.type === "h3" && node.props.id === cut.props["aria-labelledby"]).length);
  }
  assert.deepEqual(nodes(cuts[0], node => node.type === "dd").map(text), ["0 % Excelente", "3 % Bueno", "7 % Regular"]);
});

test("un fallo o ausencia de datos no presenta porcentajes cero ni conserva resultados anteriores", () => {
  for (const data of [undefined, { ...fixture(), status: "unavailable" }]) {
    const tree = expand(jsxRuntime.jsx(Panel, { data }));
    assert.match(text(tree), /FPD no disponible/);
    assert.equal(nodes(tree, node => node.type === "table").length, 0);
    assert.doesNotMatch(text(tree), /0 %|Excelente|Bueno|Malo|NaN|Infinity/);
  }
  const empty = expand(jsxRuntime.jsx(Panel, { data: { status: "ready", cuts: [] } }));
  assert.match(text(empty), /Sin cortes disponibles/);
});

test("sólo el dashboard aliado sustituye Salud de cartera y el enlace conserva fecha y sede autorizadas", () => {
  const fpReportHref = "/dashboard/reportes/recaudo-por-corte?day=2&month=11&year=2026&sedeId=9";
  const ally = expand(jsxRuntime.jsx(Dashboard, { ...props, allyFpd: fixture(), fpReportHref }));
  const headings = nodes(ally, node => node.type === "h2").map(text);
  assert.ok(headings.includes("FPD por corte"));
  assert.ok(!headings.includes("Salud de cartera"));
  assert.equal(nodes(ally, node => node.type === "a" && text(node) === "Ver informe")[0].props.href, fpReportHref);
  const central = expand(jsxRuntime.jsx(Dashboard, { ...props, adminCentral: true, allyFpd: fixture(), fpReportHref }));
  assert.ok(nodes(central, node => node.type === "h2" && text(node) === "Salud de cartera").length);
  assert.equal(nodes(central, node => node.props["aria-labelledby"] === "ally-dashboard-fpd-title").length, 0);
  assert.equal(nodes(central, node => node.props.role === "img" && node.props["aria-label"] === "75,0% al día, 20,0% mora temprana y 5,0% mora crítica").length, 1);
  assert.ok(nodes(central, node => node.type === "a" && text(node) === "Ver detalle" && node.props.href === "/dashboard/cartera/detalle-mora").length);
  assert.doesNotMatch(renderToStaticMarkup(ally), /NaN|Infinity|undefined/);
});
