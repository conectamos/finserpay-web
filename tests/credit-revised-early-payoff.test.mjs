import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.resolve(import.meta.dirname, "..") },
});
const { calculateCreditEarlyPayoff, buildEarlyPayoffIntentMeta, isCurrentRevisedEarlyPayoffIntent } = await jiti.import("../lib/credit-early-payoff.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { createPrincipalPaymentQuote, parseCapitalPlanSnapshot } = await jiti.import("../lib/credit-principal-payment.ts");

// Anonymized documentary reference already audited by credit-principal-payment.test.mjs.
// No identifiers, payment network or database writes.
const terms = {
  montoCredito: 149700 * 48,
  valorCuota: 149700,
  plazoMeses: 48,
  frecuenciaPago: "QUINCENAL",
  fechaPrimerPago: "2026-09-17",
  today: "2026-09-26",
};
const source = {
  capitalPendiente: 3347264,
  tasaPeriodo: 0.010881,
  cuotaCredito: 94470,
  fianzaCuota: 54180,
  seguroCuota: 1050,
  numeroProximaCuota: 4,
  fuente: "Plan de origen verificado al corte de la prueba",
};

function makeRevisedCredit() {
  const priorPayments = [{ id: 1, valor: 150000 }, { id: 2, valor: 300000 }];
  const quote = createPrincipalPaymentQuote({
    plan: buildCreditPaymentPlan({ ...terms, abonos: priorPayments }),
    valor: 700000,
    capitalOriginal: 3500000,
    cuotaHabitual: 149700,
    abonos: priorPayments,
    conciliacion: structuredClone(source),
  });
  const snapshot = structuredClone(quote.planCapitalVigente);
  snapshot.abonosAlCorte.push({ id: 3, valor: 700000 });
  parseCapitalPlanSnapshot(snapshot);
  return {
    ...terms,
    montoCredito: quote.montoCreditoActualizado,
    saldoBaseFinanciado: 3500000,
    valorInteres: 1084960,
    valorFianza: 2600640,
    planCapitalVigente: snapshot,
    abonos: [...priorPayments, { id: 3, valor: 700000 }],
  };
}

function assertQuote(payoff, expected) {
  assert.equal(payoff.estadoPago, "AL_DIA");
  assert.equal(payoff.eligible, true);
  assert.equal(payoff.reason, null);
  assert.equal(payoff.totalAbonado, expected.paid);
  assert.equal(payoff.capitalPendiente, expected.capital);
  assert.equal(payoff.capitalAbonado, 3500000 - expected.capital);
  assert.equal(payoff.saldoObligacion, expected.balance);
  assert.equal(payoff.interesFianzaCondonado, expected.waived);
  assert.equal(payoff.montoCreditoLiquidado, expected.closedTotal);
}

test("an audited current revision offers only the actual principal, not a proportion of the rewritten obligation", () => {
  const input = makeRevisedCredit();
  const before = structuredClone(input);
  const payoff = calculateCreditEarlyPayoff(input);
  assertQuote(payoff, {
    paid: 1150000,
    capital: 2647264,
    balance: 5051999,
    waived: 2404735,
    closedTotal: 3797264,
  });
  assert.equal(payoff.capitalOriginal, 3500000);
  assert.equal(payoff.montoCreditoOriginal, 6201999);
  assert.notEqual(payoff.capitalPendiente, Math.round(3500000 * (1 - 1150000 / 6201999) * 100) / 100);
  assert.equal(Math.round((payoff.valorInteresReconocido + payoff.valorFianzaReconocida) * 100) / 100, 297264);
  assert.deepEqual(buildEarlyPayoffIntentMeta(payoff), {
    tipo: "LIQUIDACION_ANTICIPADA",
    capitalPendiente: 2647264,
    condonacion: 2404735,
    montoCreditoLiquidado: 3797264,
    saldoObligacion: 5051999,
    planRevision: 1,
    totalAbonado: 1150000,
  });
  assert.deepEqual(input, before, "quoting never changes the audited snapshot or receipts");
});

for (const [title, payment, capital, balance, waived, closedTotal] of [
  ["a later interest-only partial", 5000, 2647264, 5046999, 2399735, 3802264],
  ["a later partial reaching surety", 50000, 2647264, 5001999, 2354735, 3847264],
  ["a later partial reaching principal", 100000, 2630399, 4951999, 2321600, 3880399],
  ["the remaining ordinary installment", 148800, 2581599, 4903199, 2321600, 3880399],
  ["a payment spanning two revised installments", 248800, 2564919, 4803199, 2238280, 3963719],
]) {
  test(`${title} is allocated against the current ledger exactly once`, () => {
    const input = makeRevisedCredit();
    input.abonos.push({ id: 4, valor: payment });
    assertQuote(calculateCreditEarlyPayoff(input), {
      paid: 1150000 + payment, capital, balance, waived, closedTotal,
    });
  });
}

test("a second principal revision quotes its own remaining ledger without reverting to the first revision", () => {
  const input = makeRevisedCredit();
  input.abonos.push({ id: 4, valor: 148800 });
  const before = structuredClone(input.planCapitalVigente);
  const quote = createPrincipalPaymentQuote({
    plan: buildCreditPaymentPlan(input),
    planCapitalVigente: input.planCapitalVigente,
    abonos: input.abonos,
    valor: 200000,
    capitalOriginal: 3500000,
    cuotaHabitual: 149700,
  });
  const snapshot = structuredClone(quote.planCapitalVigente);
  snapshot.abonosAlCorte.push({ id: 5, valor: 200000 });
  parseCapitalPlanSnapshot(snapshot);
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(input.planCapitalVigente, before);
  const revised = {
    ...input,
    montoCredito: quote.montoCreditoActualizado,
    planCapitalVigente: snapshot,
    abonos: [...input.abonos, { id: 5, valor: 200000 }],
  };
  assertQuote(calculateCreditEarlyPayoff(revised), {
    paid: 1498800,
    capital: 2381599,
    balance: 4455915,
    waived: 2074316,
    closedTotal: 3880399,
  });
});

test("arrears retain the exact revised principal but cannot be liquidated from the client portal", () => {
  const payoff = calculateCreditEarlyPayoff({ ...makeRevisedCredit(), today: "2026-11-03" });
  assert.equal(payoff.estadoPago, "MORA");
  assert.equal(payoff.eligible, false);
  assert.match(payoff.reason, /al dia/i);
  assert.equal(payoff.capitalPendiente, 2647264);
  assert.equal(payoff.saldoObligacion, 5051999);
});

test("the due day itself remains current for a valid revised payoff", () => {
  const payoff = calculateCreditEarlyPayoff({ ...makeRevisedCredit(), today: "2026-11-02" });
  assert.equal(payoff.estadoPago, "AL_DIA");
  assert.equal(payoff.eligible, true);
  assert.equal(payoff.capitalPendiente, 2647264);
});

test("ordinary full payment of the revised obligation cannot offer another liquidation", () => {
  const input = makeRevisedCredit();
  input.abonos.push({ id: 4, valor: 5051999 });
  const payoff = calculateCreditEarlyPayoff({ ...input, today: "2030-01-01" });
  assert.equal(payoff.estadoPago, "PAGADO");
  assert.equal(payoff.eligible, false);
  assert.match(payoff.reason, /pagado/i);
  assert.equal(payoff.totalAbonado, 6201999);
  assert.equal(payoff.capitalPendiente, 0);
  assert.equal(payoff.saldoObligacion, 0);
  assert.equal(payoff.interesFianzaCondonado, 0);
});

test("an issued settlement closes revised balances while preserving its audited snapshot and actual cash", () => {
  const input = makeRevisedCredit();
  const before = structuredClone(input.planCapitalVigente);
  input.abonos.push({ id: 4, valor: 2647264 });
  const payoff = calculateCreditEarlyPayoff({
    ...input,
    montoCredito: 3797264,
    settled: true,
    today: "2030-01-01",
  });
  assert.equal(payoff.estadoPago, "PAGADO");
  assert.equal(payoff.eligible, false);
  assert.match(payoff.reason, /pagado/i);
  assert.equal(payoff.totalAbonado, 3797264);
  assert.equal(payoff.capitalPendiente, 0);
  assert.equal(payoff.saldoObligacion, 0);
  assert.equal(payoff.interesFianzaCondonado, 0);
  assert.equal(payoff.montoCreditoLiquidado, 3797264);
  assert.deepEqual(input.planCapitalVigente, before);
});

for (const [title, mutate] of [
  ["unknown version", (input) => { input.planCapitalVigente.version = "UNKNOWN"; }],
  ["broken component total", (input) => { input.planCapitalVigente.cuotas[3].capital++; }],
  ["incorrect reconciled principal", (input) => { input.planCapitalVigente.saldoCapitalAlCorte++; }],
  ["missing contractual row", (input) => { input.planCapitalVigente.cuotas.pop(); }],
  ["altered cut receipt", (input) => { input.planCapitalVigente.abonosAlCorte[0].valor++; }],
  ["receipts below the audited cutoff", (input) => { input.abonos.pop(); }],
  ["cash exceeding the current obligation", (input) => { input.abonos.push({ valor: 5052000 }); }],
]) {
  test(`an invalid revised plan fails closed without a legacy quote: ${title}`, () => {
    const input = makeRevisedCredit();
    mutate(input);
    assert.throws(() => calculateCreditEarlyPayoff(input));
    assert.throws(() => calculateCreditEarlyPayoff({ ...input, settled: true }));
  });
}

test("credits without a revised plan retain their existing proportional quote", () => {
  const payoff = calculateCreditEarlyPayoff({
    saldoBaseFinanciado: 1000000,
    valorInteres: 349456,
    valorFianza: 600000,
    montoCredito: 1949456,
    valorCuota: 121841,
    plazoMeses: 16,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-08-15",
    today: "2026-08-01",
    abonos: [{ valor: 300000 }],
  });
  assert.equal(payoff.eligible, true);
  assert.equal(payoff.totalAbonado, 300000);
  assert.equal(payoff.capitalPendiente, 846110.92);
  assert.equal(payoff.montoCreditoLiquidado, 1146110.92);
  assert.equal(payoff.interesFianzaCondonado, 803345.08);
  assert.equal(payoff.valorInteresReconocido, 53777.47);
  assert.equal(payoff.valorFianzaReconocida, 92333.45);
});
function makeCentavoCredit() {
  const original = {
    montoCredito: 1000,
    valorCuota: 100,
    plazoMeses: 10,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
    today: "2026-09-17",
  };
  const quote = createPrincipalPaymentQuote({
    plan: buildCreditPaymentPlan({ ...original, abonos: [] }),
    valor: 999.45,
    capitalOriginal: 1000,
    cuotaHabitual: 100,
    abonos: [],
    conciliacion: {
      capitalPendiente: 1000,
      tasaPeriodo: 0,
      cuotaCredito: 100,
      fianzaCuota: 0,
      seguroCuota: 0,
      numeroProximaCuota: 1,
      fuente: "Conciliacion sin interes y con centavos de prueba",
    },
  });
  const snapshot = structuredClone(quote.planCapitalVigente);
  snapshot.abonosAlCorte.push({ id: 1, valor: 999.45 });
  parseCapitalPlanSnapshot(snapshot);
  return {
    ...original,
    montoCredito: quote.montoCreditoActualizado,
    saldoBaseFinanciado: 1000,
    planCapitalVigente: snapshot,
    abonos: [{ id: 1, valor: 999.45 }],
  };
}

for (const [extra, pending, paid] of [[0, 0.55, 999.45], [0.10, 0.45, 999.55]]) {
  test(`a valid revised balance of ${pending} preserves every cent, without the legacy sub-peso clamp`, () => {
    const input = makeCentavoCredit();
    if (extra) input.abonos.push({ id: 2, valor: extra });
    const payoff = calculateCreditEarlyPayoff(input);
    assert.equal(payoff.estadoPago, "AL_DIA");
    assert.equal(payoff.eligible, true);
    assert.equal(payoff.reason, null);
    assert.equal(payoff.saldoObligacion, pending);
    assert.equal(payoff.capitalPendiente, pending);
    assert.equal(payoff.totalAbonado, paid);
    assert.equal(payoff.capitalAbonado, paid);
    assert.equal(payoff.interesFianzaCondonado, 0);
    assert.equal(payoff.montoCreditoLiquidado, 1000);
  });
}

test("a revised intent records and matches its exact revision and collected cash, without mutating either value", () => {
  const payoff = calculateCreditEarlyPayoff(makeRevisedCredit());
  const meta = buildEarlyPayoffIntentMeta(payoff);
  const beforePayoff = structuredClone(payoff);
  const beforeMeta = structuredClone(meta);
  assert.equal(payoff.planRevision, 1);
  assert.equal(meta.planRevision, 1);
  assert.equal(meta.totalAbonado, 1150000);
  assert.equal(isCurrentRevisedEarlyPayoffIntent(meta, payoff), true);
  assert.deepEqual(payoff, beforePayoff);
  assert.deepEqual(meta, beforeMeta);
});

test("a later interest-only receipt invalidates an old intent even though its principal remains identical", () => {
  const input = makeRevisedCredit();
  const quoted = calculateCreditEarlyPayoff(input);
  const meta = buildEarlyPayoffIntentMeta(quoted);
  input.abonos.push({ id: 4, valor: 5000 });
  const current = calculateCreditEarlyPayoff(input);
  assert.equal(quoted.capitalPendiente, current.capitalPendiente);
  assert.equal(current.planRevision, quoted.planRevision);
  assert.equal(current.totalAbonado, 1155000);
  assert.equal(isCurrentRevisedEarlyPayoffIntent(meta, current), false);
  assert.equal(isCurrentRevisedEarlyPayoffIntent(buildEarlyPayoffIntentMeta(current), current), true);
});

test("a revision change invalidates an old intent even when all monetary values are unchanged", () => {
  const input = makeRevisedCredit();
  const before = calculateCreditEarlyPayoff(input);
  const meta = buildEarlyPayoffIntentMeta(before);
  input.planCapitalVigente.revision++;
  parseCapitalPlanSnapshot(input.planCapitalVigente);
  const after = calculateCreditEarlyPayoff(input);
  assert.equal(after.capitalPendiente, before.capitalPendiente);
  assert.equal(after.saldoObligacion, before.saldoObligacion);
  assert.equal(after.totalAbonado, before.totalAbonado);
  assert.equal(after.planRevision, 2);
  assert.equal(isCurrentRevisedEarlyPayoffIntent(meta, after), false);
});

for (const field of ["capitalPendiente", "condonacion", "montoCreditoLiquidado", "saldoObligacion", "totalAbonado"]) {
  test(`revised intent validation rejects a one-cent mismatch in ${field}`, () => {
    const payoff = calculateCreditEarlyPayoff(makeRevisedCredit());
    const meta = buildEarlyPayoffIntentMeta(payoff);
    meta[field] = Math.round((meta[field] + 0.01) * 100) / 100;
    assert.equal(isCurrentRevisedEarlyPayoffIntent(meta, payoff), false);
  });
}

for (const field of ["planRevision", "totalAbonado"]) {
  test(`legacy metadata missing ${field} cannot authorize a revised payoff`, () => {
    const payoff = calculateCreditEarlyPayoff(makeRevisedCredit());
    const meta = buildEarlyPayoffIntentMeta(payoff);
    delete meta[field];
    assert.equal(isCurrentRevisedEarlyPayoffIntent(meta, payoff), false);
  });
}

test("missing zero-valued metadata is not treated as evidence that a revised charge was reconciled", () => {
  const payoff = calculateCreditEarlyPayoff(makeCentavoCredit());
  const meta = buildEarlyPayoffIntentMeta(payoff);
  assert.equal(meta.condonacion, 0);
  delete meta.condonacion;
  assert.equal(isCurrentRevisedEarlyPayoffIntent(meta, payoff), false);
});

test("unrevised legacy intents remain compatible without revision metadata", () => {
  const payoff = calculateCreditEarlyPayoff({
    montoCredito: 1200,
    saldoBaseFinanciado: 1000,
    valorCuota: 100,
    plazoMeses: 12,
    fechaPrimerPago: "2026-10-02",
    today: "2026-09-26",
    abonos: [],
  });
  const meta = buildEarlyPayoffIntentMeta(payoff);
  assert.equal(Object.hasOwn(meta, "planRevision"), false);
  assert.equal(Object.hasOwn(meta, "totalAbonado"), false);
  assert.equal(isCurrentRevisedEarlyPayoffIntent(meta, payoff), true);
});