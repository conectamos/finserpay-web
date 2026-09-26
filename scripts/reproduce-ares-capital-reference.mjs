// Offline diagnostic only: reads an anonymized fixture, never a database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  projectReferenceTermReduction,
  reconcileReferenceReceipt,
} from "./lib/ares-capital-reference.mjs";

const fixture = JSON.parse(await readFile(
  new URL("../tests/fixtures/ares-capital-reference.json", import.meta.url), "utf8"
));
const receipt = reconcileReferenceReceipt(fixture.receipt.input);
const projection = projectReferenceTermReduction(fixture.projection.input);
assert.deepEqual(receipt, fixture.receipt.expected, "The reference receipt must reconcile in every component");
assert.equal(receipt.principalAfter, fixture.projection.input.principal);
assert.equal(projection.remainingInstallments, fixture.projection.expected.remainingInstallments);
assert.equal(projection.lastInstallmentNumber, fixture.projection.expected.lastInstallmentNumber);
for (const expected of fixture.projection.observedRows) {
  const row = projection.rows.find((item) => item.number === expected.number);
  assert.ok(row, `Missing observed installment ${expected.number}`);
  for (const [field, value] of Object.entries(expected)) {
    if (field !== "number") assert.equal(row.display[field], value, `Installment ${row.number}: ${field}`);
  }
}
for (const number of fixture.projection.observedZeroRows) {
  const row = projection.rows.find((item) => item.number === number);
  assert.ok(row, `Missing observed zero installment ${number}`);
  assert.equal(row.removed, true, `Installment ${number} must have no remaining obligation`);
  for (const field of ["openingPrincipal", "principal", "interest", "surety", "insurance",
    "creditInstallment", "grossInstallment", "priorInterestPaid", "pending", "closingPrincipal"]) {
    assert.equal(row[field], 0, `Observed zero installment ${number}: ${field}`);
  }
}
const cop = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });
console.log("REPRODUCCION LOCAL ARES — NO REGISTRA PAGOS NI MODIFICA CREDITOS");
console.log(`Recibido: $${cop.format(receipt.received)}; capital reducido: $${cop.format(receipt.principalReduction)}.`);
console.log(`Saldo de capital: $${cop.format(receipt.principalAfter)}.`);
console.log(`Cuotas restantes: ${projection.remainingInstallments}; ultima cuota: ${projection.lastInstallmentNumber}.`);
console.table(projection.rows.map((row) => ({
  Cuota: row.number,
  Fecha: row.date,
  Capital: cop.format(row.display.principal),
  Interes: cop.format(row.display.interest),
  Aval: cop.format(row.display.surety),
  Seguro: cop.format(row.display.insurance),
  Total: cop.format(row.display.grossInstallment),
  "Interes pagado antes": cop.format(row.priorInterestPaid),
  Pendiente: cop.format(row.display.pending),
  Evidencia: fixture.projection.observedRows.some((item) => item.number === row.number)
    || fixture.projection.observedZeroRows.includes(row.number) ? "Visible en captura" : "Calculada",
})));
console.log("Coinciden las filas observadas. La tasa es una referencia del caso, no una nueva politica.");
for (const limitation of fixture.limitations) console.log(`- ${limitation}`);
