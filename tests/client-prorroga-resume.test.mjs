import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import * as jsxRuntime from "react/jsx-runtime";

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

function credit(id, prorrogaMora = null) {
  const plan = buildCreditPaymentPlan({
    montoCredito: 2_740_000, valorCuota: 137_000, plazoMeses: 20,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-08-17",
    today: "2026-09-26", abonos: [],
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

function harness({ activeDocument = "12345678", visibility = "hidden" } = {}) {
  const initialCredits = [credit(31), credit(32)];
  const updatedCredits = [credit(31), credit(32, { hasta: "2026-10-05T04:59:59.999Z" })];
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
    "@/app/clientes/paid-credit-dashboard": { default: Empty },
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
  assert.ok(findNode(firstTree, (node) => node.type === Dashboard));
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
