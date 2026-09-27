import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createJiti } from "jiti";
import * as jsxRuntime from "react/jsx-runtime";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const presentation = await jiti.import("../app/clientes/credit-dashboard-presentation.ts");
const displayNumber = await jiti.import("../lib/credit-display-number.ts");
const colombiaDate = await jiti.import("../lib/colombia-date.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { createPrincipalPaymentQuote, parseCapitalPlanSnapshot } = await jiti.import("../lib/credit-principal-payment.ts");
const { calculateCreditEarlyPayoff } = await jiti.import("../lib/credit-early-payoff.ts");
const pageSource = readFileSync(new URL("../app/clientes/page.tsx", import.meta.url), "utf8");
const pageAst = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pageDeclaration = pageAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ClienteConsultaPage");
const hookNames = pageDeclaration.body.statements.filter(ts.isVariableStatement).flatMap((statement) =>
  statement.declarationList.declarations.filter((declaration) => ts.isArrayBindingPattern(declaration.name) &&
    ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(pageAst) === "useState"
  ).map((declaration) => declaration.name.elements[0].name.getText(pageAst))
);
function compile(source, dependencies, globals = {}) {
  const testModule = { exports: {} };
  const output = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(output, {
    module: testModule, exports: testModule.exports, Date, Intl, URLSearchParams,
    require(name) { assert.ok(name in dependencies, `Dependencia no simulada: ${name}`); return dependencies[name]; },
    ...globals,
  });
  return testModule.exports.default;
}
function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}
function textContent(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return [node.props?.children].flat(Infinity).map(textContent).join(" ").replace(/\s+/g, " ").trim();
}
const Empty = () => null;
const iconStubs = new Proxy({}, { get: () => Empty });
const money = (amount) => new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", maximumFractionDigits: 0,
}).format(amount).replace(/\s+/g, " ");
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((callback) => { resolve = callback; });
  return { promise, resolve };
}
const response = (body, ok = true) => ({ ok, json: async () => body });

