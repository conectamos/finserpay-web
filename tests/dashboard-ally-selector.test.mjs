import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

const allies = [
  { id: 7, nombre: "Móviles Bogotá", codigo: "MOV-07" },
  { id: 8, nombre: "JG COMPANY", codigo: "JG-008" },
  { id: 9, nombre: "Punto Celular", codigo: null },
];
const Empty = () => null;
const iconStubs = new Proxy({}, { get: () => Empty });

function compileComponent(filename, dependencies, globals = {}) {
  const source = readFileSync(new URL(`../app/dashboard/_components/${filename}.tsx`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(output, {
    module: testModule, exports: testModule.exports, Date, Intl, URLSearchParams,
    require: (name) => {
      assert.ok(name in dependencies, `Dependencia no simulada: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return testModule.exports.default;
}

function nodes(node, predicate) {
  if (!node || typeof node !== "object") return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...[node.props?.children].flat(Infinity).flatMap((child) => nodes(child, predicate)),
  ];
}

function textContent(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return [node.props?.children].flat(Infinity).map(textContent).join(" ").replace(/\s+/g, " ");
}

function selectorHarness(filename, props, search = "") {
  const states = [];
  const navigations = [];
  const location = { search };
  let cursor = 0;
  let tree;
  const Component = compileComponent(filename, {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (next) => {
          states[index] = typeof next === "function" ? next(states[index]) : next;
        }];
      },
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useTransition: () => [false, (callback) => callback()],
    },
    "react/jsx-runtime": jsxRuntime,
    "next/navigation": { useRouter: () => ({ push: (url, options) => {
      navigations.push({ url, options });
      location.search = new URL(url, "https://finserpay.test").search;
    } }) },
    "lucide-react": iconStubs,
    "@/app/_components/finser-ui": { Input: Empty },
  }, { window: { location } });
  function render() {
    cursor = 0;
    tree = Component(props);
    return tree;
  }
  function find(predicate) {
    const matches = nodes(tree, predicate);
    assert.equal(matches.length, 1, "Debe existir un único control para la interacción probada");
    return matches[0];
  }
  function open() {
    find((node) => node.type === "button" && node.props["aria-haspopup"] === "dialog").props.onClick();
    render();
    assert.equal(nodes(tree, (node) => node.props?.role === "dialog").length, 1);
  }
  function choose(label) {
    find((node) => node.type === "button" && textContent(node).trim() === label).props.onClick();
    render();
  }
  function query(value) {
    find((node) => node.props?.type === "search").props.onChange({ target: { value } });
    render();
  }
  render();
  return { render, find, open, choose, query, navigations, location, get tree() { return tree; } };
}

function navigatedParams(flow) {
  assert.equal(flow.navigations.length, 1);
  const navigation = flow.navigations[0];
  assert.equal(navigation.options.scroll, false);
  const url = new URL(navigation.url, "https://finserpay.test");
  assert.equal(url.pathname, "/dashboard");
  return url.searchParams;
}

function visibleAllies(flow) {
  return nodes(flow.tree, (node) => node.type === "button" && node.props["aria-pressed"] !== undefined)
    .map((node) => textContent(node).trim());
}

test("la búsqueda encuentra aliados por nombre sin acentos y por código, y muestra ausencia de resultados", () => {
  const flow = selectorHarness("dashboard-ally-selector", { allies, selectedAllyId: null });
  flow.open();
  flow.query("  MOVILES bOgOtA  ");
  assert.deepEqual(visibleAllies(flow), ["Todas las sedes", "Móviles Bogotá MOV-07"]);
  flow.query("jg-008");
  assert.deepEqual(visibleAllies(flow), ["Todas las sedes", "JG COMPANY JG-008"]);
  flow.query("punto celular");
  assert.deepEqual(visibleAllies(flow), ["Todas las sedes", "Punto Celular"]);
  flow.query("aliado inexistente");
  assert.deepEqual(visibleAllies(flow), ["Todas las sedes"]);
  assert.match(textContent(flow.find((node) => node.props?.role === "status")), /No se encontraron aliados/);
  flow.query("");
  assert.equal(visibleAllies(flow).length, 4);
});

test("seleccionar un aliado conserva el mes y los otros filtros del panel", () => {
  const flow = selectorHarness("dashboard-ally-selector", { allies, selectedAllyId: null }, "?month=2026-08&view=resumen");
  flow.open();
  flow.choose("Móviles Bogotá MOV-07");
  const params = navigatedParams(flow);
  assert.equal(params.get("aliadoId"), "7");
  assert.equal(params.get("month"), "2026-08");
  assert.equal(params.get("view"), "resumen");
  assert.equal(nodes(flow.tree, (node) => node.props?.role === "dialog").length, 0);
});

test("Todas las sedes quita solo el aliado y conserva el mes seleccionado", () => {
  const flow = selectorHarness("dashboard-ally-selector", { allies, selectedAllyId: 8 }, "?aliadoId=8&month=2026-07&view=resumen");
  assert.match(flow.find((node) => node.props?.["aria-haspopup"] === "dialog").props["aria-label"], /JG COMPANY/);
  flow.open();
  assert.equal(flow.find((node) => node.type === "button" && textContent(node).trim() === "JG COMPANY JG-008").props["aria-pressed"], true);
  flow.choose("Todas las sedes");
  const params = navigatedParams(flow);
  assert.equal(params.has("aliadoId"), false);
  assert.equal(params.get("month"), "2026-07");
  assert.equal(params.get("view"), "resumen");
});

test("volver al panel sin filtros no deja una URL vacía y seleccionar el mismo aliado no navega", () => {
  const flow = selectorHarness("dashboard-ally-selector", { allies, selectedAllyId: 7 }, "?aliadoId=7");
  flow.open();
  flow.choose("Móviles Bogotá MOV-07");
  assert.equal(flow.navigations.length, 0);
  flow.open();
  flow.choose("Todas las sedes");
  assert.equal(flow.navigations[0].url, "/dashboard");
});

test("el selector mensual conserva el aliado elegido y los otros parámetros", () => {
  const flow = selectorHarness("dashboard-month-selector", {
    currentMonth: "2026-09", selectedMonth: "2026-09", label: "Septiembre de 2026",
  }, "?aliadoId=7&month=2026-09&view=resumen");
  flow.open();
  flow.choose("Ago");
  const params = navigatedParams(flow);
  assert.equal(params.get("month"), "2026-08");
  assert.equal(params.get("aliadoId"), "7");
  assert.equal(params.get("view"), "resumen");
});

const Sidebar = () => null;
const HealthPanel = () => null;
const DelinquencyPanel = () => null;
const AllySelector = () => null;
const MonthSelector = () => null;
const Link = () => null;
const Dashboard = compileComponent("admin-central-dashboard", {
  "react/jsx-runtime": jsxRuntime,
  "next/link": { default: Link },
  "lucide-react": iconStubs,
  "./admin-sidebar": { default: Sidebar },
  "./portfolio-health-panel": { default: HealthPanel },
  "./delinquency-detail-panel": { default: DelinquencyPanel },
  "./dashboard-ally-selector": { default: AllySelector },
  "./dashboard-month-selector": { default: MonthSelector },
});
const overview = {
  delinquencyDetail: {
    activeCredits: 2, overdueCredits: 1, overduePercent: 50,
    totalBalance: 1000, overdueBalance: 60, overduePortfolioPercent: 6,
    sites: [], sellers: [],
  },
  investedCapital: 2400, activePlacedCapital: 1600, activeCredits: 2, closedCredits: 1,
  totalCredits: 3, accumulatedCollection: 1000, monthlyCollection: 400,
  monthlyCreditCount: 2, monthlyPlacedCapital: 1600, monthlyPaymentCount: 1,
  alertsCount: 0, dueToday: 0, earlyClients: 0, criticalCredits: 0, daily: [],
  creditPerformance: [{ name: "Sede Bogotá", value: 1600, units: 2 }],
  currentMonthKey: "2026-09", monthKey: "2026-08", monthLabel: "agosto de 2026",
};
function renderDashboard(adminCentral, selectedAlly) {
  return Dashboard({ adminCentral, selectedAlly, allies, data: overview,
    aliadoNombre: "Móviles Bogotá", nombreUsuario: "Administrador", rolUsuario: "ADMIN", sedeLabel: "Bogotá" });
}
function metricLabels(tree) {
  return nodes(tree, (node) => typeof node.type === "function" && node.props?.label && node.props.value !== undefined)
    .map((node) => node.props.label);
}

test("el administrador central puede ver el panel aliado sin perder sus permisos de navegación", () => {
  const tree = renderDashboard(true, allies[0]);
  assert.deepEqual(metricLabels(tree), ["Inversión", "Total créditos", "Créditos activos", "Créditos Finalizados"]);
  assert.match(textContent(tree), /Panel aliado/);
  assert.match(textContent(tree), /Móviles Bogotá/);
  assert.match(textContent(tree), /Rendimiento por sede/);
  assert.equal(nodes(tree, (node) => node.type === Sidebar)[0].props.adminCentral, true);
  assert.equal(nodes(tree, (node) => node.type === AllySelector)[0].props.selectedAllyId, 7);
  assert.equal(nodes(tree, (node) => node.type === HealthPanel)[0].props.data, overview);
  assert.equal(nodes(tree, (node) => node.type === DelinquencyPanel)[0].props.detail, overview.delinquencyDetail);
  assert.equal(nodes(tree, (node) => node.type === DelinquencyPanel)[0].props.scopeLabel, "Móviles Bogotá");
  const portfolioLinks = nodes(tree, (node) => node.type === Link && node.props.href.startsWith("/dashboard/cartera"));
  assert.equal(portfolioLinks.length, 4);
  assert.ok(portfolioLinks.every((node) => node.props.href === "/dashboard/cartera?aliadoId=7"));
});

test("el panel central conserva sus seis indicadores al volver a Todas las sedes", () => {
  const tree = renderDashboard(true, null);
  assert.deepEqual(metricLabels(tree), ["Capital colocado", "Cartera activa", "Total créditos", "Créditos activos", "Créditos finalizados", "Recaudo acumulado"]);
  assert.match(textContent(tree), /Panel central/);
  assert.match(textContent(tree), /Rendimiento por aliado/);
  assert.equal(nodes(tree, (node) => node.type === AllySelector)[0].props.selectedAllyId, null);
  assert.equal(nodes(tree, (node) => node.type === DelinquencyPanel)[0].props.detail, overview.delinquencyDetail);
  assert.equal(nodes(tree, (node) => node.type === DelinquencyPanel)[0].props.scopeLabel, "Todos los aliados");
});

test("el administrador del aliado conserva su panel y no recibe el selector central", () => {
  const tree = renderDashboard(false, null);
  assert.deepEqual(metricLabels(tree), ["Inversión", "Total créditos", "Créditos activos", "Créditos Finalizados"]);
  assert.equal(nodes(tree, (node) => node.type === AllySelector).length, 0);
  assert.equal(nodes(tree, (node) => node.type === Sidebar)[0].props.adminCentral, false);
  assert.equal(nodes(tree, (node) => node.type === DelinquencyPanel)[0].props.detail, overview.delinquencyDetail);
  assert.equal(nodes(tree, (node) => node.type === DelinquencyPanel)[0].props.scopeLabel, "Móviles Bogotá");
  assert.match(textContent(tree), /Rendimiento por sede/);
});
