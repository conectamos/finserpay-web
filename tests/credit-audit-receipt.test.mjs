import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { auditedReceiptPlanView, parseAuditedReceiptAllocation, readAuditedReceiptAllocation } =
  await jiti.import("../lib/credit-audit-receipt.ts");

const snapshot = {
  version: "CAPITAL_REDUCCION_PLAZO_V1", revision: 1,
  totalAbonadoAlCorte: 691550,
  abonosAlCorte: [{ id: 11, valor: 181250 }, { id: 22, valor: 510300 }],
  saldoCapitalAlCorte: 750000, numeroCuotasOriginal: 3,
  parametros: { capitalPendiente: 750000, tasaPeriodo: 0.01, cuotaCredito: 120000,
    fianzaCuota: 50000, seguroCuota: 10000, numeroProximaCuota: 3,
    fuente: "Documento sintético para probar una conciliación histórica" },
  cuotas: [
    { numero: 1, fechaVencimiento: "2030-01-10", valorProgramado: 180000,
      valorAbonadoAlCorte: 180000, eliminada: false, capital: 100000, interes: 20000,
      fianza: 50000, seguro: 10000, saldoCapital: 1190200 },
    { numero: 2, fechaVencimiento: "2030-01-25", valorProgramado: 180000,
      valorAbonadoAlCorte: 180000, eliminada: false, capital: 110000, interes: 10000,
      fianza: 50000, seguro: 10000, saldoCapital: 750000 },
    { numero: 3, fechaVencimiento: "2030-02-10", valorProgramado: 815000,
      valorAbonadoAlCorte: 0, eliminada: false, capital: 750000, interes: 5000,
      fianza: 50000, seguro: 10000, saldoCapital: 0 },
  ],
};
const audit = {
  abonoId: 22, sourceReceipt: "SYN-A", snapshotAfter: snapshot,
  allocations: { receipts: [
    { document: "SYN-A", date: "2030-01-11", received: 510300,
      ordinaryInstallment: 180000, extraordinaryPrincipal: 330200,
      additionalInterest: 0, lateFee: 100 },
    { document: "SYN-B", date: "2030-01-26", received: 181250,
      ordinaryInstallment: 180000, extraordinaryPrincipal: 0,
      additionalInterest: 1200, lateFee: 50 },
  ] },
};
const payments = [
  { id: 11, valor: 181250, fechaAbono: new Date("2030-01-26T12:00:00Z") },
  { id: 22, valor: 510300, fechaAbono: new Date("2030-01-11T12:00:00Z") },
];

test("source receipt is anchored by audit abonoId and its complete allocation", () => {
  const result = parseAuditedReceiptAllocation(audit, 22, payments);
  assert.deepEqual({ document: result.document, ordinaryInstallment: result.ordinaryInstallment,
    extraordinaryPrincipal: result.extraordinaryPrincipal, additionalInterest: result.additionalInterest,
    lateFee: result.lateFee, isSourceReceipt: result.isSourceReceipt, isCutReceipt: result.isCutReceipt }, {
    document: "SYN-A", ordinaryInstallment: 180000, extraordinaryPrincipal: 330200,
    additionalInterest: 0, lateFee: 100, isSourceReceipt: true, isCutReceipt: false,
  });
  assert.equal(auditedReceiptPlanView(result).snapshot, null,
    "A receipt before the audited cut cannot use a later plan");
  assert.match(auditedReceiptPlanView(result).notice, /Recaudo histórico conciliado/);
});

test("later receipt is matched by live amount and effective date and may show the audited cut", () => {
  const result = parseAuditedReceiptAllocation(audit, 11, payments);
  assert.deepEqual({ document: result.document, ordinaryInstallment: result.ordinaryInstallment,
    extraordinaryPrincipal: result.extraordinaryPrincipal, additionalInterest: result.additionalInterest,
    lateFee: result.lateFee, isCutReceipt: result.isCutReceipt }, {
    document: "SYN-B", ordinaryInstallment: 180000, extraordinaryPrincipal: 0,
    additionalInterest: 1200, lateFee: 50, isCutReceipt: true,
  });
  assert.equal(auditedReceiptPlanView(result).snapshot.totalAbonadoAlCorte, 691550);
  assert.equal(auditedReceiptPlanView(result).notice, null);
  assert.equal(parseAuditedReceiptAllocation(audit, 99, payments), null);
});

test("missing audit table or matching row preserves ordinary receipts", async () => {
  const missingTable = { $queryRawUnsafe: async () => [{ name: null }] };
  assert.equal(await readAuditedReceiptAllocation(missingTable, 7, 22, payments), null);
  const missingRow = { $queryRawUnsafe: async (sql) => sql.includes("to_regclass")
    ? [{ name: '"CreditAresReconciliation"' }] : [] };
  assert.equal(await readAuditedReceiptAllocation(missingRow, 7, 22, payments), null);
});

