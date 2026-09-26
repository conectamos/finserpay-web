import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalRow,
  dateKey,
  fingerprintBatch,
  firstDueDateCatorcenal,
  normalizeDocument,
  validateCreditActivity,
  validateImportedCredit,
} from "../scripts/mass-first-payment-correction-core.mjs";

const BATCH_ID = "123e4567-e89b-42d3-a456-426614174000";

function receipt(rowNumber = 1, overrides = {}) {
  return {
    rowNumber,
    ok: true,
    errors: [],
    normalized: {
      cedula: `${900000 + rowNumber}`,
      numeroCreditoSadmin: `SADMIN-${rowNumber}`,
      fecha: "2026-08-20",
      fechaPago: "2026-09-20",
      frecuencia: "CATORCENAL",
      ...overrides,
    },
  };
}

function importedCredit(overrides = {}) {
  const importReceipt = receipt();
  const row = {
    snapshot: {
      origen: {
        tipo: "IMPORTACION_MASIVA",
        batchId: BATCH_ID,
        requestId: BATCH_ID,
        sadminConfirmation: "ADMIN_EXISTING_SADMIN",
        numeroCreditoSadmin: "SADMIN-1",
        importReceipt,
      },
      financiero: {
        frecuenciaPago: "CATORCENAL",
        fechaCredito: "2026-08-20",
        fechaPrimerPago: "2026-09-20",
      },
    },
    clientDocument: "900001",
    sadmin: {
      codeudorCreado: true,
      creditoCreado: true,
      numeroCreditoConfirmado: true,
      completedAt: "2026-09-25T17:00:00.000Z",
      numeroCredito: "SADMIN-1",
    },
    equalityService: "IMPORTACION_MASIVA",
    state: "GENERADO",
    frequency: "CATORCENAL",
    creditDate: "2026-08-20",
    firstPayment: "2026-09-20",
    nextPayment: "2026-09-20",
  };
  return { ...row, ...overrides };
}

test("civil dates advance exactly fourteen days across month and leap boundaries", () => {
  assert.equal(firstDueDateCatorcenal("2026-08-20"), "2026-09-03");
  assert.equal(firstDueDateCatorcenal("2024-02-20"), "2024-03-05");
  assert.equal(firstDueDateCatorcenal(new Date("2026-09-23T12:00:00.000Z")), "2026-10-07");
  assert.equal(dateKey("2026-09-23T12:00:00.000Z"), "2026-09-23");
  assert.throws(() => dateKey("2026-02-30"), /Invalid imported civil date/);
});

test("batch fingerprint is deterministic across receipt order and preserves leading SADMIN zeros", () => {
  const first = receipt(1, { cedula: "0900.001", numeroCreditoSadmin: " 000-Aa " });
  const second = receipt(2, { cedula: "900002", numeroCreditoSadmin: "000-Bb" });
  const expectedCanonical = "900001|000-aa|2026-08-20|2026-09-20|CATORCENAL";
  assert.equal(normalizeDocument(first.normalized.cedula), "900001");
  assert.equal(canonicalRow(first), expectedCanonical);
  assert.equal(fingerprintBatch([second, first]), fingerprintBatch([first, second]));
  assert.equal(
    fingerprintBatch([second, first]),
    createHash("sha256")
      .update(`${expectedCanonical}\n900002|000-bb|2026-08-20|2026-09-20|CATORCENAL`)
      .digest("hex"),
  );
});

test("fingerprint rejects missing, duplicate, and gapped receipt row numbers", () => {
  assert.throws(() => fingerprintBatch([]), /no receipts/);
  assert.throws(() => fingerprintBatch([receipt(2)]), /not contiguous/);
  assert.throws(() => fingerprintBatch([receipt(1), receipt(1)]), /not contiguous/);
  assert.throws(() => fingerprintBatch([receipt(1), receipt(3)]), /not contiguous/);
  assert.throws(() => canonicalRow(receipt(1, { frecuencia: "MENSUAL" })), /Invalid imported receipt identity/);
});

test("valid untouched imported credit yields policy date without changing monetary data", () => {
  assert.deepEqual(validateImportedCredit(importedCredit()), {
    previousDate: "2026-09-20",
    correctedDate: "2026-09-03",
    rowNumber: 1,
    batchId: BATCH_ID,
  });
});

test("identity or original date mismatches abort correction", () => {
  const mutationCases = [
    ["different client", { clientDocument: "900099" }],
    ["different SADMIN registration", { sadmin: { ...importedCredit().sadmin, numeroCredito: "SADMIN-99" } }],
    ["unconfirmed SADMIN registration", { sadmin: { ...importedCredit().sadmin, numeroCreditoConfirmado: false } }],
    ["manually changed first date", { firstPayment: "2026-09-21" }],
    ["manually changed next date", { nextPayment: "2026-09-21" }],
    ["changed snapshot date", { snapshot: { ...importedCredit().snapshot, financiero: { ...importedCredit().snapshot.financiero, fechaPrimerPago: "2026-09-21" } } }],
    ["non generated credit", { state: "ACTIVO" }],
    ["already corrected credit", { snapshot: { ...importedCredit().snapshot, origen: { ...importedCredit().snapshot.origen, firstPaymentCorrection: { date: "2026-09-03" } } } }],
  ];
  for (const [name, patch] of mutationCases) {
    assert.throws(() => validateImportedCredit(importedCredit(patch)), /changed/, name);
  }
});

test("credit activity validator rejects payment, approval, signature, and other downstream changes", () => {
  const baseline = { sadminVersion: 1, activity: {} };
  assert.doesNotThrow(() => validateCreditActivity(baseline));

  for (const activity of [
    "abono", "amortizacion", "wompi", "liquidacion", "approval", "reissue",
    "data_correction", "novelty", "call_recording", "evidence_revision", "firmaSeguro",
  ]) {
    assert.throws(
      () => validateCreditActivity({ ...baseline, activity: { [activity]: true } }),
      /activity|changed|modified/i,
      activity,
    );
  }
  for (const field of [
    "deliverableReady", "pazYSalvoEmitidoAt", "contratoAceptadoAt", "pagareAceptadoAt",
    "contratoFirmaDataUrl", "contratoFotoDataUrl", "contratoSelfieDataUrl", "contratoOtpVerificadoAt",
  ]) {
    assert.throws(
      () => validateCreditActivity({ ...baseline, [field]: field.endsWith("Ready") ? true : "2026-09-25" }),
      /activity|changed|modified/i,
      field,
    );
  }
  assert.throws(() => validateCreditActivity({ ...baseline, sadminVersion: 2 }), /activity|changed|modified/i);
});
