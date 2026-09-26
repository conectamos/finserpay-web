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

function harness(credit) {
  const states = {
    documento: credit.clienteDocumento, activeDocumento: credit.clienteDocumento,
    items: [credit], openCreditId: credit.id, selectedLimit: { [credit.id]: 1 },
  };
  const requests = [];
  let cursor = 0;
  const Dashboard = () => null;
  const Panel = () => null;
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
    useCallback: (callback) => callback,
    // Start after a successful consultation; mount and polling effects are intentionally inactive.
    useEffect: () => {},
  };
  const dependencies = {
    react, "react/jsx-runtime": jsxRuntime,
    "@/lib/credit-display-number": displayNumber,
    "./credit-dashboard-presentation": presentation,
    "@/app/clientes/client-active-credit-dashboard": { default: Dashboard },
    "@/app/clientes/client-credit-panel": { default: Panel },
    "@/app/clientes/client-login-screen": { default: Empty },
    "@/app/clientes/paid-credit-dashboard": { default: Empty },
    "lucide-react": new Proxy({}, { get: () => Empty }),
  };
  const module = { exports: {} };
  runInNewContext(output, {
    module, exports: module.exports,
    require: (name) => { assert.ok(name in dependencies, `Dependencia no simulada: ${name}`); return dependencies[name]; },
    Date, Intl, URLSearchParams,
    document: { getElementById: () => null },
    window: { setTimeout: (callback) => { callback(); return 0; } },
    fetch: async (url, init) => {
      requests.push({ url, method: init.method, body: JSON.parse(init.body) });
      // Stop after verifying the request. No network or real payment is created.
      return { ok: false, json: async () => ({ error: "Respuesta simulada de prueba" }) };
    },
  });
  let tree;
  function render() {
    cursor = 0;
    tree = module.exports.default();
    assert.equal(cursor, hookNames.length);
    return tree;
  }
  const dashboard = () => findNode(tree, (node) => node.type === Dashboard)?.props;
  const panel = () => findNode(tree, (node) => node.type === Panel)?.props;
  const dialog = () => findNode(tree, (node) => node.props?.role === "dialog");
  render();
  return { states, requests, render, dashboard, panel, dialog };
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
    const send = findNode(flow.dialog(), (node) => node.type === "button" && textContent(node) === "Enviar a Nequi");
    assert.equal(send.props.disabled, false);
    send.props.onClick();
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