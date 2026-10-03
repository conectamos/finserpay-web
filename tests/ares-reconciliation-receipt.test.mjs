import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  ARES_20261003_RECEIPTS,
  buildAres20261003Snapshot,
} from "../scripts/lib/ares-20261003-reconciliation.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { aresReceiptPlanView, parseAresReconciledReceipt, readAresReconciledReceipt } =
  await jiti.import("../lib/ares-reconciliation-receipt.ts");

const audit = {
  abonoId: 202,
  snapshotAfter: buildAres20261003Snapshot([
    { id: 101, valor: 160000 }, { id: 202, valor: 400000 },
  ]),
  allocations: { receipts: ARES_20261003_RECEIPTS },
};

test("only the two payments in the immutable ARES cut receive a source allocation", () => {
  const first = parseAresReconciledReceipt(audit, 202, 400000);
  assert.deepEqual({ document: first.document, ordinaryInstallment: first.ordinaryInstallment,
    extraordinaryPrincipal: first.extraordinaryPrincipal, additionalInterest: first.additionalInterest,
    lateFee: first.lateFee }, {
    document: "R0100001108", ordinaryInstallment: 158500,
    extraordinaryPrincipal: 241449, additionalInterest: 0, lateFee: 51,
  });
  const second = parseAresReconciledReceipt(audit, 101, 160000);
  assert.deepEqual({ document: second.document, ordinaryInstallment: second.ordinaryInstallment,
    extraordinaryPrincipal: second.extraordinaryPrincipal, additionalInterest: second.additionalInterest,
    lateFee: second.lateFee }, {
    document: "R0100001393", ordinaryInstallment: 158500,
    extraordinaryPrincipal: 0, additionalInterest: 1442, lateFee: 58,
  });
  assert.equal(parseAresReconciledReceipt(audit, 303, 158500), null);
  const firstPlan = aresReceiptPlanView(first);
  assert.equal(firstPlan.snapshot, null,
    "El recibo de septiembre no puede recalcularse con un snapshot posterior al pago de octubre");
  assert.match(firstPlan.notice, /Recaudo histórico ARES conciliado/);
  const secondPlan = aresReceiptPlanView(second);
  assert.equal(secondPlan.snapshot.totalAbonadoAlCorte, 560000);
  assert.equal(secondPlan.notice, null);
});

test("missing audit table or audit row leaves unrelated receipts unchanged", async () => {
  const absentTable = { $queryRawUnsafe: async () => [{ name: null }] };
  assert.equal(await readAresReconciledReceipt(absentTable, 386, 202, 400000), null);
  const absentAudit = { $queryRawUnsafe: async (sql) => sql.includes("to_regclass")
    ? [{ name: '"CreditAresReconciliation"' }] : [] };
  assert.equal(await readAresReconciledReceipt(absentAudit, 999, 202, 400000), null);
});

test("audit lookup is scoped to exact credit and documented source receipt", async () => {
  let lookedUp = false;
  const db = { $queryRawUnsafe: async (sql, ...values) => {
    if (sql.includes("to_regclass")) return [{ name: '"CreditAresReconciliation"' }];
    assert.match(sql, /WHERE "creditoId"=\$1 AND "sourceReceipt"=\$2/);
    assert.deepEqual(values, [386, "R0100001108"]);
    lookedUp = true;
    return [audit];
  } };
  const result = await readAresReconciledReceipt(db, 386, 202, 400000);
  assert.equal(lookedUp, true);
  assert.equal(result.extraordinaryPrincipal, 241449);
});

test("tampered payment amount or ARES allocation fails closed", () => {
  assert.throws(() => parseAresReconciledReceipt(audit, 202, 399999), /distribución auditada/);
  const tampered = structuredClone(audit);
  tampered.allocations.receipts[0].extraordinaryPrincipal = 241448;
  assert.throws(() => parseAresReconciledReceipt(tampered, 202, 400000), /distribución auditada/);
});
