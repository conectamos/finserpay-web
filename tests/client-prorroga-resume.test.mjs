import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import * as react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "lucide-react";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const presentation = await jiti.import("../app/clientes/credit-dashboard-presentation.ts");
const displayNumber = await jiti.import("../lib/credit-display-number.ts");
const colombiaDate = await jiti.import("../lib/colombia-date.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const source = readFileSync(new URL("../app/clientes/page.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pageDeclaration = parsed.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ClienteConsultaPage"
);
assert.ok(pageDeclaration, "La prueba ejecuta la página real de Clientes");
const hookNames = pageDeclaration.body.statements.filter(ts.isVariableStatement).flatMap((statement) =>
  statement.declarationList.declarations.filter((declaration) =>
    ts.isArrayBindingPattern(declaration.name) && ts.isCallExpression(declaration.initializer) &&
    declaration.initializer.expression.getText(parsed) === "useState"
  ).map((declaration) => declaration.name.elements[0].name.getText(parsed))
);
const output = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function credit(id, prorrogaMora = null, { firstDate = "2026-08-17", today = "2026-09-26" } = {}) {
  const plan = buildCreditPaymentPlan({
    montoCredito: 2_740_000, valorCuota: 137_000, plazoMeses: 20,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: firstDate,
    today, abonos: [],
  });
  return {
    id, folio: `TEST-${id}`, clienteNombre: "Cliente Prueba", clienteDocumento: "12345678",
    clienteTelefono: "3001234567", referenciaEquipo: "IPHONE ARES", fechaCredito: "2026-08-01",
    montoCredito: 2_740_000, valorCuota: 137_000, sedeNombre: "Sede prueba",
    estadoPago: plan.estadoPago, saldoPendiente: plan.saldoPendiente, totalPagado: plan.totalPaid,
    cuotas: plan.installments, abonos: [], prorrogaMora,
    liquidacionAnticipada: { disponible: false, capitalPendiente: 0 },
  };
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return null;
}

