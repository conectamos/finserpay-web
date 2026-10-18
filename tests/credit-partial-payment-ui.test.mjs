import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("credit-factory-console.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const astNodes = predicate => {
  const matches = [];
  const visit = node => { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(parsed);
  return matches;
};
const declaration = name => {
  const matches = astNodes(node => ts.isVariableDeclaration(node) && node.name.getText(parsed) === name);
  assert.equal(matches.length, 1, `Expected one production declaration: ${name}`);
  return `const ${matches[0].getText(parsed)};`;
};
function execute(code, context = {}) {
  return runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { require, exports: {}, Error, ...context }, { timeout: 1000 });
}
const amountModule = { exports: {} };
runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/manual-payment-amount.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: amountModule, exports: amountModule.exports });
const currency = value => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
const derivedNames = [
  "earlyPayoffAvailable", "isEarlyPayoffMode", "payableInstallments", "paymentBlockedByAnnulment",
  "selectedInstallmentSet", "selectedInstallmentsData", "selectedInstallmentTotal", "selectedInstallmentRoundedTotal",
  "creditPendingRoundedTotal", "earlyPayoffRoundedTotal", "paymentTargetRoundedTotal", "paymentAmountToApply",
  "displayAppliedPaymentAmount", "receivedPaymentAmount", "selectedInstallmentCoverageShortfall", "isPartialInstallmentPayment",
  "paymentOverCreditAmount", "paymentAdvanceAmount", "paymentChangeAmount", "paymentShortfallAmount", "paymentSubmitBlocked",
  "selectedOverdueTotal", "allPayableInstallmentsSelected",
];
const fixture = (overrides = {}) => ({
  paymentRegisterMode: "INSTALLMENTS", paymentOperation: "installments", paymentValue: "100000", receivedPaymentValue: "100000",
  selectedCredit: { id: 701, folio: "QA-701", clienteNombre: "CLIENTE DE PRUEBA", estado: "ACTIVO", saldoPendiente: 255800 },
  paymentOverview: { id: 701, estado: "ACTIVO", saldoPendiente: 255800, totalAbonado: 255800, plan: [
    { numero: 3, saldoPendiente: 127900, valorProgramado: 127900, estaEnMora: true, fechaVencimiento: "2026-10-17" },
    { numero: 4, saldoPendiente: 127900, valorProgramado: 127900, estaEnMora: false, fechaVencimiento: "2026-11-02" },
  ] },
  earlyPayoffSummary: { disponible: false, capitalPendiente: 200000 }, selectedInstallmentNumbers: ["3"],
  isCreditAnnulled: state => state === "ANULADO", resolveSelectedPaymentAmount: amountModule.exports.resolveSelectedPaymentAmount,
  paymentMethod: "BANCOLOMBIA", paymentObservation: "Abono a cuota 3", registeringPayment: false, principalPaymentBusy: false,
  loadingPayments: false, showAllPaymentInstallments: false, showPaymentConfirmation: false, ...overrides,
});
function calculations(overrides = {}) {
  const context = fixture(overrides);
  return Object.assign(context, execute(derivedNames.map(declaration).join("\n") + `\n({${derivedNames.join(",")}})`, context));
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== "object" ? [] : [tree, ...nodes(tree.props?.children)];
function jsxElementByClass(className) {
  const matches = astNodes(node => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(parsed) === "className" &&
      attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text.split(" ").includes(className)));
  assert.equal(matches.length, 1, className);
  return matches[0].getText(parsed);
}
function paymentView(overrides = {}) {
  const changes = [];
  const Icon = () => null;
  const context = calculations(overrides);
  Object.assign(context, {
    paymentDisplayCurrency: currency, currencyInputValue: value => value ? currency(Number(value)) : "", paymentDueDate: date => date,
    PAYMENT_METHOD_OPTIONS: [{ value: "BANCOLOMBIA", label: "Bancolombia" }],
    Banknote: Icon, ArrowRight: Icon, LockKeyhole: Icon, Download: Icon, ChevronDown: Icon, RotateCcw: Icon,
  });
  for (const name of ["setPaymentValue", "setReceivedPaymentValue", "setPaymentObservation", "setPaymentMethod", "setShowPaymentConfirmation", "setShowAllPaymentInstallments", "toggleAllPayableInstallments", "updateSelectedInstallments", "downloadPlanPagos", "setPaymentRegisterMode", "setPaymentOperation", "setSelectedInstallmentNumbers"]) {
    context[name] = value => changes.push([name, value]);
  }
  const tree = execute(`(${jsxElementByClass("fp-payment-checkout")})`, context);
  const button = nodes(tree).find(node => node.type === "button" && node.props.onClick?.toString().includes("setShowPaymentConfirmation"));
  return { tree, button, changes, context, html: renderToStaticMarkup(tree) };
}
function handlerFixture(overrides = {}) {
  const changes = [];
  const requests = [];
  const opened = [];
  let response = async () => ({ ok: true, data: { item: { id: 901 }, message: "Abono registrado", summary: { saldoPendiente: 155800 } } });
  const context = calculations(overrides);
  Object.assign(context, {
    registeringPaymentRef: { current: false }, currency, activeSearch: "consulta conservada", window: { open: (...args) => opened.push(args) },
    requestJson: async (url, init) => { requests.push({ url, ...init }); return response(url, init); },
    loadPayments: async id => changes.push(["loadPayments", id]), loadCredits: async (...args) => changes.push(["loadCredits", ...args]),
  });
  for (const [name, field] of [
    ["setNotice", "notice"], ["setRegisteringPayment", "registeringPayment"], ["setPaymentValue", "paymentValue"],
    ["setReceivedPaymentValue", "receivedPaymentValue"], ["setPaymentObservation", "paymentObservation"],
    ["setPaymentRegisterMode", "paymentRegisterMode"], ["setPaymentOperation", "paymentOperation"], ["setSelectedInstallmentNumbers", "selectedInstallmentNumbers"],
  ]) context[name] = value => { changes.push([name, value]); context[field] = value; };
  const run = execute(`${declaration("registerPayment")}\nregisterPayment`, context);
  return { context, changes, requests, opened, run, respond: callback => { response = callback; } };
}

