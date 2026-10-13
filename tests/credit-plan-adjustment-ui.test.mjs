import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const apiSource = readFileSync(new URL("../app/api/creditos/route.ts", import.meta.url), "utf8");
const consoleSource = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");

function declaration(source, name, kind = ts.ScriptKind.TS) {
  const file = ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.Latest, true, kind);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(file);
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) found = `const ${node.getText(file)};`;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, `Production declaration ${name} must exist`);
  return found;
}

const commercialSource = ["readCommercialInstallmentFromSnapshot", "resolveCommercialInstallment"]
  .map(name => declaration(apiSource, name)).join("\n");
const commercialContext = vm.createContext({ Number, Math });
vm.runInContext(ts.transpileModule(commercialSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, commercialContext);
const resolveInstallment = commercialContext.resolveCommercialInstallment;

function listedCredit(changes = {}) {
  return {
    plazoMeses: 16, frecuenciaPago: "QUINCENAL", montoCredito: 2_050_000,
    valorCuota: 128_125, contratoSnapshot: { financiero: { cuotaComercial: 128_900 } },
    amortizacion: { cuotaComercial: "128900.00", numeroCuotas: 16, frecuenciaPago: "QUINCENAL", totalPagar: "2050000.000000" },
    ...changes,
  };
}

test("credit listings retain the original commercial installment when operative terms have not changed", () => {
  assert.equal(resolveInstallment(listedCredit()), 128_900);
});

for (const [name, change] of [
  ["term", { plazoMeses: 20 }],
  ["frequency", { frecuenciaPago: "MENSUAL" }],
  ["total", { montoCredito: 2_100_000 }],
]) {
  test(`after an administrative ${name} revision the credit listing shows its actual operative installment`, () => {
    const credit = listedCredit({ ...change, valorCuota: 113_450 });
    const original = structuredClone(credit.amortizacion);
    const signed = structuredClone(credit.contratoSnapshot);
    assert.equal(resolveInstallment(credit), 113_450);
    assert.deepEqual(credit.amortizacion, original);
    assert.deepEqual(credit.contratoSnapshot, signed);
  });
}

test("legacy listing fallbacks retain their negotiated snapshot or operative installment", () => {
  assert.equal(resolveInstallment(listedCredit({ amortizacion: null })), 128_900);
  assert.equal(resolveInstallment(listedCredit({ amortizacion: null, contratoSnapshot: null })), 128_125);
});

const updateCode = ts.transpileModule(declaration(consoleSource, "updateCreditPlan", ts.ScriptKind.TSX), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function adjustmentFixture(overrides = {}) {
  const requests = [], notices = [], confirmations = [], setters = [];
  const state = {
    updatingPlan: false, runningCommand: null, canAdmin: true, canSeeInternalPricing: true,
    selectedCredit: { id: 17, plazoMeses: 16, frecuenciaPago: "QUINCENAL", updatedAt: "2026-10-13T12:00:00.000Z" },
    planInstallments: "20", planFrequency: "MENSUAL", planFirstPaymentDate: "2026-11-17",
    planAdjustmentReason: "Corrección administrativa solicitada", confirm: true,
    ...overrides,
  };
  const returned = { ...state.selectedCredit, plazoMeses: 20, frecuenciaPago: "MENSUAL",
    fechaPrimerPago: "2026-11-17T12:00:00Z", fechaProximoPago: "2026-12-17T12:00:00Z" };
  const context = vm.createContext({
    ...state, Number, Math, JSON, Error,
    DEFAULT_PAYMENT_FREQUENCY: "QUINCENAL",
    normalizePaymentFrequency: value => value,
    getPaymentFrequencyLabel: value => value,
    dateOnly: value => value?.slice(0, 10) || "",
    window: { confirm: message => { confirmations.push(message); return state.confirm; } },
    setNotice: notice => notices.push(notice),
    ...Object.fromEntries(["UpdatingPlan", "RunningCommand", "PlanAdjustmentReason", "PlanInstallments", "PlanFrequency", "PlanFirstPaymentDate", "NextDueDate"]
      .map(name => [`set${name}`, value => setters.push([name, value])])),
    requestJson: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return state.response || { ok: true, data: { item: returned, message: "Plan ajustado" } };
    },
    upsertCredit: item => setters.push(["credit", item]),
    loadPayments: async id => setters.push(["payments", id]),
  });
  vm.runInContext(`${updateCode}\nglobalThis.runAdjustment = updateCreditPlan;`, context);
  return { state, requests, notices, confirmations, setters, run: () => context.runAdjustment() };
}

test("central adjustment confirms explicitly and sends selected credit, motive and optimistic version", async () => {
  const f = adjustmentFixture();
  await f.run();
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/creditos/17/command");
  assert.deepEqual(f.requests[0].body, { command: "update-plan", plazoMeses: 20, frecuenciaPago: "MENSUAL",
    fechaPrimerPago: "2026-11-17", expectedUpdatedAt: "2026-10-13T12:00:00.000Z",
    observacionAdmin: "Corrección administrativa solicitada" });
  assert.ok(f.setters.some(([name, value]) => name === "PlanAdjustmentReason" && value === ""));
  assert.ok(f.setters.some(([name, value]) => name === "NextDueDate" && value === "2026-12-17"));
});

test("missing central motive blocks confirmation and requests", async () => {
  const f = adjustmentFixture({ planAdjustmentReason: "Corto" });
  await f.run();
  assert.equal(f.requests.length, 0);
  assert.equal(f.confirmations.length, 0);
  assert.match(f.notices.at(-1).text, /motivo/);
});

test("cancelling the financial confirmation preserves form data and makes no request", async () => {
  const f = adjustmentFixture({ confirm: false });
  await f.run();
  assert.equal(f.requests.length, 0);
  assert.equal(f.setters.length, 0);
});

for (const busy of [{ updatingPlan: true }, { runningCommand: "update-plan" }]) {
  test(`an active operation blocks duplicate plan requests: ${Object.keys(busy)[0]}`, async () => {
    const f = adjustmentFixture(busy);
    await f.run();
    assert.equal(f.confirmations.length, 0);
    assert.equal(f.requests.length, 0);
  });
}

test("failed plan updates preserve motive and fields for correction", async () => {
  const f = adjustmentFixture({ response: { ok: false, data: { error: "El crédito cambió" } } });
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.match(f.notices.at(-1).text, /crédito cambió/);
  assert.equal(f.setters.some(([name]) => name === "PlanAdjustmentReason" || name === "credit"), false);
  assert.ok(f.setters.some(([name, value]) => name === "UpdatingPlan" && value === false));
});