function harness({
  activeDocument = "12345678", visibility = "hidden",
  initialCredits = [credit(31), credit(32)],
  updatedCredits = [credit(31), credit(32, { hasta: "2026-10-05T04:59:59.999Z" })],
} = {}) {
  const states = {
    documento: activeDocument, activeDocumento: activeDocument,
    items: initialCredits, openCreditId: 32, activePanel: "pending",
    selectedLimit: { 31: 3, 32: 3 },
  };
  const listeners = { window: new Map(), document: new Map() };
  const requests = [];
  const effects = [];
  const refs = [];
  let stateCursor = 0;
  let refCursor = 0;
  let resolveFetch;
  const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
  const Empty = () => null;
  const Dashboard = () => null;
  const PaidDashboard = () => null;
  const Panel = () => null;
  const Login = () => null;
  const addListener = (target, event, callback) => {
    const callbacks = listeners[target].get(event) || new Set();
    callbacks.add(callback);
    listeners[target].set(event, callbacks);
  };
  const removeListener = (target, event, callback) => listeners[target].get(event)?.delete(callback);
  const document = {
    visibilityState: visibility,
    getElementById: () => null,
    addEventListener: (event, callback) => addListener("document", event, callback),
    removeEventListener: (event, callback) => removeListener("document", event, callback),
  };
  const window = {
    location: { search: "" },
    addEventListener: (event, callback) => addListener("window", event, callback),
    removeEventListener: (event, callback) => removeListener("window", event, callback),
    setTimeout: () => 0,
    clearTimeout: () => {},
    FinserPayAndroid: { registerClient: () => {} },
  };
  const react = {
    useState(initial) {
      const name = hookNames[stateCursor++];
      assert.ok(name, "El arnés corresponde a los hooks de estado reales");
      if (!(name in states)) states[name] = typeof initial === "function" ? initial() : initial;
      return [states[name], (next) => {
        states[name] = typeof next === "function" ? next(states[name]) : next;
      }];
    },
    useRef(initial) {
      const index = refCursor++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useCallback: (callback) => callback,
    useEffect: (effect) => effects.push(effect),
  };
  const dependencies = {
    react, "react/jsx-runtime": jsxRuntime,
    "@/lib/credit-display-number": displayNumber,
    "@/lib/colombia-date": colombiaDate,
    "./credit-dashboard-presentation": presentation,
    "./client-nequi-payment-dialog": { default: Empty },
    "@/app/clientes/client-active-credit-dashboard": { default: Dashboard },
    "@/app/clientes/client-credit-panel": { default: Panel },
    "@/app/clientes/client-login-screen": { default: Login },
    "@/app/clientes/paid-credit-dashboard": { default: PaidDashboard },
    "lucide-react": new Proxy({}, { get: () => Empty }),
  };
  const testModule = { exports: {} };
  runInNewContext(output, {
    module: testModule, exports: testModule.exports,
    require: (name) => {
      assert.ok(name in dependencies, `Dependencia no simulada: ${name}`);
      return dependencies[name];
    },
    Date, Intl, URLSearchParams, document, window,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: (url, init) => {
      requests.push({ url, cache: init?.cache });
      return pendingFetch;
    },
  });

  function render() {
    stateCursor = 0;
    refCursor = 0;
    const tree = testModule.exports.default();
    assert.equal(stateCursor, hookNames.length);
    return tree;
  }
  const firstTree = render();
  assert.ok(findNode(firstTree, (node) => node.type === Dashboard || node.type === PaidDashboard));
  effects.forEach((effect) => effect());

  return {
    states, requests, document,
    dispatch(target, event) {
      for (const callback of listeners[target].get(event) || []) callback();
    },
    finishRequest() {
      resolveFetch({ ok: true, json: async () => ({ ok: true, items: updatedCredits }) });
    },
    dashboard() { return findNode(render(), (node) => node.type === Dashboard)?.props; },
    paidDashboard() { return findNode(render(), (node) => node.type === PaidDashboard)?.props; },
    panel() { return findNode(render(), (node) => node.type === Panel)?.props; },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("al volver a una app visible, Clientes relee la prórroga sin perder crédito ni panel", async () => {
  const page = harness();
  assert.equal(page.dashboard().statusLabel, "Pago pendiente");
  page.document.visibilityState = "visible";
  page.dispatch("document", "visibilitychange");

  assert.deepEqual(page.requests, [{
    url: "/api/clientes/creditos?documento=12345678", cache: "no-store",
  }]);
  page.finishRequest();
  await settle();

  assert.equal(page.states.openCreditId, 32);
  assert.equal(page.states.activePanel, "pending");
  assert.equal(page.dashboard().activeCreditId, 32);
  assert.equal(page.dashboard().statusLabel, "Crédito en mora");
  assert.equal(page.dashboard().extensionNotice, "Prórroga activa hasta 4 de octubre de 2026");
  assert.equal(page.panel().credit.id, 32);
  assert.equal(page.panel().extensionNotice, "Prórroga activa hasta 4 de octubre de 2026");
});

test("focus y visibilitychange simultáneos comparten una sola consulta", async () => {
  const page = harness({ visibility: "visible" });
  page.dispatch("window", "focus");
  page.dispatch("document", "visibilitychange");

  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].cache, "no-store");
  page.finishRequest();
  await settle();
  assert.equal(page.dashboard().statusLabel, "Crédito en mora");
});

function loadComponent(path, dependencies) {
  const componentSource = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(componentSource, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const componentModule = { exports: {} };
  runInNewContext(compiled, {
    module: componentModule, exports: componentModule.exports,
    require(name) {
      assert.ok(name in dependencies, `Dependencia de presentación no simulada: ${name}`);
      return dependencies[name];
    },
    Date, Intl, URLSearchParams,
  });
  return componentModule.exports;
}

const finserUi = loadComponent("../app/_components/finser-ui.tsx", { "react/jsx-runtime": jsxRuntime });
const componentDependencies = {
  react, "react/jsx-runtime": jsxRuntime, "lucide-react": icons,
  "@/app/_components/finser-ui": finserUi,
  "@/lib/credit-display-number": displayNumber,
  "@/lib/colombia-date": colombiaDate,
  "./credit-dashboard-presentation": presentation,
  "next/image": { default: (props) => jsxRuntime.jsx("img", props) },
  "@/app/_components/finser-support-link": { default: () => null },
  "./client-active-credit-dashboard.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  "./client-credit-panel.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
};
const RealDashboard = loadComponent("../app/clientes/client-active-credit-dashboard.tsx", componentDependencies).default;
const RealPanel = loadComponent("../app/clientes/client-credit-panel.tsx", componentDependencies).default;
const activeExtension = { hasta: "2026-10-22T04:59:59.999Z" };
const activeExtensionText = "Prórroga activa hasta 21 de octubre de 2026";

function currentCredit(prorrogaMora = activeExtension) {
  return credit(32, prorrogaMora, { firstDate: "2026-10-17", today: "2026-10-17" });
}

test("una autorización vigente se ve en inicio y paneles aunque la cuota venza hoy y esté AL_DIA", () => {
  const current = currentCredit();
  assert.equal(current.estadoPago, "AL_DIA");
  const page = harness({ initialCredits: [current] });
  const dashboardProps = page.dashboard();
  assert.equal(dashboardProps.statusLabel, "Crédito al día");
  assert.equal(dashboardProps.statusTone, "current");
  assert.equal(dashboardProps.nextInstallment.dueDate, "2026-10-17");
  assert.equal(dashboardProps.nextInstallment.amount, 137_000);
  assert.equal(dashboardProps.extensionNotice, activeExtensionText);
  const dashboardHtml = renderToStaticMarkup(jsxRuntime.jsx(RealDashboard, dashboardProps));
  assert.match(dashboardHtml, /Prórroga activa hasta 21 de octubre de 2026/);
  assert.match(dashboardHtml, /Crédito al día/);
  assert.doesNotMatch(dashboardHtml, /Crédito en mora|Cuota vencida/);
  for (const panel of ["pending", "payments", "history"]) {
    const html = renderToStaticMarkup(jsxRuntime.jsx(RealPanel, { ...page.panel(), panel }));
    assert.match(html, /Prórroga activa hasta 21 de octubre de 2026/);
  }
  assert.equal(page.panel().credit.saldoPendiente, current.saldoPendiente);
  assert.deepEqual(page.panel().credit.cuotas, current.cuotas);
});

test("la recarga existente incorpora la autorización para un crédito AL_DIA sin cambiar estado ni cuotas", async () => {
  const initial = currentCredit(null);
  const updated = currentCredit();
  const page = harness({ initialCredits: [initial], updatedCredits: [updated] });
  assert.equal(page.dashboard().extensionNotice, null);
  page.document.visibilityState = "visible";
  page.dispatch("document", "visibilitychange");
  page.finishRequest();
  await settle();
  assert.equal(page.requests.length, 1);
  assert.equal(page.dashboard().extensionNotice, activeExtensionText);
  assert.equal(page.dashboard().statusLabel, "Crédito al día");
  assert.deepEqual(page.panel().credit.cuotas, initial.cuotas);
});

test("PAGADO, paz y salvo y saldo cero nunca muestran prórroga aunque llegue un aviso", () => {
  for (const override of [
    { estadoPago: "PAGADO" },
    { pazYSalvoEmitidoAt: "2026-10-17T15:00:00Z" },
    { saldoPendiente: 0 },
  ]) {
    const current = { ...currentCredit(), ...override };
    const page = harness({ initialCredits: [current] });
    if (override.estadoPago === "PAGADO") {
      assert.ok(page.paidDashboard());
      assert.equal(page.dashboard(), undefined);
    } else {
      assert.equal(page.dashboard().extensionNotice, null);
      const html = renderToStaticMarkup(jsxRuntime.jsx(RealDashboard, page.dashboard()));
      assert.doesNotMatch(html, /Prórroga activa/);
    }
    const panelProps = { ...harness({ initialCredits: [currentCredit()] }).panel(), credit: current, extensionNotice: activeExtensionText };
    const html = renderToStaticMarkup(jsxRuntime.jsx(RealPanel, panelProps));
    assert.doesNotMatch(html, /Prórroga activa/);
  }
});

test("null del servidor por autorización caducada, cancelada o ausente retira el aviso anterior", async () => {
  const page = harness({ initialCredits: [currentCredit()], updatedCredits: [currentCredit(null)] });
  assert.equal(page.dashboard().extensionNotice, activeExtensionText);
  page.document.visibilityState = "visible";
  page.dispatch("document", "visibilitychange");
  page.finishRequest();
  await settle();
  assert.equal(page.dashboard().extensionNotice, null);
  assert.equal(page.panel().extensionNotice, null);
  const dashboardHtml = renderToStaticMarkup(jsxRuntime.jsx(RealDashboard, page.dashboard()));
  const panelHtml = renderToStaticMarkup(jsxRuntime.jsx(RealPanel, page.panel()));
  assert.doesNotMatch(dashboardHtml, /Prórroga activa/);
  assert.doesNotMatch(panelHtml, /Prórroga activa/);
});
