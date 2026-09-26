import assert from "node:assert/strict";
import test from "node:test";
import { calculatePortfolioProfit, resolvePortfolioInvestment } from "../lib/portfolio-profit.ts";

const base = { outstandingBalance: 0, accumulatedCollections: 0, accumulatedInvestment: 0,
  operatingExpenses: 0, committedCapital: 0, recognizedProfit: 0 };

test("el respaldo ya queda incluido al restar el desembolso neto de 1.800.000", () => {
  assert.equal(calculatePortfolioProfit({...base, outstandingBalance:2_000_000, accumulatedInvestment:1_800_000}),200_000);
});
test("descuenta gastos, capital comprometido y reconocida una sola vez", () => {
  assert.equal(calculatePortfolioProfit({...base, outstandingBalance:2_000_000,accumulatedCollections:500_000,accumulatedInvestment:1_800_000,operatingExpenses:50_000,committedCapital:200_000,recognizedProfit:100_000}),350_000);
});
test("el capital que vuelve a estar al día deja de reducir la proyección", () => {
  const credit={...base,outstandingBalance:2_000_000,accumulatedInvestment:1_800_000};
  assert.equal(calculatePortfolioProfit({...credit,committedCapital:300_000}),-100_000);
  assert.equal(calculatePortfolioProfit(credit),200_000);
});
test("la inversión de créditos pagados permanece y se descuenta su ganancia reconocida", () => {
  assert.equal(calculatePortfolioProfit({...base,accumulatedCollections:2_200_000,accumulatedInvestment:1_800_000,recognizedProfit:400_000}),0);
});
test("pasar saldo a recaudo no cambia la proyección antes de reconocer ganancias", () => {
  const a={...base,outstandingBalance:2_000_000,accumulatedCollections:100_000,accumulatedInvestment:1_800_000};
  assert.equal(calculatePortfolioProfit(a),calculatePortfolioProfit({...a,outstandingBalance:1_900_000,accumulatedCollections:200_000}));
});
test("conserva centavos, pérdidas y cartera vacía; rechaza importes desconocidos", () => {
  assert.equal(calculatePortfolioProfit({...base,outstandingBalance:0.3,accumulatedInvestment:0.1,operatingExpenses:0.2}),0);
  assert.equal(calculatePortfolioProfit({...base,operatingExpenses:12.34}),-12.34);
  assert.equal(calculatePortfolioProfit(base),0);
  assert.throws(()=>calculatePortfolioProfit({...base,accumulatedInvestment:NaN}),RangeError);
});

test("la inversión histórica sin liquidación usa capital menos respaldo y queda identificada", () => {
  assert.deepEqual(resolvePortfolioInvestment({authorizedCapital:2_000_000,backingPercentage:10,recordedNetInvestment:null}),{amount:1_800_000,estimated:true});
});
test("los importes registrados prevalecen aunque cambie el porcentaje actual del aliado", () => {
  assert.deepEqual(resolvePortfolioInvestment({authorizedCapital:2_000_000,backingPercentage:20,recordedNetInvestment:1_800_000}),{amount:1_800_000,estimated:false});
  assert.deepEqual(resolvePortfolioInvestment({authorizedCapital:2_000_000,backingPercentage:10,recordedNetInvestment:0}),{amount:0,estimated:false});
});