// This reconciled fixture is built through the production principal-payment
// functions. The API result is derived from the actual early-payoff calculator.
function revisedFixture({ settled = false, today = "2026-09-26" } = {}) {
  const terms = { montoCredito: 149_700 * 48, valorCuota: 149_700, plazoMeses: 48,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26" };
  const payments = [{ id: 1, valor: 150_000, fechaAbono: "2026-09-16" },
    { id: 2, valor: 300_000, fechaAbono: "2026-09-26" }];
  const quote = createPrincipalPaymentQuote({ plan: buildCreditPaymentPlan({ ...terms, abonos: payments }),
    valor: 700_000, capitalOriginal: 3_500_000, cuotaHabitual: 149_700, abonos: payments,
    conciliacion: { capitalPendiente: 3_347_264, tasaPeriodo: 0.010881, cuotaCredito: 94_470,
      fianzaCuota: 54_180, seguroCuota: 1050, numeroProximaCuota: 4, fuente: "Conciliacion de prueba sin datos personales" } });
  payments.push({ id: 3, valor: 700_000, fechaAbono: "2026-09-26" });
  const revisedSnapshot = parseCapitalPlanSnapshot({ ...quote.planCapitalVigente,
    abonosAlCorte: payments.map(({ id, valor }) => ({ id, valor })) });
  const input = { ...terms, today, montoCredito: quote.montoCreditoActualizado, planCapitalVigente: revisedSnapshot,
    abonos: payments, saldoBaseFinanciado: 3_500_000, valorFianza: 2_600_640, valorInteres: 1_084_960, settled };
  if (settled) {
    payments.push({ id: 4, valor: 2_647_264, fechaAbono: "2026-09-26" });
    input.montoCredito = payments.reduce((sum, payment) => sum + payment.valor, 0);
  }
  const plan = buildCreditPaymentPlan(input);
  const payoff = calculateCreditEarlyPayoff(input);
  return {
    id: 81, folio: "0300000081", clienteNombre: "Cliente de prueba", clienteDocumento: "12345678",
    clienteTelefono: "3001234567", referenciaEquipo: "INFINIX SMART 20 128GB", imei: "359111122223333",
    fechaCredito: "2026-09-01", montoCredito: input.montoCredito, valorCuota: terms.valorCuota,
    sedeNombre: "Sede de prueba", estadoPago: plan.estadoPago, saldoPendiente: plan.saldoPendiente,
    totalPagado: plan.totalPaid, cuotas: plan.installments,
    pazYSalvoEmitidoAt: settled ? "2026-09-26T15:00:00Z" : null,
    abonos: payments.map((payment) => ({ ...payment, metodoPago: payment.id === 4 ? "NEQUI" : "EFECTIVO" })),
    liquidacionAnticipada: { disponible: payoff.eligible, capitalPendiente: payoff.capitalPendiente,
      condonacion: payoff.interesFianzaCondonado, saldoObligacion: payoff.saldoObligacion, motivo: payoff.reason },
  };
}

const Dashboard = compile(readFileSync(new URL("../app/clientes/client-active-credit-dashboard.tsx", import.meta.url), "utf8"), {
  react: { useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}], useEffect: () => {} },
  "react/jsx-runtime": jsxRuntime, "next/image": { default: Empty }, "lucide-react": iconStubs,
  "@/app/_components/finser-ui": { Button: "button", ProgressBar: Empty },
  "./credit-dashboard-presentation": presentation, "@/lib/colombia-date": colombiaDate,
  "./client-active-credit-dashboard.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
});
const PanelUI = compile(readFileSync(new URL("../app/clientes/client-credit-panel.tsx", import.meta.url), "utf8"), {
  react: { useRef: (initial) => ({ current: initial }), useState: (initial) => [initial, () => {}], useEffect: () => {} },
  "react/jsx-runtime": jsxRuntime, "lucide-react": iconStubs,
  "@/lib/credit-display-number": displayNumber, "@/lib/colombia-date": colombiaDate,
  "./credit-dashboard-presentation": presentation,
  "@/app/_components/finser-support-link": { default: Empty },
  "./client-credit-panel.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
});
function assertPendingPayoffSummary(flow) {
  const panelProps = flow.panel();
  assert.equal(panelProps.pendingPayment.paymentMode, "PAYOFF");
  assert.equal(panelProps.pendingPayment.amount, 2_647_264);
  const tree = PanelUI(panelProps);
  const summary = findNode(tree, (node) => node.props?.className === "paymentSummary");
  assert.ok(textContent(summary).includes("Liquidación de crédito"));
  assert.ok(textContent(summary).includes(money(2_647_264)));
  assert.ok(!textContent(summary).includes(money(148_800)), "El saldo pendiente no se presenta como próxima cuota");
  assert.ok(!textContent(summary).includes(money(5_051_999)), "El resumen no usa la selección original de cuotas");
  assert.equal(findNode(tree, (node) => node.props?.className === "selectorCard"), null);
  const sent = findNode(tree, (node) => node.type === "button" && textContent(node) === "Solicitud enviada a Nequi");
  assert.ok(sent);
  assert.equal(sent.props.disabled, true, "La intención pendiente no ofrece un segundo cobro de otra selección");
}
function dialogRenderer() {
  const refs = [];
  let cursor = 0;
  const Component = compile(readFileSync(new URL("../app/clientes/client-nequi-payment-dialog.tsx", import.meta.url), "utf8"), {
    react: {
      useId: () => "test-revised-payoff", useEffect: (callback) => callback(),
      useRef(initial) { const index = cursor++; return refs[index] ??= { current: initial }; },
    },
    "react/jsx-runtime": jsxRuntime, "lucide-react": iconStubs,
    "@/app/_components/finser-ui": { Button: "button", Input: "input" },
    "./client-nequi-payment-dialog.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  });
  return { Component, render(props) { cursor = 0; return Component(props); } };
}
function harness(initialCredit = revisedFixture()) {
  let returnedCredit = initialCredit;
  let statusResponse = response({ ok: true, status: "PENDING", applied: false, alreadyProcessed: false });
  let nextCreditResponse = null;
  const checkoutQueue = [];
  const requests = [];
  const refs = [];
  const states = { documento: initialCredit.clienteDocumento, activeDocumento: initialCredit.clienteDocumento,
    items: [initialCredit], openCreditId: initialCredit.id, selectedLimit: { [initialCredit.id]: 37 } };
  let stateCursor = 0;
  let refCursor = 0;
  const Active = () => null;
  const Panel = () => null;
  const Paid = () => null;
  const dialogUI = dialogRenderer();
  const dependencies = {
    react: {
      useState(initial) {
        const name = hookNames[stateCursor++];
        assert.ok(name, "El arnés debe corresponder a los hooks reales");
        if (!(name in states)) states[name] = typeof initial === "function" ? initial() : initial;
        return [states[name], (next) => { states[name] = typeof next === "function" ? next(states[name]) : next; }];
      },
      useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
      useEffect: () => {}, useCallback: (callback) => callback,
    },
    "react/jsx-runtime": jsxRuntime, "lucide-react": iconStubs,
    "@/lib/credit-display-number": displayNumber, "./credit-dashboard-presentation": presentation,
    "@/app/clientes/client-active-credit-dashboard": { default: Active },
    "@/app/clientes/client-credit-panel": { default: Panel },
    "@/app/clientes/client-login-screen": { default: Empty },
    "@/app/clientes/paid-credit-dashboard": { default: Paid },
    "./client-nequi-payment-dialog": { default: dialogUI.Component },
    "@/app/clientes/client-nequi-payment-dialog": { default: dialogUI.Component },
  };
  const Page = compile(pageSource, dependencies, {
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    window: { setTimeout: () => 0, clearTimeout: () => {}, location: { search: "", assign: () => { throw new Error("No se permite navegar a un cobro real"); } } },
    fetch: async (url, init = {}) => {
      const method = init.method || "GET";
      requests.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
      if (url === "/api/clientes/wompi-checkout") return checkoutQueue.shift() ?? response({ ok: true,
        paymentMode: "NEQUI_DIRECT", reference: "LOCAL-PAYOFF-81", amount: 2_647_264, status: "PENDING" });
      if (url.startsWith("/api/clientes/wompi-status?")) return statusResponse;
      if (url.startsWith("/api/clientes/creditos?")) {
        const next = nextCreditResponse;
        nextCreditResponse = null;
        return next ?? response({ ok: true, items: [returnedCredit] });
      }
      throw new Error(`URL no simulada: ${url}`);
    },
  });
  let tree;
  function render() {
    stateCursor = 0; refCursor = 0;
    tree = Page();
    assert.equal(stateCursor, hookNames.length);
    return tree;
  }
  const active = () => findNode(tree, (node) => node.type === Active)?.props;
  const panel = () => findNode(tree, (node) => node.type === Panel)?.props;
  const paid = () => findNode(tree, (node) => node.type === Paid)?.props;
  const dialog = () => findNode(tree, (node) => node.type === dialogUI.Component)?.props;
  const dialogTree = () => dialog() ? dialogUI.render(dialog()) : null;
  const dashboardTree = () => active() ? Dashboard(active()) : null;
  function acceptPayoff() {
    active().onPayoff();
    render();
    assert.ok(dialog());
    const terms = findNode(dialogTree(), (node) => node.type === "input" && node.props.type === "checkbox");
    terms.props.onChange({ target: { checked: true } });
    render();
  }
  function submit() {
    findNode(dialogTree(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  }
  async function sendPending() {
    acceptPayoff(); submit(); await settle(); render();
    assert.ok(panel()?.pendingPayment?.reference);
  }
  render();
  return { states, requests, render, active, panel, paid, dialog, dialogTree, dashboardTree,
    acceptPayoff, submit, sendPending, postCount: () => requests.filter((item) => item.method === "POST").length,
    enqueueCheckout: (value) => checkoutQueue.push(value), deferCredit: (value) => { nextCreditResponse = value; },
    setCredit: (value) => { returnedCredit = value; }, setStatus: (body) => { statusResponse = response(body); } };
}
function assertActiveUnchanged(flow, credit) {
  assert.deepEqual(snapshot(flow.states.items), [snapshot(credit)]);
  assert.equal(flow.paid(), undefined);
  assert.equal(flow.active().statusTone, "current");
  assert.equal(flow.active().paidInstallments, 3);
  assert.equal(flow.active().payoff.amount, 2_647_264);
  assert.doesNotMatch(flow.states.notice?.text || "", /aprobado y aplicado|quedaron actualizados/i);
}

test("Liquidar está disponible para el plan revisado al día y muestra el capital conciliado", () => {
  const credit = revisedFixture();
  assert.equal(credit.estadoPago, "AL_DIA");
  assert.equal(credit.liquidacionAnticipada.disponible, true);
  assert.equal(credit.liquidacionAnticipada.capitalPendiente, 2_647_264);
  assert.equal(credit.liquidacionAnticipada.saldoObligacion, 5_051_999);
  const flow = harness(credit);
  const liquidar = findNode(flow.dashboardTree(), (node) => node.type === "button" && textContent(node).startsWith("Liquidar crédito"));
  assert.equal(liquidar.props.disabled, false);
  assert.ok(textContent(liquidar).includes(money(2_647_264)));
  flow.acceptPayoff();
  assert.equal(flow.dialog().amount, 2_647_264);
  assert.equal(flow.dialog().installmentLabel, "Liquidacion anticipada");
  assert.ok(textContent(flow.dialogTree()).includes(money(2_647_264)));
  assert.ok(!textContent(flow.dialogTree()).includes(money(5_051_999)), "No cobra cuotas futuras como si fueran capital");
});

test("el formulario envía liquidación sin cuotas y conserva el cálculo del importe en el servidor", async () => {
  const flow = harness();
  await flow.sendPending();
  assert.equal(flow.postCount(), 1);
  const request = flow.requests.find((item) => item.method === "POST");
  assert.equal(request.url, "/api/clientes/wompi-checkout");
  assert.equal(request.body.paymentMode, "LIQUIDACION_ANTICIPADA");
  assert.equal(request.body.paymentMethod, "NEQUI");
  assert.deepEqual(request.body.cuotaNumeros, []);
  assert.equal(request.body.creditoId, 81);
  assert.equal(request.body.documento, "12345678");
  assert.equal(request.body.nequiPhone, "3001234567");
  assert.equal(request.body.acceptWompiTerms, true);
  assert.equal(Object.hasOwn(request.body, "amount"), false, "El navegador no reemplaza el importe calculado por la API");
  assert.equal(flow.dialog(), undefined);
});

test("cancelar la liquidación no crea cobro ni modifica el crédito", () => {
  const credit = revisedFixture();
  const flow = harness(credit);
  flow.acceptPayoff();
  findNode(flow.dialogTree(), (node) => node.type === "button" && textContent(node) === "Cancelar").props.onClick();
  flow.render();
  assert.equal(flow.dialog(), undefined);
  assert.equal(flow.postCount(), 0);
  assertActiveUnchanged(flow, credit);
});

for (const status of ["PENDING", "APPROVED"]) {
  test(`liquidación ${status} sin aplicación conserva capital y no finaliza el crédito`, async () => {
    const credit = revisedFixture();
    const flow = harness(credit);
    await flow.sendPending();
    assertActiveUnchanged(flow, credit);
    assertPendingPayoffSummary(flow);
    flow.setStatus({ ok: true, status, applied: false, alreadyProcessed: false });
    flow.panel().onRefreshPayment();
    await settle(); flow.render();
    assertActiveUnchanged(flow, credit);
    assert.ok(flow.panel().pendingPayment.reference);
    assert.equal(flow.states.selectedLimit[credit.id], 4, "El refresco conserva la selección ordinaria real");
    assertPendingPayoffSummary(flow);
    flow.active().onPayoff(); flow.render();
    assert.equal(flow.dialog(), undefined, "La referencia pendiente bloquea otra liquidación");
    assert.equal(flow.postCount(), 1);
  });
}

for (const flag of ["applied", "alreadyProcessed"]) {
  test(`la liquidación ${flag} muestra crédito finalizado sólo después de consultar la cartera actualizada`, async () => {
    const credit = revisedFixture();
    const flow = harness(credit);
    await flow.sendPending();
    flow.setStatus({ ok: true, status: "APPROVED", applied: flag === "applied", alreadyProcessed: flag === "alreadyProcessed" });
    const refresh = deferred();
    flow.deferCredit(refresh.promise);
    flow.panel().onRefreshPayment();
    await settle(); flow.render();
    assertActiveUnchanged(flow, credit);
    assert.ok(flow.states.paymentReturn.reference);
    const closed = revisedFixture({ settled: true });
    assert.equal(closed.estadoPago, "PAGADO");
    assert.equal(closed.liquidacionAnticipada.capitalPendiente, 0);
    assert.equal(closed.liquidacionAnticipada.disponible, false);
    refresh.resolve(response({ ok: true, items: [closed] }));
    await settle(); flow.render();
    assert.equal(flow.active(), undefined);
    assert.deepEqual(snapshot(flow.paid().credit), snapshot(closed));
    assert.equal(flow.states.paymentReturn, null);
    assert.equal(flow.states.items[0].saldoPendiente, 0);
    assert.equal(flow.states.items[0].totalPagado, 3_797_264);
    assert.match(flow.states.notice.text, /aprobado y aplicado/i);
    assert.equal(flow.postCount(), 1);
  });
}

test("un error de cartera después de applied conserva el plan y la referencia de liquidación", async () => {
  const credit = revisedFixture();
  const flow = harness(credit);
  await flow.sendPending();
  flow.setStatus({ ok: true, status: "APPROVED", applied: true });
  flow.deferCredit(response({ error: "No se pudo consultar la cartera" }, false));
  flow.panel().onRefreshPayment();
  await settle(); flow.render();
  assertActiveUnchanged(flow, credit);
  assert.ok(flow.states.paymentReturn.reference);
  assert.equal(flow.states.notice.tone, "red");
  flow.active().onPayoff(); flow.render();
  assert.equal(flow.dialog(), undefined);
  assert.equal(flow.postCount(), 1);
});

test("un plan revisado en mora sigue sin liquidación anticipada", () => {
  const credit = revisedFixture({ today: "2026-11-03" });
  assert.equal(credit.estadoPago, "MORA");
  assert.equal(credit.liquidacionAnticipada.disponible, false);
  const flow = harness(credit);
  assert.equal(flow.active().payoff.available, false);
  flow.active().onPayoff(); flow.render();
  assert.equal(flow.dialog(), undefined);
  assert.equal(flow.postCount(), 0);
  assert.equal(flow.states.notice.tone, "red");
});