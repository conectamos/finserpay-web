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
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const source = readFileSync(new URL("../app/clientes/page.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pageDeclaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ClienteConsultaPage");
const hookNames = pageDeclaration.body.statements.filter(ts.isVariableStatement).flatMap((statement) =>
  statement.declarationList.declarations.filter((declaration) =>
    ts.isArrayBindingPattern(declaration.name) && ts.isCallExpression(declaration.initializer) &&
    declaration.initializer.expression.getText(parsed) === "useState"
  ).map((declaration) => declaration.name.elements[0].name.getText(parsed))
);
const output = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const money = (amount) => new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", maximumFractionDigits: 0,
}).format(amount);

function fixture(options = {}) {
  const plan = buildCreditPaymentPlan({
    montoCredito: 2_740_000, valorCuota: 137_000, plazoMeses: 20,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-08-17",
    today: "2026-09-26", abonos: [], ...options,
  });
  return {
    id: 81, folio: "0300000081", clienteNombre: "Ospino Vega", clienteDocumento: "12345678",
    clienteTelefono: "3001234567", referenciaEquipo: "IPHONE ARES", fechaCredito: "2026-08-01",
    montoCredito: 2_740_000, valorCuota: 137_000, sedeNombre: "Sede prueba",
    estadoPago: plan.estadoPago, saldoPendiente: plan.saldoPendiente, totalPagado: plan.totalPaid,
    cuotas: plan.installments, abonos: [], liquidacionAnticipada: { disponible: false, capitalPendiente: 0 },
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

function textContent(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return [node.props?.children].flat(Infinity).map(textContent).join(" ");
}

const colombiaDate = await jiti.import("../lib/colombia-date.ts");
const panelSource = readFileSync(new URL("../app/clientes/client-credit-panel.tsx", import.meta.url), "utf8");
const panelOutput = ts.transpileModule(panelSource, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function renderPanel(props) {
  const Empty = () => null;
  const dependencies = {
    react: { useRef: () => ({ current: null }), useState: (initial) => [initial, () => {}], useEffect: () => {} },
    "react/jsx-runtime": jsxRuntime,
    "@/lib/credit-display-number": displayNumber,
    "@/lib/colombia-date": colombiaDate,
    "./credit-dashboard-presentation": presentation,
    "./client-credit-panel.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
    "@/app/_components/finser-support-link": { default: Empty },
    "lucide-react": new Proxy({}, { get: () => Empty }),
  };
  const testModule = { exports: {} };
  runInNewContext(panelOutput, {
    module: testModule, exports: testModule.exports, Date, Intl,
    require: (name) => { assert.ok(name in dependencies, `Dependencia del panel no simulada: ${name}`); return dependencies[name]; },
  });
  return testModule.exports.default(props);
}
function paymentDialogRenderer() {
  const dialogSource = readFileSync(new URL("../app/clientes/client-nequi-payment-dialog.tsx", import.meta.url), "utf8");
  const dialogOutput = ts.transpileModule(dialogSource, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const refs = [];
  let refCursor = 0;
  const Empty = () => null;
  const dependencies = {
    react: {
      useEffect: () => {}, useId: () => "test-nequi-dialog",
      useRef(initial) {
        const index = refCursor++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    },
    "react/jsx-runtime": jsxRuntime,
    "@/app/_components/finser-ui": { Button: "button", Input: "input" },
    "lucide-react": new Proxy({}, { get: () => Empty }),
    "./client-nequi-payment-dialog.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  };
  const testModule = { exports: {} };
  runInNewContext(dialogOutput, {
    module: testModule, exports: testModule.exports, Date, Intl,
    require: (name) => { assert.ok(name in dependencies, `Dependencia del diálogo no simulada: ${name}`); return dependencies[name]; },
  });
  return {
    Component: testModule.exports.default,
    render(props) {
      refCursor = 0;
      return testModule.exports.default(props);
    },
  };
}
function submitDialog(dialog) {
  const send = findNode(dialog, (node) => node.type === "button" && textContent(node).trim() === "Enviar solicitud a Nequi");
  assert.ok(send, "El diálogo permite enviar la solicitud a Nequi");
  assert.equal(send.props.disabled, false);
  const form = findNode(dialog, (node) => node.type === "form");
  assert.ok(form, "El diálogo conserva envío accesible mediante formulario");
  form.props.onSubmit({ preventDefault() {} });
}
function harness(credit, { consultFirst = false } = {}) {
  const states = consultFirst ? {} : {
    documento: credit.clienteDocumento, activeDocumento: credit.clienteDocumento,
    items: [credit], openCreditId: credit.id, selectedLimit: { [credit.id]: 1 },
  };
  const stored = new Map();
  const androidDocuments = [];
  const requests = [];
  let cursor = 0;
  let refCursor = 0;
  const refs = [];
  const paymentDialog = paymentDialogRenderer();
  const Dashboard = () => null;
  const Panel = () => null;
  const Login = () => null;
  const Empty = () => null;
  const react = {
    useState(initial) {
      const name = hookNames[cursor++];
      assert.ok(name, "El arnés debe corresponder a los hooks de estado reales");
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
    // User interactions run real callbacks. Mount and polling effects remain inactive.
    useEffect: () => {},
  };
  const dependencies = {
    react, "react/jsx-runtime": jsxRuntime,
    "@/lib/credit-display-number": displayNumber,
    "./credit-dashboard-presentation": presentation,
    "./client-nequi-payment-dialog": { default: paymentDialog.Component },
    "@/app/clientes/client-active-credit-dashboard": { default: Dashboard },
    "@/app/clientes/client-credit-panel": { default: Panel },
    "@/app/clientes/client-login-screen": { default: Login },
    "@/app/clientes/paid-credit-dashboard": { default: Empty },
    "lucide-react": new Proxy({}, { get: () => Empty }),
  };
  const testModule = { exports: {} };
  runInNewContext(output, {
    module: testModule, exports: testModule.exports,
    require: (name) => { assert.ok(name in dependencies, `Dependencia no simulada: ${name}`); return dependencies[name]; },
    Date, Intl, URLSearchParams,
    document: { getElementById: () => null },
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
    window: {
      setTimeout: (callback) => { callback(); return 0; },
      FinserPayAndroid: { registerClient: (document) => androidDocuments.push(document) },
    },
    fetch: async (url, init) => {
      const method = init.method || "GET";
      requests.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
      if (method === "GET" && url.startsWith("/api/clientes/creditos?")) {
        return { ok: true, json: async () => ({ ok: true, items: [credit] }) };
      }
      // Stop after verifying the request. No network or real payment is created.
      return { ok: false, json: async () => ({ error: "Respuesta simulada de prueba" }) };
    },
  });
  let tree;
  function render() {
    cursor = 0;
    refCursor = 0;
    tree = testModule.exports.default();
    assert.equal(cursor, hookNames.length);
    return tree;
  }
  const login = () => findNode(tree, (node) => node.type === Login)?.props;
  const dashboard = () => findNode(tree, (node) => node.type === Dashboard)?.props;
  const panel = () => findNode(tree, (node) => node.type === Panel)?.props;
  const dialog = () => {
    const component = findNode(tree, (node) => node.type === paymentDialog.Component);
    return component ? paymentDialog.render(component.props) : null;
  };
  render();
  return { states, requests, stored, androidDocuments, render, login, dashboard, panel, dialog };
}

for (const scenario of [
  { name: "tres vencidas", options: {}, amount: 411_000, numbers: [1, 2, 3], count: 3 },
  { name: "primera cuota con abono parcial", options: { abonos: [{ valor: 50_000, fechaAbono: "2026-08-20" }] }, amount: 361_000, numbers: [1, 2, 3], count: 3 },
  { name: "crédito al día", options: { today: "2026-08-17" }, amount: 137_000, numbers: [1], count: 0 },
]) {
  test(`Inicio y confirmación cobran el mismo saldo para ${scenario.name}`, async () => {
    const credit = fixture(scenario.options);
    const flow = harness(credit);
    const home = flow.dashboard();
    assert.ok(home, "Se debe mostrar Inicio");
    if (scenario.count) {
      assert.equal(home.overduePayment.amount, scenario.amount);
      assert.equal(home.overduePayment.count, scenario.count);
    } else {
      assert.equal(home.overduePayment, null);
      assert.equal(home.nextInstallment.amount, scenario.amount);
    }

    home.onPayInstallment();
    flow.render();
    assert.equal(flow.states.selectedLimit[credit.id], scenario.numbers.at(-1));
    assert.equal(flow.states.confirmPaymentCreditId, credit.id);
    assert.ok(flow.dialog(), "El botón debe abrir la confirmación Nequi existente");
    assert.ok(textContent(flow.dialog()).includes(money(scenario.amount)), "El modal debe mostrar el total de Inicio");
    assert.ok(textContent(flow.dialog()).includes(scenario.count ? "Cuotas 1 a 3" : "Cuota 1"));

    const terms = findNode(flow.dialog(), (node) => node.type === "input" && node.props.type === "checkbox");
    terms.props.onChange({ target: { checked: true } });
    flow.render();
    submitDialog(flow.dialog());

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(flow.requests.length, 1);
    const request = flow.requests[0];
    assert.equal(request.url, "/api/clientes/wompi-checkout");
    assert.equal(request.method, "POST");
    assert.deepEqual(request.body.cuotaNumeros, scenario.numbers);
    assert.equal(request.body.creditoId, credit.id);
    assert.equal(request.body.paymentMode, "CUOTAS");
    assert.equal(request.body.paymentMethod, "NEQUI");
    assert.equal(request.body.acceptWompiTerms, true);
    assert.equal(request.body.nequiPhone, "3001234567");
    assert.ok(!request.body.cuotaNumeros.includes(4), "La primera cuota futura no debe incluirse");
  });
}

test("el calendario inconsistente abre revisión del plan y no confirma un cobro mayor", () => {
  const credit = fixture({ fechaProximoPago: "2026-09-28" });
  const flow = harness(credit);
  assert.equal(flow.dashboard().overduePayment.amount, 274_000);
  flow.dashboard().onPayInstallment();
  flow.render();
  assert.equal(flow.states.confirmPaymentCreditId, null);
  assert.equal(flow.dialog(), null);
  assert.equal(flow.panel().panel, "pending");
  assert.match(flow.states.notice.text, /Revisa el calendario/);
  assert.equal(flow.requests.length, 0);
});
for (const scenario of [
  { name: "tres vencidas", options: {}, amount: 411_000, limit: 3, numbers: [1, 2, 3] },
  { name: "abono parcial en mora", options: { abonos: [{ valor: 50_000, fechaAbono: "2026-08-20" }] }, amount: 361_000, limit: 3, numbers: [1, 2, 3] },
  { name: "crédito al día", options: { today: "2026-08-17" }, amount: 137_000, limit: 1, numbers: [1] },
]) {
  test(`la consulta inicial selecciona el saldo correcto en Crédito y Medios de pago para ${scenario.name}`, async () => {
    const credit = fixture(scenario.options);
    const flow = harness(credit, { consultFirst: true });
    assert.ok(flow.login(), "La prueba comienza sin una consulta previa ni selección de cuotas");
    assert.equal(flow.dashboard(), undefined);

    flow.login().onSubmit(credit.clienteDocumento);
    await new Promise((resolve) => setImmediate(resolve));
    flow.render();
    assert.equal(flow.requests.length, 1);
    assert.equal(flow.requests[0].method, "GET");
    assert.equal(flow.requests[0].url, `/api/clientes/creditos?documento=${credit.clienteDocumento}`);
    assert.equal(flow.states.activeDocumento, credit.clienteDocumento);
    assert.equal(flow.stored.get("finserpay.cliente.documento"), credit.clienteDocumento);
    assert.deepEqual(flow.androidDocuments, [credit.clienteDocumento]);
    assert.equal(flow.states.selectedLimit[credit.id], scenario.limit);

    // Navigate directly to the plan, without pressing Inicio's payment button.
    flow.dashboard().onOpenPlan();
    flow.render();
    assert.equal(flow.panel().panel, "pending");
    assert.equal(flow.panel().selectedPaymentLimit, scenario.limit);
    const plan = renderPanel(flow.panel());
    const featured = findNode(plan, (node) => node.props?.className === "featuredInstallment");
    assert.ok(textContent(featured).includes(money(scenario.amount)), "El plan real muestra el saldo agregado pendiente");
    assert.ok(textContent(featured).includes(scenario.limit > 1 ? "Saldo en mora" : "Próxima cuota"));
    if (scenario.limit > 1) assert.ok(textContent(featured).includes("3 cuotas vencidas"));
    const methodsButton = findNode(featured, (node) => node.type === "button" && textContent(node) === "MEDIOS DE PAGO");
    methodsButton.props.onClick();
    flow.render();
    assert.equal(flow.panel().panel, "payments");
    assert.equal(flow.panel().selectedPaymentLimit, scenario.limit);
    const payments = renderPanel(flow.panel());
    const summary = findNode(payments, (node) => node.props?.className === "paymentSummary");
    assert.ok(textContent(summary).includes(money(scenario.amount)), "Medios de pago muestra el mismo saldo seleccionado");
    const pay = findNode(payments, (node) => node.type === "button" && textContent(node).trim() === `Pagar ${money(scenario.amount)}`);
    assert.ok(pay, "Nequi ofrece pagar el saldo inicial correcto sin pulsar el pago de Inicio");
    pay.props.onClick();
    flow.render();
    assert.ok(flow.dialog());
    assert.ok(textContent(flow.dialog()).includes(money(scenario.amount)));
    const terms = findNode(flow.dialog(), (node) => node.type === "input" && node.props.type === "checkbox");
    terms.props.onChange({ target: { checked: true } });
    flow.render();
    submitDialog(flow.dialog());

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(flow.requests.length, 2);
    const checkout = flow.requests[1];
    assert.equal(checkout.url, "/api/clientes/wompi-checkout");
    assert.equal(checkout.method, "POST");
    assert.deepEqual(checkout.body.cuotaNumeros, scenario.numbers);
    assert.ok(!checkout.body.cuotaNumeros.includes(4));
  });
}

test("una consulta con calendario inconsistente conserva primera cuota sin agrupar futuras", async () => {
  const credit = fixture({ fechaProximoPago: "2026-09-28" });
  const flow = harness(credit, { consultFirst: true });
  flow.login().onSubmit(credit.clienteDocumento);
  await new Promise((resolve) => setImmediate(resolve));
  flow.render();
  assert.equal(flow.states.selectedLimit[credit.id], 1);
  assert.equal(flow.dashboard().overduePayment.amount, 274_000);
  assert.equal(flow.dialog(), null);
  flow.dashboard().onOpenPlan();
  flow.render();
  assert.equal(flow.panel().selectedPaymentLimit, 1);
  assert.equal(flow.panel().panel, "pending");
  assert.equal(flow.requests.filter((request) => request.method === "POST").length, 0);
});