test("audit lookup is scoped to credit and payment without hardcoded source values", async () => {
  let queried = false;
  const db = { $queryRawUnsafe: async (sql, ...values) => {
    if (sql.includes("to_regclass")) return [{ name: '"CreditAresReconciliation"' }];
    assert.match(sql, /"creditoId"=\$1/);
    assert.deepEqual(values, [7, 22, JSON.stringify([{ id: 22 }])]);
    queried = true;
    return [audit];
  } };
  assert.equal((await readAuditedReceiptAllocation(db, 7, 22, payments)).document, "SYN-A");
  assert.equal(queried, true);
});

test("optional source components preserve the exact category of other charges", () => {
  const documented = structuredClone(audit);
  documented.sourceReceipt = "SYN-C";
  documented.snapshotAfter.totalAbonadoAlCorte = 93250;
  documented.snapshotAfter.abonosAlCorte = [{ id: 22, valor: 93250 }];
  documented.allocations.receipts = [{
    document: "SYN-C", date: "2030-01-11", received: 93250,
    ordinaryInstallment: 0, extraordinaryPrincipal: 87000,
    additionalInterest: 0, lateFee: 0, otherCharges: 6250,
    sourceType: "CAPITAL",
    sourceComponents: { capital: 87000, interes: 0, mora: 0, otros: 6250, seguro: 0 },
  }];
  const live = [{ id: 22, valor: 93250, fechaAbono: new Date("2030-01-11T12:00:00Z") }];
  const result = parseAuditedReceiptAllocation(documented, 22, live);
  assert.equal(result.otherCharges, 6250);
  assert.equal(result.sourceType, "CAPITAL");
  assert.deepEqual(result.sourceComponents,
    { capital: 87000, interes: 0, mora: 0, otros: 6250, seguro: 0 });
  const plural = structuredClone(documented);
  plural.allocations.receipts[0].sourceType = "CUOTAS";
  assert.equal(parseAuditedReceiptAllocation(plural, 22, live).sourceType, "CUOTAS");

  const wrongGross = structuredClone(documented);
  wrongGross.allocations.receipts[0].otherCharges -= 1;
  assert.throws(() => parseAuditedReceiptAllocation(wrongGross, 22, live), /no concilia/);
  const wrongSource = structuredClone(documented);
  wrongSource.allocations.receipts[0].sourceComponents.otros -= 1;
  assert.throws(() => parseAuditedReceiptAllocation(wrongSource, 22, live), /no concilia/);
  const missingSourceType = structuredClone(documented);
  delete missingSourceType.allocations.receipts[0].sourceType;
  assert.throws(() => parseAuditedReceiptAllocation(missingSourceType, 22, live), /no concilia/);
});

test("tampered components, dates, cash or ambiguous receipt mapping fail closed", () => {
  const nonTextSource = structuredClone(audit);
  nonTextSource.sourceReceipt = 123;
  assert.throws(() => parseAuditedReceiptAllocation(nonTextSource, 22, payments), /no concilia/);
  const nonTextDocument = structuredClone(audit);
  nonTextDocument.allocations.receipts[0].document = 123;
  assert.throws(() => parseAuditedReceiptAllocation(nonTextDocument, 22, payments), /no concilia/);
  const wrongTotal = structuredClone(audit);
  wrongTotal.allocations.receipts[0].lateFee += 1;
  assert.throws(() => parseAuditedReceiptAllocation(wrongTotal, 22, payments), /no concilia/);
  const wrongDate = structuredClone(payments);
  wrongDate[0].fechaAbono = new Date("2030-01-27T12:00:00Z");
  assert.throws(() => parseAuditedReceiptAllocation(audit, 11, wrongDate), /no concilia/);
  const wrongCash = structuredClone(payments);
  wrongCash[1].valor -= 1;
  assert.throws(() => parseAuditedReceiptAllocation(audit, 22, wrongCash), /no concilia/);
  const ambiguous = structuredClone(audit);
  ambiguous.snapshotAfter.abonosAlCorte.push({ id: 33, valor: 181250 });
  ambiguous.snapshotAfter.totalAbonadoAlCorte += 181250;
  ambiguous.allocations.receipts.push({ ...ambiguous.allocations.receipts[1], document: "SYN-C" });
  assert.throws(() => parseAuditedReceiptAllocation(ambiguous, 11, [
    ...payments, { id: 33, valor: 181250, fechaAbono: new Date("2030-01-26T12:00:00Z") },
  ]), /no concilia/);
});
