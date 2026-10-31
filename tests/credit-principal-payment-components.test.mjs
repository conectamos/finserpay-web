import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import path from "node:path";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { createPrincipalPaymentQuote, parseCapitalPlanSnapshot, resolveCapitalPlanRows,
  getCapitalOutstandingBalance } = await jiti.import("../lib/credit-principal-payment.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { parseAuditedReceiptAllocation } = await jiti.import("../lib/credit-audit-receipt.ts");

// Entirely synthetic amounts, identifiers and dates.
function documentedSnapshot() {
  return {
    version: "CAPITAL_REDUCCION_PLAZO_V1", revision: 1, numeroCuotasOriginal: 3,
    totalAbonadoAlCorte: 250, abonosAlCorte: [{ id: 10, valor: 80 }, { id: 11, valor: 170 }],
    saldoCapitalAlCorte: 250,
    parametros: { capitalPendiente: 250, tasaPeriodo: 0, cuotaCredito: 100,
      fianzaCuota: 20, seguroCuota: 3, numeroProximaCuota: 1, fuente: "Conciliacion sintetica con desglose historico" },
    cuotas: [
      { numero: 1, fechaVencimiento: "2030-01-10", valorProgramado: 115, valorAbonadoAlCorte: 80,
        eliminada: false, capital: 80, interes: 12, fianza: 20, seguro: 3, saldoCapital: 220,
        componentesAbonadosAlCorte: { capital: 50, interes: 12, fianza: 15, seguro: 3 } },
      { numero: 2, fechaVencimiento: "2030-01-25", valorProgramado: 133, valorAbonadoAlCorte: 0,
        eliminada: false, capital: 100, interes: 10, fianza: 20, seguro: 3, saldoCapital: 120 },
      { numero: 3, fechaVencimiento: "2030-02-10", valorProgramado: 151, valorAbonadoAlCorte: 0,
        eliminada: false, capital: 120, interes: 8, fianza: 20, seguro: 3, saldoCapital: 0 },
    ],
  };
}
const terms = { montoCredito: 569, valorCuota: 123, plazoMeses: 3, frecuenciaPago: "QUINCENAL",
  fechaPrimerPago: "2030-01-10", today: "2030-01-01" };

test("documented cut keeps principal paid while a fixed charge is still pending", () => {
  const original = documentedSnapshot();
  const snapshot = parseCapitalPlanSnapshot(original);
  assert.deepEqual(snapshot, original);
  const row = resolveCapitalPlanRows(snapshot, 250)[0];
  assert.deepEqual(row.componentsPaid, { capital: 50, interes: 12, fianza: 15, seguro: 3 });
  assert.equal(row.capitalPendiente, 30);
  assert.equal(row.saldoPendiente, 35);
  assert.deepEqual(getCapitalOutstandingBalance(snapshot, 250), {
    saldoCapital: 250, saldoFianza: 45, saldoIntereses: 18, saldoSeguro: 6,
  });
  const plan = buildCreditPaymentPlan({ ...terms, planCapitalVigente: snapshot, abonos: snapshot.abonosAlCorte });
  assert.equal(plan.saldoCapitalPendiente, 250);
  assert.equal(plan.saldoPendiente, 319);
  assert.equal(plan.nextInstallment.numero, 1);
  assert.equal(plan.nextInstallment.saldoPendiente, 35);
});

test("later cash pays only the remaining charges and then remaining principal", () => {
  const snapshot = parseCapitalPlanSnapshot(documentedSnapshot());
  const original = structuredClone(snapshot);
  assert.deepEqual(resolveCapitalPlanRows(snapshot, 254)[0].componentsPaid,
    { capital: 50, interes: 12, fianza: 19, seguro: 3 });
  assert.deepEqual(resolveCapitalPlanRows(snapshot, 265)[0].componentsPaid,
    { capital: 60, interes: 12, fianza: 20, seguro: 3 });
  assert.equal(getCapitalOutstandingBalance(snapshot, 265).saldoCapital, 240);
  assert.deepEqual(resolveCapitalPlanRows(snapshot, 285)[0].componentsPaid,
    { capital: 80, interes: 12, fianza: 20, seguro: 3 });
  assert.equal(getCapitalOutstandingBalance(snapshot, 285).saldoCapital, 220);
  assert.deepEqual(snapshot, original);
});

test("legacy snapshots keep their existing allocation order", () => {
  const legacy = documentedSnapshot();
  delete legacy.cuotas[0].componentesAbonadosAlCorte;
  legacy.saldoCapitalAlCorte = 255;
  legacy.parametros.capitalPendiente = 255;
  const parsed = parseCapitalPlanSnapshot(legacy);
  assert.equal(Object.hasOwn(parsed.cuotas[0], "componentesAbonadosAlCorte"), false);
  assert.deepEqual(resolveCapitalPlanRows(parsed, 250)[0].componentsPaid,
    { capital: 45, interes: 12, fianza: 20, seguro: 3 });
});

test("rejects incomplete, excessive and inconsistent documented components", () => {
  for (const change of [
    (row) => { row.componentesAbonadosAlCorte = null; },
    (row) => { delete row.componentesAbonadosAlCorte.seguro; },
    (row) => { row.componentesAbonadosAlCorte.other = 0; },
    (row) => { row.componentesAbonadosAlCorte.capital = -1; },
    (row) => { row.componentesAbonadosAlCorte.capital = NaN; },
    (row) => { row.componentesAbonadosAlCorte.capital = 50.001; },
    (row) => { row.componentesAbonadosAlCorte.fianza = 21; row.componentesAbonadosAlCorte.capital = 44; },
    (row) => { row.componentesAbonadosAlCorte.capital = 49; },
    (row) => { row.valorAbonadoAlCorte = row.valorProgramado; delete row.capital; },
  ]) {
    const broken = documentedSnapshot();
    change(broken.cuotas[0]);
    assert.throws(() => parseCapitalPlanSnapshot(broken));
  }
});

test("a later principal revision preserves the settled documented components", () => {
  const snapshot = parseCapitalPlanSnapshot(documentedSnapshot());
  const original = structuredClone(snapshot);
  const abonos = [...snapshot.abonosAlCorte, { id: 12, valor: 35 }];
  const plan = buildCreditPaymentPlan({ ...terms, planCapitalVigente: snapshot, abonos });
  const quote = createPrincipalPaymentQuote({ plan, planCapitalVigente: snapshot, abonos,
    valor: 50, capitalOriginal: 470, cuotaHabitual: 123 });
  assert.equal(quote.saldoCapitalAntes, 220);
  assert.equal(quote.saldoCapitalDespues, 170);
  assert.deepEqual(quote.planCapitalVigente.cuotas[0].componentesAbonadosAlCorte,
    { capital: 80, interes: 12, fianza: 20, seguro: 3 });
  assert.equal(quote.planCapitalVigente.cuotas[0].valorAbonadoAlCorte, 115);
  quote.planCapitalVigente.abonosAlCorte.push({ id: 13, valor: 50 });
  assert.equal(parseCapitalPlanSnapshot(quote.planCapitalVigente).saldoCapitalAlCorte, 170);
  assert.deepEqual(snapshot, original);
});

test("a new principal quote cannot turn documented partial principal into interest", () => {
  const snapshot = documentedSnapshot();
  snapshot.parametros.tasaPeriodo = 0.4;
  snapshot.parametros.cuotaCredito = 200;
  const plan = buildCreditPaymentPlan({ ...terms, planCapitalVigente: snapshot, abonos: snapshot.abonosAlCorte });
  // The revised interest alone exceeds the partial payment, but its source includes principal.
  assert.throws(() => createPrincipalPaymentQuote({ plan, planCapitalVigente: snapshot,
    abonos: snapshot.abonosAlCorte, valor: 20, capitalOriginal: 470, cuotaHabitual: 223 }), /cuota parcial/);
});

test("audited receipts retain their original components and existing payment ids", () => {
  const snapshot = documentedSnapshot();
  const audit = { abonoId: 11, sourceReceipt: "SYN-EXTRA", snapshotAfter: snapshot,
    allocations: { receipts: [
      { document: "SYN-ORDINARY", date: "2030-01-02", received: 80, ordinaryInstallment: 80,
        extraordinaryPrincipal: 0, additionalInterest: 0, lateFee: 0, sourceType: "CUOTA",
        sourceComponents: { capital: 50, interes: 12, mora: 0, otros: 15, seguro: 3 } },
      { document: "SYN-EXTRA", date: "2030-01-02", received: 170, ordinaryInstallment: 0,
        extraordinaryPrincipal: 170, additionalInterest: 0, lateFee: 0, sourceType: "CAPITAL",
        sourceComponents: { capital: 170, interes: 0, mora: 0, otros: 0, seguro: 0 } },
    ] } };
  const live = snapshot.abonosAlCorte.map((payment) => ({ ...payment, fechaAbono: new Date("2030-01-02T12:00:00Z") }));
  const receipt = parseAuditedReceiptAllocation(audit, 10, live);
  assert.deepEqual(receipt.sourceComponents, { capital: 50, interes: 12, mora: 0, otros: 15, seguro: 3 });
  assert.deepEqual(receipt.snapshotAfter.abonosAlCorte, snapshot.abonosAlCorte);
  assert.deepEqual(receipt.snapshotAfter.cuotas[0].componentesAbonadosAlCorte,
    snapshot.cuotas[0].componentesAbonadosAlCorte);
});

test("the optional rate reconciliation marker is strictly boolean and preserved", () => {
  const plain = parseCapitalPlanSnapshot(documentedSnapshot());
  assert.equal(Object.hasOwn(plain, "requiereConciliacionTasaPeriodo"), false);
  for (const marker of [true, false]) {
    const snapshot = documentedSnapshot();
    snapshot.requiereConciliacionTasaPeriodo = marker;
    assert.equal(parseCapitalPlanSnapshot(snapshot).requiereConciliacionTasaPeriodo, marker);
  }
  for (const marker of [null, 0, 1, "true", "false", {}, []]) {
    const snapshot = documentedSnapshot();
    snapshot.requiereConciliacionTasaPeriodo = marker;
    assert.throws(() => parseCapitalPlanSnapshot(snapshot), /tasa.*booleano/);
  }
});

test("an unverified rate blocks reamortization but not ordinary payments on the documented plan", () => {
  const snapshot = documentedSnapshot();
  snapshot.requiereConciliacionTasaPeriodo = true;
  const abonos = [...snapshot.abonosAlCorte, { id: 12, valor: 35 }];
  const plan = buildCreditPaymentPlan({ ...terms, planCapitalVigente: snapshot, abonos });
  assert.equal(plan.saldoCapitalPendiente, 220);
  assert.equal(plan.saldoPendiente, 284);
  assert.equal(plan.nextInstallment.numero, 2);
  assert.equal(getCapitalOutstandingBalance(snapshot, 285).saldoCapital, 220);
  assert.throws(() => createPrincipalPaymentQuote({ plan, planCapitalVigente: snapshot, abonos,
    valor: 50, capitalOriginal: 470, cuotaHabitual: 123 }), /Verifica la tasa periodica.*conciliacion.*nuevo abono a capital/);
});

test("a verified rate marker survives a later principal revision", () => {
  const snapshot = documentedSnapshot();
  snapshot.requiereConciliacionTasaPeriodo = false;
  const abonos = [...snapshot.abonosAlCorte, { id: 12, valor: 35 }];
  const plan = buildCreditPaymentPlan({ ...terms, planCapitalVigente: snapshot, abonos });
  const quote = createPrincipalPaymentQuote({ plan, planCapitalVigente: snapshot, abonos,
    valor: 50, capitalOriginal: 470, cuotaHabitual: 123 });
  assert.equal(quote.planCapitalVigente.requiereConciliacionTasaPeriodo, false);
  quote.planCapitalVigente.abonosAlCorte.push({ id: 13, valor: 50 });
  assert.equal(parseCapitalPlanSnapshot(quote.planCapitalVigente).requiereConciliacionTasaPeriodo, false);
});

test("a documentary cut includes older receipts without applying them to the adopted schedule again", () => {
  const snapshot = documentedSnapshot();
  snapshot.abonosAlCorte = [{ id: 8, valor: 50 }, { id: 9, valor: 75 }, { id: 10, valor: 80 }, { id: 11, valor: 80 }];
  snapshot.totalAbonadoAlCorte = 285;
  const receipts = [
    { document: "SYN-INTERNAL-8", date: "2029-12-01", received: 50, ordinaryInstallment: 50,
      extraordinaryPrincipal: 0, additionalInterest: 0, lateFee: 0 },
    { document: "SYN-INTERNAL-9", date: "2029-12-15", received: 75, ordinaryInstallment: 75,
      extraordinaryPrincipal: 0, additionalInterest: 0, lateFee: 0 },
    { document: "SYN-NEW-ORDINARY", date: "2030-01-02", received: 80, ordinaryInstallment: 80,
      extraordinaryPrincipal: 0, additionalInterest: 0, lateFee: 0, sourceType: "CUOTA",
      sourceComponents: { capital: 50, interes: 12, mora: 0, otros: 15, seguro: 3 } },
    { document: "SYN-NEW-PRINCIPAL", date: "2030-01-02", received: 80, ordinaryInstallment: 0,
      extraordinaryPrincipal: 80, additionalInterest: 0, lateFee: 0, sourceType: "CAPITAL",
      sourceComponents: { capital: 80, interes: 0, mora: 0, otros: 0, seguro: 0 } },
  ];
  const audit = { abonoId: 11, sourceReceipt: "SYN-NEW-PRINCIPAL", snapshotAfter: snapshot, allocations: { receipts } };
  const live = snapshot.abonosAlCorte.map((payment, index) => ({ ...payment,
    fechaAbono: new Date(`${receipts[index].date}T12:00:00Z`) }));
  for (const [index, payment] of live.entries()) {
    const receipt = parseAuditedReceiptAllocation(audit, payment.id, live);
    assert.equal(receipt.document, receipts[index].document);
    assert.equal(receipt.isCutReceipt, index === 3);
    if (index < 2) assert.equal(receipt.sourceComponents, undefined);
  }
  const plan = buildCreditPaymentPlan({ ...terms, montoCredito: 604,
    planCapitalVigente: snapshot, abonos: live });
  assert.equal(plan.totalPaid, 285);
  assert.equal(plan.saldoPendiente, 319);
  assert.equal(plan.saldoCapitalPendiente, 250);
  const later = buildCreditPaymentPlan({ ...terms, montoCredito: 604,
    planCapitalVigente: snapshot, abonos: [...live, { id: 12, valor: 35 }] });
  assert.equal(later.nextInstallment.numero, 2);
  assert.equal(later.saldoPendiente, 284);
  assert.equal(later.saldoCapitalPendiente, 220);
});