test("a selected $127900 installment accepts $100000 and reports the exact $27900 remainder", () => {
  const view = paymentView();
  assert.equal(view.context.paymentSubmitBlocked, false);
  assert.equal(view.context.displayAppliedPaymentAmount, 100000);
  assert.equal(view.context.selectedInstallmentCoverageShortfall, 27900);
  assert.equal(view.button.props.disabled, false);
  assert.match(view.html, /Saldo pendiente de la selección/);
  assert.match(view.html, /27\.900/);
  assert.match(view.html, /abono parcial/);
  assert.match(view.html, /conserva su vencimiento/);
  assert.doesNotMatch(view.html, /Abono insuficiente/);
  view.button.props.onClick();
  assert.deepEqual(view.changes, [["setShowPaymentConfirmation", true]]);
});

test("partial amounts are editable through the production amount and received fields", () => {
  const view = paymentView();
  assert.match(view.html, /Abono parcial u otro valor/);
  assert.match(view.html, /Monto a abonar/);
  const amount = nodes(view.tree).find(node => node.props?.id === "payment-amount-to-apply");
  const received = nodes(view.tree).find(node => node.props?.["aria-label"] === "Valor recibido");
  assert.equal(amount.props.disabled, false);
  amount.props.onChange({ target: { value: "$ 50.000" } });
  received.props.onChange({ target: { value: "$ 60.000" } });
  assert.deepEqual(view.changes, [["setPaymentValue", "50000"], ["setReceivedPaymentValue", "60000"]]);
});

test("zero amounts, overpayments and missing received cash stay blocked", async () => {
  for (const override of [{ paymentValue: "0" }, { paymentValue: "300000", receivedPaymentValue: "300000" }, { receivedPaymentValue: "99999" }]) {
    const view = paymentView(override);
    assert.equal(view.context.paymentSubmitBlocked, true);
    assert.equal(view.button.props.disabled, true);
    const handler = handlerFixture(override);
    await handler.run();
    assert.equal(handler.requests.length, 0);
    assert.equal(handler.context.notice.tone, "red");
  }
});

test("annulled credits and loading or concurrent financial operations stay blocked", async () => {
  for (const key of ["registeringPayment", "principalPaymentBusy", "loadingPayments"]) {
    assert.equal(paymentView({ [key]: true }).button.props.disabled, true, key);
  }
  const handler = handlerFixture({ selectedCredit: { id: 701, estado: "ANULADO" } });
  await handler.run();
  assert.equal(handler.requests.length, 0);
  assert.match(handler.context.notice.text, /anulado/);
});

test("full payments, selected future advances and cash change keep their existing meanings", () => {
  const full = calculations({ paymentValue: "127900", receivedPaymentValue: "127900" });
  assert.equal(full.isPartialInstallmentPayment, false);
  assert.equal(full.paymentSubmitBlocked, false);
  const advance = calculations({ paymentValue: "150000", receivedPaymentValue: "170000" });
  assert.equal(advance.paymentAdvanceAmount, 22100);
  assert.equal(advance.paymentChangeAmount, 20000);
  assert.equal(advance.paymentSubmitBlocked, false);
  const partialChange = calculations({ paymentValue: "100000", receivedPaymentValue: "110000" });
  assert.equal(partialChange.selectedInstallmentCoverageShortfall, 27900);
  assert.equal(partialChange.paymentChangeAmount, 10000);
});

test("a payment across two selected installments leaves only the actual remaining amount", () => {
  const state = calculations({ selectedInstallmentNumbers: ["3", "4"], paymentValue: "200000", receivedPaymentValue: "200000" });
  assert.equal(state.selectedInstallmentTotal, 255800);
  assert.equal(state.selectedInstallmentCoverageShortfall, 55800);
  assert.equal(state.paymentSubmitBlocked, false);
});

