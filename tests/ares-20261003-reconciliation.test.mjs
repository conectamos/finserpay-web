import assert from "node:assert/strict";
import test from "node:test";
import {
  ARES_20261003_EXPECTED,
  ARES_20261003_RECEIPTS,
  assertAres20261003Source,
  buildAres20261003Snapshot,
} from "../scripts/lib/ares-20261003-reconciliation.mjs";
import {
  getCapitalOutstandingBalance,
  parseCapitalPlanSnapshot,
  resolveCapitalPlanRows,
} from "../lib/credit-principal-payment.ts";

const activeReceipts = [{ id: 809, valor: 160_000 }, { id: 812, valor: 400_000 }];

test("the two ARES receipts reconcile with ordinary payments, principal and late charges", () => {
  assert.equal(assertAres20261003Source(), true);
  assert.deepEqual(ARES_20261003_RECEIPTS.map((receipt) => receipt.received), [400_000, 160_000]);
  assert.deepEqual(ARES_20261003_RECEIPTS.map((receipt) => receipt.extraordinaryPrincipal), [241_449, 0]);
  assert.equal(ARES_20261003_RECEIPTS[1].additionalInterest + ARES_20261003_RECEIPTS[1].lateFee, 1_500);
  assert.equal(ARES_20261003_EXPECTED.originalPrincipal - 70_283 - 241_449 - 82_153, 1_058_115);
});

test("the snapshot parses in the production capital engine and leaves cuota 3 entirely pending", () => {
  const snapshot = buildAres20261003Snapshot(activeReceipts);
  const parsed = parseCapitalPlanSnapshot(snapshot);
  assert.deepEqual(parsed, snapshot);
  assert.deepEqual(snapshot.abonosAlCorte, [{ id: 809, valor: 160_000 }, { id: 812, valor: 400_000 }]);
  assert.equal(snapshot.totalAbonadoAlCorte, 560_000);
  assert.equal(snapshot.saldoCapitalAlCorte, 1_058_115);
  assert.equal(snapshot.cuotas.length, 17);
  assert.deepEqual(snapshot.cuotas.slice(0, 3).map((row) => [row.numero, row.fechaVencimiento, row.valorAbonadoAlCorte]), [
    [1, "2026-09-17", 158_500],
    [2, "2026-10-02", 158_500],
    [3, "2026-10-17", 0],
  ]);
  assert.deepEqual(snapshot.cuotas[2], {
    numero: 3, fechaVencimiento: "2026-10-17", valorProgramado: 158_500,
    valorAbonadoAlCorte: 0, eliminada: false, capital: 83_047, interes: 11_513,
    fianza: 63_505, seguro: 435, saldoCapital: 975_068,
  });
  assert.deepEqual(snapshot.cuotas[13], {
    numero: 14, fechaVencimiento: "2027-04-02", valorProgramado: 158_200,
    valorAbonadoAlCorte: 0, eliminada: false, capital: 93_245, interes: 1_015,
    fianza: 63_505, seguro: 435, saldoCapital: 0,
  });
  assert.deepEqual(snapshot.cuotas.slice(14).map((row) => [row.numero, row.eliminada, row.valorProgramado]), [
    [15, true, 0], [16, true, 0], [17, true, 0],
  ]);
  const rows = resolveCapitalPlanRows(parsed, 560_000);
  assert.deepEqual(rows.slice(0, 3).map((row) => [row.valorAbonado, row.saldoPendiente]), [
    [158_500, 0], [158_500, 0], [0, 158_500],
  ]);
  assert.equal(rows.reduce((sum, row) => sum + row.saldoPendiente, 0), 1_901_700);
  assert.equal(getCapitalOutstandingBalance(parsed, 560_000).saldoCapital, 1_058_115);
  assert.equal(snapshot.totalAbonadoAlCorte + rows.reduce((sum, row) => sum + row.saldoPendiente, 0), 2_461_700);
});

test("payments after the documented cut start with cuota 3", () => {
  const snapshot = parseCapitalPlanSnapshot(buildAres20261003Snapshot(activeReceipts));
  const rows = resolveCapitalPlanRows(snapshot, 718_500);
  assert.deepEqual(rows.slice(1, 4).map((row) => [row.numero, row.valorAbonado, row.saldoPendiente]), [
    [2, 158_500, 0], [3, 158_500, 0], [4, 0, 158_500],
  ]);
  assert.equal(rows.reduce((sum, row) => sum + row.saldoPendiente, 0), 1_743_200);
});

test("the builder rejects duplicate, missing or unmatched active receipts", () => {
  for (const invalid of [
    [],
    [{ id: 1, valor: 160_000 }],
    [{ id: 1, valor: 400_000 }, { id: 1, valor: 160_000 }],
    [{ id: 1, valor: 400_000 }, { id: 2, valor: 158_500 }],
    [{ id: 1, valor: 400_000 }, { id: 2, valor: 160_000 }, { id: 3, valor: 400_000 }],
    [{ id: 1.5, valor: 400_000 }, { id: 2, valor: 160_000 }],
    [{ id: 1, valor: 400_000 }, { id: 2, valor: Number.NaN }],
  ]) {
    assert.throws(() => buildAres20261003Snapshot(invalid));
  }
  const copy = structuredClone(activeReceipts);
  buildAres20261003Snapshot(activeReceipts);
  assert.deepEqual(activeReceipts, copy, "Building a snapshot must not mutate the active receipts");
});
