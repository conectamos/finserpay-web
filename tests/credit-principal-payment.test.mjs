import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import path from "node:path";
const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { createPrincipalPaymentQuote, parseCapitalPlanSnapshot, getCapitalOutstandingBalance } = await jiti.import("../lib/credit-principal-payment.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { calculateCreditEarlyPayoff } = await jiti.import("../lib/credit-early-payoff.ts");

// Anonymized financial reference. No client/document/receipt identifier or real payment.
const terms = { montoCredito: 149700 * 48, valorCuota: 149700, plazoMeses: 48,
  frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26" };
const payments = [{ id: 1, valor: 150000 }, { id: 2, valor: 300000 }];
const reconciliation = { capitalPendiente: 3347264, tasaPeriodo: 0.010881, cuotaCredito: 94470,
  fianzaCuota: 54180, seguroCuota: 1050, numeroProximaCuota: 4, fuente: "Plan de origen verificado al corte de la prueba" };
function quote(overrides = {}) {
  return createPrincipalPaymentQuote({ plan: buildCreditPaymentPlan({ ...terms, abonos: payments }),
    valor: 700000, capitalOriginal: 3500000, cuotaHabitual: 149700,
    abonos: structuredClone(payments), conciliacion: structuredClone(reconciliation), ...overrides });
}
function applied(result = quote(), id = 3) {
  const snapshot = structuredClone(result.planCapitalVigente);
  snapshot.abonosAlCorte.push({ id, valor: result.abonoCapital });
  return parseCapitalPlanSnapshot(snapshot);
}

const observed = [
  [4,65665,28805,2581599], [5,66380,28090,2515219], [6,67102,27368,2448117],
  [7,67832,26638,2380285], [8,68570,25900,2311715], [9,69316,25154,2242399],
  [10,70070,24400,2172329], [11,70833,23637,2101496], [12,71604,22866,2029892],
  [13,72383,22087,1957509], [14,73170,21300,1884339], [15,73967,20503,1810372],
  [16,74771,19699,1735601], [17,75585,18885,1660016], [18,76407,18063,1583609],
  [19,77239,17231,1506370], [20,78079,16391,1428291], [21,78929,15541,1349362],
  [22,79788,14682,1269574], [23,80656,13814,1188918], [24,81533,12937,1107385],
  [25,82421,12049,1024964], [26,83317,11153,941647], [27,84224,10246,857423],
  [28,85140,9330,772283], [29,86067,8403,686216], [30,87003,7467,599213],
  [31,87950,6520,511263], [32,88907,5563,422356], [33,89874,4596,332482],
  [34,90852,3618,241630], [35,91841,2629,149789], [36,92840,1630,56949],
  [37,56949,620,0],
];

test("700000 is entirely principal; ordinary installments must already be recorded", () => {
  const result = quote();
  assert.equal(result.saldoCapitalAntes, 3347264);
  assert.equal(result.abonoCapital, 700000);
  assert.equal(result.saldoCapitalDespues, 2647264);
  assert.equal(result.cuotasPendientesAntes, 45);
  assert.equal(result.cuotasPendientesDespues, 34);
  assert.equal(result.cuotasEliminadas, 11);
  assert.deepEqual(result.ultimaCuota, { numero: 37, fechaVencimiento: "2028-03-17", valor: 112799 });
  const initial = buildCreditPaymentPlan({ ...terms, abonos: [payments[0]] });
  assert.throws(() => quote({ plan: initial, abonos: [payments[0]] }), /proxima cuota/i);
});

for (const [numero, capital, interes, saldoCapital] of observed) {
  test(`matches all documented components after the prepayment: installment ${numero}`, () => {
    const row = quote().planCapitalVigente.cuotas[numero - 1];
    assert.equal(row.capital, capital);
    assert.equal(row.interes, interes);
    assert.equal(row.saldoCapital, saldoCapital);
    assert.equal(row.fianza, 54180);
    assert.equal(row.seguro, 1050);
    assert.equal(row.valorProgramado, numero === 37 ? 112799 : 149700);
    assert.equal(row.eliminada, false);
  });
}
test("rounds interest inside every period, not only at presentation", () => {
  const final = quote().planCapitalVigente.cuotas[36];
  assert.equal(final.capital, 56949);
  assert.equal(final.interes, 620);
  assert.equal(final.valorProgramado, 112799);
  assert.notEqual(final.valorProgramado, 112798);
});
test("keeps 900 prior interest separate from the extraordinary receipt", () => {
  const result = quote();
  assert.equal(result.planCapitalVigente.cuotas[3].valorAbonadoAlCorte, 900);
  assert.equal(result.saldoPendienteDespues, 5051999);
  assert.equal(result.montoCreditoActualizado, 1150000 + 5051999);
  const plan = buildCreditPaymentPlan({ ...terms, montoCredito: result.montoCreditoActualizado,
    planCapitalVigente: applied(result), abonos: [...payments, { valor: 700000 }] });
  assert.equal(plan.nextInstallment.numero, 4);
  assert.equal(plan.nextInstallment.saldoPendiente, 148800);
  assert.equal(plan.saldoCapitalPendiente, 2647264);
  assert.equal(plan.totalPaid, 1150000);
  assert.equal(plan.paidCount, 3);
  assert.equal(plan.pendingCount, 34);
  assert.equal(plan.overdueCount, 0);
});
test("preserves paid history and zeroes eliminated installments without future charges", () => {
  const inputPlan = buildCreditPaymentPlan({ ...terms, abonos: payments });
  const snapshot = applied();
  for (let i = 0; i < 3; i++) {
    assert.equal(snapshot.cuotas[i].valorProgramado, inputPlan.installments[i].valorProgramado);
    assert.equal(snapshot.cuotas[i].valorAbonadoAlCorte, inputPlan.installments[i].valorAbonado);
    assert.equal(snapshot.cuotas[i].fechaVencimiento, inputPlan.installments[i].fechaVencimiento);
  }
  for (const row of snapshot.cuotas.slice(37)) {
    for (const key of ["capital","interes","fianza","seguro","saldoCapital","valorProgramado","valorAbonadoAlCorte"]) assert.equal(row[key], 0);
    assert.equal(row.eliminada, true);
  }
});
test("ordinary payments after the cut settle actual installments, never count the extra twice", () => {
  const snapshot = applied();
  const plan = buildCreditPaymentPlan({ ...terms, planCapitalVigente: snapshot,
    abonos: [...payments, {valor:700000}, {valor:148800}] });
  assert.equal(plan.nextInstallment.numero, 5);
  assert.equal(plan.nextInstallment.saldoPendiente, 149700);
  assert.equal(plan.saldoCapitalPendiente, 2581599);
  const remaining = getCapitalOutstandingBalance(snapshot, 1150000 + 148800);
  assert.equal(remaining.saldoCapital, 2581599);
  assert.equal(Object.values(remaining).reduce((sum,x)=>sum+x,0), plan.saldoPendiente);
});
test("a second extraordinary payment uses the revised principal and preserves the original version", () => {
  const first = quote();
  const snapshot = applied(first);
  const originalSnapshot = structuredClone(snapshot);
  const abonos = [...payments, {id:3,valor:700000}, {id:4,valor:148800}];
  const plan = buildCreditPaymentPlan({ ...terms, planCapitalVigente:snapshot, abonos });
  const second = quote({ plan, planCapitalVigente:snapshot, abonos, valor:200000, conciliacion:undefined });
  assert.equal(second.saldoCapitalAntes,2581599);
  assert.equal(second.saldoCapitalDespues,2381599);
  assert.equal(second.planCapitalVigente.revision,2);
  assert.deepEqual(snapshot,originalSnapshot);
  assert.ok(second.cuotasPendientesDespues < plan.pendingCount);
  assert.equal(applied(second,5).saldoCapitalAlCorte,2381599);
});
test("uses audited principal for total payoff after a principal revision", () => {
  const result = quote();
  const payoff = calculateCreditEarlyPayoff({ ...terms, montoCredito:result.montoCreditoActualizado,
    saldoBaseFinanciado:3500000, planCapitalVigente:applied(result), abonos:[...payments,{valor:700000}] });
  assert.equal(payoff.eligible,true);
  assert.equal(payoff.capitalPendiente,2647264);
  assert.equal(payoff.reason,null);
  assert.equal(payoff.interesFianzaCondonado,2404735);
  assert.equal(payoff.montoCreditoLiquidado,3797264);
});
test("a changed or incomplete cutoff never falls back to the legacy calendar", () => {
  const snapshot = applied();
  assert.throws(()=>buildCreditPaymentPlan({...terms,planCapitalVigente:snapshot,abonos:payments}),/recaudos/i);
  for (const update of [
    s=>{s.version="UNKNOWN";}, s=>{s.cuotas[3].capital++;},
    s=>{s.saldoCapitalAlCorte++;}, s=>{s.cuotas.pop();},
    s=>{s.abonosAlCorte[0].valor++;}, s=>{s.cuotas[4].fechaVencimiento="2026-11-02";},
  ]) { const broken=structuredClone(snapshot); update(broken); assert.throws(()=>parseCapitalPlanSnapshot(broken)); }
});
test("requires explicit coherent documentary terms, never takes current global rates", () => {
  for (const invalid of [undefined,null,{}, {...reconciliation,fuente:""}, {...reconciliation,cuotaCredito:94000},
    {...reconciliation,capitalPendiente:3500001}, {...reconciliation,tasaPeriodo:29.24},
    {...reconciliation,tasaPeriodo:"0.010881"}, {...reconciliation,numeroProximaCuota:3}]) {
    assert.throws(()=>quote({conciliacion:invalid}));
  }
});
test("rejects negative, nonfinite, excessive or payoff-sized extraordinary amounts", () => {
  for (const valor of [0,-1,NaN,Infinity,3347264,3500000,1e13,0.001]) assert.throws(()=>quote({valor}));
});
test("does not waive arrears or consume prior payments beyond new interest", () => {
  const plan=buildCreditPaymentPlan({...terms,abonos:payments,today:"2026-11-03"});
  assert.throws(()=>quote({plan}),/vencidas/i);
  assert.throws(()=>quote({valor:3347263}),/parcial/i);
});

test("a documented input cannot claim more principal than the total outstanding debt", () => {
  const abonos = [{ id: 1, valor: 400 }];
  const plan = buildCreditPaymentPlan({ montoCredito: 950, valorCuota: 100, plazoMeses: 10,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26", abonos });
  assert.equal(plan.saldoPendiente, 550);
  assert.throws(() => createPrincipalPaymentQuote({ plan, abonos, valor: 100,
    capitalOriginal: 900, cuotaHabitual: 100,
    conciliacion: { capitalPendiente: 650, tasaPeriodo: 0, cuotaCredito: 100,
      fianzaCuota: 0, seguroCuota: 0, numeroProximaCuota: 5, fuente: "Conciliacion incoherente de prueba" } }), /saldo total exigible/);
});

test("wrong reconciled charges cannot increase the obligation when principal is prepaid", () => {
  const abonos = [{ id: 1, valor: 400 }];
  const plan = buildCreditPaymentPlan({ montoCredito: 950, valorCuota: 100, plazoMeses: 10,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26", abonos });
  assert.equal(plan.saldoPendiente, 550);
  // Principal is within total debt, but incorrect fixed charges would add debt.
  assert.throws(() => createPrincipalPaymentQuote({ plan, abonos, valor: 100,
    capitalOriginal: 900, cuotaHabitual: 100,
    conciliacion: { capitalPendiente: 550, tasaPeriodo: 0, cuotaCredito: 80,
      fianzaCuota: 20, seguroCuota: 0, numeroProximaCuota: 5, fuente: "Conciliacion con cargos incorrectos de prueba" } }), /aumentaria la obligacion/);
});

test("zero-rate principal payments preserve cents without losing cash", () => {
  const plan = buildCreditPaymentPlan({ montoCredito: 1000, valorCuota: 100, plazoMeses: 10,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-17", abonos: [] });
  const result = createPrincipalPaymentQuote({ plan, abonos: [], valor: 123.45,
    capitalOriginal: 1000, cuotaHabitual: 100,
    conciliacion: { capitalPendiente: 1000, tasaPeriodo: 0, cuotaCredito: 100,
      fianzaCuota: 0, seguroCuota: 0, numeroProximaCuota: 1, fuente: "Conciliacion sin interes de prueba" } });
  assert.equal(result.saldoCapitalDespues, 876.55);
  assert.equal(result.saldoPendienteDespues, 876.55);
  assert.equal(result.montoCreditoActualizado, 1000);
  assert.equal(result.ultimaCuota.numero, 9);
  assert.equal(result.ultimaCuota.valor, 76.55);
  assert.equal(result.cuotasEliminadas, 1);
});
