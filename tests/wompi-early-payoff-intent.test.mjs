import assert from "node:assert/strict";
import test from "node:test";

import {
  isWompiEarlyPayoffIntent,
  isWompiEarlyPayoffReference,
  validateWompiEarlyPayoffAmounts,
} from "../lib/wompi-early-payoff-intent.ts";

test("reconoce la liquidacion por los metadatos del intent", () => {
  assert.equal(
    isWompiEarlyPayoffIntent(
      { tipo: "LIQUIDACION_ANTICIPADA" },
      "FP-42-C10-20260801180000-ABCDE"
    ),
    true
  );
});

test("recupera la liquidacion por la referencia si el JSON se degrado", () => {
  const reference = "FP-42-LIQUIDACION-20260801180000-ABCDE";

  assert.equal(isWompiEarlyPayoffReference(reference), true);
  assert.equal(isWompiEarlyPayoffIntent([], reference), true);
});

test("no confunde un pago de cuotas con una liquidacion", () => {
  assert.equal(
    isWompiEarlyPayoffIntent(
      [3, 4, 5],
      "FP-42-C3-4-5-20260801180000-ABCDE"
    ),
    false
  );
});

test("exige que intent, abono y liquidacion coincidan al centavo", () => {
  assert.deepEqual(
    validateWompiEarlyPayoffAmounts({
      intentAmountInCents: 84_611_100,
      paymentAmount: 846_111,
      payoffAmount: 846_111,
    }),
    { reason: null, valid: true }
  );
  assert.deepEqual(
    validateWompiEarlyPayoffAmounts({
      intentAmountInCents: 84_611_100,
      paymentAmount: 846_111,
      payoffAmount: 846_110,
    }),
    { reason: "AMOUNT_MISMATCH", valid: false }
  );
});