test("the confirmation explains the partial remainder and cancelling never registers a payment", () => {
  const matching = astNodes(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === "ConfirmDialog" && node.getText(parsed).includes('title="Confirmar registro del pago"'));
  assert.equal(matching.length, 1);
  let submissions = 0;
  let visible = true;
  const ConfirmDialog = () => null;
  const tree = execute(`(${matching[0].getText(parsed)})`, {
    ...calculations(), ConfirmDialog, paymentDisplayCurrency: currency, paymentMethodLabel: () => "Bancolombia",
    showPaymentConfirmation: true, setShowPaymentConfirmation: value => { visible = value; }, registerPayment: () => { submissions++; },
  });
  assert.match(tree.props.description, /100\.000/);
  assert.match(tree.props.description, /27\.900 pendientes/);
  assert.match(tree.props.description, /conservando su vencimiento/);
  tree.props.onCancel();
  assert.equal(visible, false);
  assert.equal(submissions, 0);
  tree.props.onConfirm();
  assert.equal(submissions, 1);
});

test("the real submit handler posts a partial CUOTAS payment and refreshes plan, balance and receipt", async () => {
  const app = handlerFixture();
  await app.run();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url, "/api/creditos/701/abonos");
  const body = JSON.parse(app.requests[0].body);
  assert.equal(body.valor, "100000");
  assert.deepEqual(body.cuotaNumeros, ["3"]);
  assert.equal(body.tipoAbono, "CUOTAS");
  assert.equal(body.liquidacionAnticipada, false);
  assert.equal(body.metodoPago, "BANCOLOMBIA");
  assert.equal(body.totalAbonadoEsperado, 255800);
  assert.equal(body.observacion, "Abono a cuota 3");
  assert.ok(app.changes.some(([name, id]) => name === "loadPayments" && id === 701));
  assert.ok(app.changes.some(([name]) => name === "loadCredits"));
  assert.match(app.opened[0][0], /QA-701\/abonos\/901\/recibo$/);
  assert.equal(app.context.paymentValue, "");
  assert.equal(app.context.receivedPaymentValue, "");
  assert.equal(app.context.registeringPaymentRef.current, false);
});

test("a rapid double click cannot register the partial payment twice", async () => {
  let release;
  const app = handlerFixture();
  app.respond(() => new Promise(resolve => { release = resolve; }));
  const first = app.run();
  await app.run();
  assert.equal(app.requests.length, 1);
  assert.equal(app.context.registeringPaymentRef.current, true);
  release({ ok: true, data: { item: { id: 901 }, message: "Abono registrado", summary: { saldoPendiente: 155800 } } });
  await first;
  assert.equal(app.context.registeringPaymentRef.current, false);
});

test("a server or network error preserves amount, cash, method, selection and observation without automatic retries", async () => {
  for (const fail of [async () => ({ ok: false, data: { error: "No fue posible guardar el abono" } }), async () => { throw new Error("Conexión interrumpida"); }]) {
    const app = handlerFixture();
    app.respond(fail);
    await app.run();
    assert.equal(app.requests.length, 1);
    assert.equal(app.context.paymentValue, "100000");
    assert.equal(app.context.receivedPaymentValue, "100000");
    assert.equal(app.context.paymentMethod, "BANCOLOMBIA");
    assert.deepEqual(app.context.selectedInstallmentNumbers, ["3"]);
    assert.equal(app.context.paymentObservation, "Abono a cuota 3");
    assert.equal(app.context.notice.tone, "red");
    assert.equal(app.opened.length, 0);
    assert.equal(app.context.registeringPaymentRef.current, false);
  }
});

test("a changed plan refreshes the authoritative balance and clears the stale confirmation without retrying the payment", async () => {
  const app = handlerFixture();
  app.respond(async () => ({ ok: false, status: 409, data: { code: "PAYMENT_PLAN_CHANGED", error: "Plan cambiado" } }));
  await app.run();
  assert.equal(app.requests.length, 1);
  assert.ok(app.changes.some(([name, id]) => name === "loadPayments" && id === 701));
  assert.equal(app.context.paymentValue, "");
  assert.equal(app.context.receivedPaymentValue, "");
  assert.equal(app.context.selectedInstallmentNumbers.length, 0);
  assert.equal(app.context.paymentObservation, "");
  assert.equal(app.context.paymentMethod, "BANCOLOMBIA");
  assert.match(app.context.notice.text, /revisa el saldo/);
  assert.equal(app.context.notice.tone, "red");
  assert.equal(app.opened.length, 0);
  assert.equal(app.context.registeringPaymentRef.current, false);
});

test("early payoff remains restricted and keeps the capital amount rather than allowing partial payoff", async () => {
  const blocked = handlerFixture({ paymentRegisterMode: "PAYOFF" });
  await blocked.run();
  assert.equal(blocked.requests.length, 0);
  const app = handlerFixture({ paymentRegisterMode: "PAYOFF", earlyPayoffSummary: { disponible: true, capitalPendiente: 200000 }, paymentValue: "200000", receivedPaymentValue: "200000" });
  await app.run();
  const body = JSON.parse(app.requests[0].body);
  assert.equal(body.valor, "200000");
  assert.equal(body.tipoAbono, "LIQUIDACION_ANTICIPADA");
  assert.deepEqual(body.cuotaNumeros, []);
  assert.equal(body.liquidacionAnticipada, true);
});
