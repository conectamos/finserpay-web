import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const projectRoot = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const current = await jiti.import("../lib/credit-early-payoff.ts");
const components = await jiti.import("../lib/mass-credit-financial-components.ts");
const dependencies = {};
for (const name of ["credit-payment-plan", "credit-capital", "credit-principal-payment", "wompi-early-payoff-intent"]) {
  dependencies[`@/lib/${name}`] = await jiti.import(`../lib/${name}.ts`);
}
const oldSource = readFileSync(new URL("./fixtures/credit-early-payoff-before-mass-insurance.txt", import.meta.url), "utf8");
const oldOutput = ts.transpileModule(oldSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const baselineModule = { exports: {} };
runInNewContext(oldOutput, {
  module: baselineModule, exports: baselineModule.exports,
  require(name) {
    if (!(name in dependencies)) throw new Error(`Unexpected baseline dependency ${name}`);
    return dependencies[name];
  },
  Date, Math, Number, String, Array, Object, Boolean,
});
const baseline = {
  calculateCreditEarlyPayoff: input => JSON.parse(JSON.stringify(baselineModule.exports.calculateCreditEarlyPayoff(input))),
  buildEarlyPayoffIntentMeta: input => JSON.parse(JSON.stringify(baselineModule.exports.buildEarlyPayoffIntentMeta(input))),
};
const cents = value => Math.round(value * 100);

function credit() {
  const marker = components.calculateMassCreditComponents({
    capital: 2800000, cuota: 119350, numeroCuotas: 48,
    fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03,
  });
  return {
    montoCredito: marker.total, saldoBaseFinanciado: marker.capital,
    valorCuota: marker.cuota, plazoMeses: marker.numeroCuotas,
    valorInteres: marker.intereses, valorFianza: marker.fianza,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2030-09-17", today: "2026-09-26",
    contratoSnapshot: {
      origen: { tipo: "IMPORTACION_MASIVA", batchId: "SYNTHETIC_SIX_BATCH", audit: "keep" },
      cliente: { nombre: "Synthetic customer" },
      financiero: { componentesMasivos: { ...marker, audit: "classified by authorized correction" }, valorSeguro: marker.seguro },
    },
    abonos: [{ valor: marker.cuota, fechaAbono: "2026-09-20" }],
  };
}

for (const state of ["absent", "unversioned", "stale total", "stale principal", "stale surety", "stale interest", "stale quota", "stale term"]) {
  test(`a ${state} marker retains the complete previous payoff result and metadata`, () => {
    const input = credit();
    if (state === "absent") delete input.contratoSnapshot;
    if (state === "unversioned") delete input.contratoSnapshot.financiero.componentesMasivos.version;
    if (state === "stale total") input.montoCredito += 1;
    if (state === "stale principal") input.saldoBaseFinanciado += 1;
    if (state === "stale surety") input.valorFianza += 1;
    if (state === "stale interest") input.valorInteres += 1;
    if (state === "stale quota") input.valorCuota += 1;
    if (state === "stale term") input.plazoMeses += 1;
    const actual = current.calculateCreditEarlyPayoff(input);
    assert.deepEqual(actual, baseline.calculateCreditEarlyPayoff(input));
    assert.deepEqual(current.buildEarlyPayoffIntentMeta(actual), baseline.buildEarlyPayoffIntentMeta(actual));
    assert.equal("valorSeguroReconocido" in actual, false);
  });
}

test("ordinary credits preserve every previous quote and result over varied balances and frequencies", () => {
  for (const principal of [100, 600000, 2800000]) {
    for (const count of [1, 12, 48]) {
      for (const frequency of ["MENSUAL", "CATORCENAL", "QUINCENAL"]) {
        for (const paidShare of [0, 0.1, 0.5, 1]) {
          const quota = Math.ceil(principal * 2 / count);
          const input = {
            saldoBaseFinanciado: principal, montoCredito: quota * count,
            valorCuota: quota, plazoMeses: count, frecuenciaPago: frequency,
            valorFianza: principal * 0.75, valorInteres: quota * count - principal * 1.75,
            fechaPrimerPago: "2030-09-17", today: "2026-09-26",
            abonos: [{ valor: Math.round(quota * count * paidShare * 100) / 100 }],
          };
          assert.deepEqual(current.calculateCreditEarlyPayoff(input), baseline.calculateCreditEarlyPayoff(input));
        }
      }
    }
  }
});

test("a valid correction preserves the quote and splits recognized charges into interest, surety and insurance", () => {
  const input = credit();
  const before = structuredClone(input);
  const originalImported = { ...input, valorFianza: 0, valorInteres: input.montoCredito - input.saldoBaseFinanciado };
  delete originalImported.contratoSnapshot;
  const oldQuote = baseline.calculateCreditEarlyPayoff(originalImported);
  const actual = current.calculateCreditEarlyPayoff(input);
  assert.deepEqual(current.buildEarlyPayoffIntentMeta(actual), baseline.buildEarlyPayoffIntentMeta(oldQuote));
  assert.equal(actual.eligible, oldQuote.eligible);
  assert.equal(actual.estadoPago, oldQuote.estadoPago);
  assert.equal(actual.capitalPendiente, oldQuote.capitalPendiente);
  assert.equal(actual.interesFianzaCondonado, oldQuote.interesFianzaCondonado);
  assert.ok(actual.valorSeguroReconocido > 0);
  assert.equal(cents(actual.valorInteresReconocido) + cents(actual.valorFianzaReconocida) + cents(actual.valorSeguroReconocido),
    cents(actual.montoCreditoLiquidado) - cents(actual.capitalOriginal));
  assert.deepEqual(input, before);
});

test("a simulated close retains a matching current marker and the original imported quota, term and audit", () => {
  const input = credit();
  const before = structuredClone(input.contratoSnapshot);
  const payoff = current.calculateCreditEarlyPayoff(input);
  const amounts = {
    montoCredito: payoff.montoCreditoLiquidado, valorFianza: payoff.valorFianzaReconocida,
    valorInteres: payoff.valorInteresReconocido, valorSeguro: payoff.valorSeguroReconocido,
  };
  const next = components.updateMassCreditComponentsForPayoff(input.contratoSnapshot, amounts);
  const closed = { ...input, ...amounts, contratoSnapshot: next };
  const marker = components.readMassCreditComponents(next, closed);
  assert.ok(marker);
  assert.equal(marker.liquidacionAnticipada, true);
  assert.equal(marker.cuota, input.valorCuota);
  assert.equal(marker.numeroCuotas, input.plazoMeses);
  assert.equal(components.getMassCreditInsurance(closed), payoff.valorSeguroReconocido);
  assert.equal(marker.total, marker.capital + marker.fianza + marker.intereses + marker.seguro);
  assert.equal(next.financiero.componentesMasivos.audit, before.financiero.componentesMasivos.audit);
  assert.deepEqual(next.origen, before.origen);
  assert.deepEqual(next.cliente, before.cliente);
  assert.deepEqual(input.contratoSnapshot, before);
});

test("the recognized three-component allocation reconciles at the cent for small and large prior payments", () => {
  for (const paid of [0, 0.01, 0.03, 1, 7.51, 119350, 238700, 1250000.03, 5728799.99]) {
    const input = credit();
    input.abonos = [{ valor: paid }];
    const payoff = current.calculateCreditEarlyPayoff(input);
    const total = cents(payoff.valorInteresReconocido) + cents(payoff.valorFianzaReconocida) + cents(payoff.valorSeguroReconocido);
    assert.equal(total, cents(payoff.montoCreditoLiquidado) - cents(payoff.capitalOriginal));
    assert.ok(payoff.valorInteresReconocido >= 0 && payoff.valorInteresReconocido <= input.valorInteres);
    assert.ok(payoff.valorFianzaReconocida >= 0 && payoff.valorFianzaReconocida <= input.valorFianza);
    assert.ok(payoff.valorSeguroReconocido >= 0 && payoff.valorSeguroReconocido <= 40320);
  }
});
