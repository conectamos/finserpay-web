import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  projectReferenceTermReduction,
  reconcileReferenceReceipt,
} from "../scripts/lib/ares-capital-reference.mjs";

// Financial amounts only: no customer identity, receipt identifier, database or network.
// Reproducing this example does not establish contractual rules for other credits.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/ares-capital-reference.json", import.meta.url), "utf8"),
);
const receiptInput = () => structuredClone(fixture.receipt.input);
const projectionInput = () => structuredClone(fixture.projection.input);
const near = (actual, expected, label) => {
  assert.ok(Number.isFinite(actual), `${label} must be finite`);
  assert.ok(Math.abs(actual - expected) < 0.000001, `${label}: ${actual} != ${expected}`);
};
const freezeDeep = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
};

test("conciliates the receipt without classifying ordinary principal as interest", () => {
  const result = reconcileReferenceReceipt(receiptInput());
  for (const [key, expected] of Object.entries(fixture.receipt.expected)) {
    assert.equal(result[key], expected, key);
  }
  assert.equal(result.ordinaryTotal + result.extraordinaryPrincipal, result.received);
  assert.equal(result.principalReduction, 5440 + 488963);
  assert.equal(fixture.receipt.input.ordinary.interest, 0);
  assert.equal(fixture.projection.input.schedule[0].priorInterestPaid, 5440);
});

test("does not infer the allocation of a different receipt from this example", () => {
  const result = reconcileReferenceReceipt({
    principalBefore: 1000,
    received: 110,
    ordinary: { principal: 10, interest: 3, surety: 4, insurance: 2, lateFee: 1 },
    extraordinaryPrincipal: 90,
  });
  assert.equal(result.ordinaryTotal, 20);
  assert.equal(result.principalReduction, 100);
  assert.equal(result.principalAfter, 900);
});

test("handles monetary cents without inventing a receipt residual", () => {
  const result = reconcileReferenceReceipt({
    principalBefore: 10,
    received: 0.3,
    ordinary: { principal: 0.1, interest: 0, surety: 0, insurance: 0, lateFee: 0 },
    extraordinaryPrincipal: 0.2,
  });
  near(result.principalReduction, 0.3, "principal reduction");
  near(result.principalAfter, 9.7, "principal after");
});

for (const expected of fixture.projection.observedRows) {
  test(`reproduces observed installment ${expected.number} at displayed peso precision`, () => {
    const result = projectReferenceTermReduction(projectionInput());
    const row = result.rows.find((entry) => entry.number === expected.number);
    assert.ok(row);
    assert.equal(row.removed, false);
    for (const [field, amount] of Object.entries(expected)) {
      if (field !== "number") assert.equal(row.display[field], amount, field);
    }
    assert.equal(row.display.surety, 60061);
    assert.equal(row.display.insurance, 900);
    assert.equal(row.display.creditInstallment, expected.number === 24 ? 25708 : 97539);
  });
}

test("keeps exact intermediate principal instead of rounding each installment", () => {
  const result = projectReferenceTermReduction(projectionInput());
  const first = result.rows[0];
  near(first.principal, 78332.827209, "first principal");
  near(first.interest, 19206.172791, "first interest");
  near(first.closingPrincipal, 1686778.172791, "first closing principal");
  assert.equal(result.rows[1].openingPrincipal, first.closingPrincipal);
  near(result.rows.find((row) => row.number === 24).grossInstallment,
    fixture.projection.expected.lastGrossInstallment, "last exact installment");
});

test("retains the ordinary installment and reduces the term to installment 24", () => {
  const input = projectionInput();
  const result = projectReferenceTermReduction(input);
  assert.equal(result.mode, "REFERENCE_ONLY");
  assert.equal(result.remainingInstallments, fixture.projection.expected.remainingInstallments);
  assert.equal(result.lastInstallmentNumber, fixture.projection.expected.lastInstallmentNumber);
  assert.equal(result.rows.length, input.schedule.length);
  assert.deepEqual(result.rows.map(({ number, date }) => ({ number, date })),
    input.schedule.map(({ number, date }) => ({ number, date })));
  for (const row of result.rows.filter((entry) => entry.number < 24)) {
    assert.equal(row.creditInstallment, 97539);
    assert.equal(row.grossInstallment, 158500);
  }
  assert.equal(result.rows.find((row) => row.number === 24).closingPrincipal, 0);
});

test("keeps prior interest paid separate, without subtracting it again from principal", () => {
  const withPrior = projectReferenceTermReduction(projectionInput());
  const input = projectionInput();
  input.schedule[0].priorInterestPaid = 0;
  const withoutPrior = projectReferenceTermReduction(input);
  assert.equal(withPrior.rows[0].priorInterestPaid, 5440);
  assert.equal(withPrior.rows[0].pending, 153060);
  assert.equal(withPrior.rows[0].principal, withoutPrior.rows[0].principal);
  assert.equal(withPrior.rows[0].closingPrincipal, withoutPrior.rows[0].closingPrincipal);
  near(withPrior.totals.gross, withoutPrior.totals.gross, "gross unaffected");
  near(withoutPrior.totals.pending - withPrior.totals.pending, 5440, "previous payment");
});

for (const [evidence, numbers] of [
  ["observed", fixture.projection.observedZeroRows],
  ["projected only, not observed", fixture.projection.projectedOnlyRows],
]) {
  test(`zeroes eliminated installments (${evidence}) without continuing fees`, () => {
    const result = projectReferenceTermReduction(projectionInput());
    for (const number of numbers) {
      const row = result.rows.find((entry) => entry.number === number);
      assert.ok(row, `installment ${number}`);
      assert.equal(row.removed, true);
      for (const field of ["openingPrincipal", "principal", "interest", "surety", "insurance",
        "creditInstallment", "grossInstallment", "priorInterestPaid", "pending", "closingPrincipal"]) {
        assert.equal(row[field], 0, `${number}.${field}`);
      }
      for (const [field, amount] of Object.entries(row.display)) {
        assert.equal(amount, 0, `${number}.display.${field}`);
      }
    }
  });
}

test("conserves exact principal and totals instead of summing displayed rounded components", () => {
  const result = projectReferenceTermReduction(projectionInput());
  for (const [field, amount] of Object.entries(fixture.projection.expected.totals)) {
    near(result.totals[field], amount, field);
  }
  for (const [totalField, rowField] of Object.entries({ principal: "principal", interest: "interest",
    surety: "surety", insurance: "insurance", gross: "grossInstallment", pending: "pending" })) {
    assert.equal(result.totals[totalField], result.rows.reduce((sum, row) => sum + row[rowField], 0));
  }
  near(result.totals.principal + result.totals.interest + result.totals.surety
    + result.totals.insurance, result.totals.gross, "component reconciliation");
});

test("accepts a zero-rate projection and finishes with the actual remaining capital", () => {
  const result = projectReferenceTermReduction({
    principal: 250, periodicRate: 0, creditInstallment: 100,
    suretyPerInstallment: 5, insurancePerInstallment: 1,
    schedule: [
      { number: 1, date: "2026-10-02" }, { number: 2, date: "2026-10-17" },
      { number: 3, date: "2026-11-02" }, { number: 4, date: "2026-11-17" },
    ],
  });
  assert.equal(result.remainingInstallments, 3);
  assert.equal(result.lastInstallmentNumber, 3);
  assert.deepEqual(result.rows.map((row) => row.grossInstallment), [106, 106, 56, 0]);
  assert.equal(result.totals.principal, 250);
  assert.equal(result.totals.interest, 0);
});

test("does not mutate supplied allocations or schedules, including frozen objects", () => {
  const receipt = freezeDeep(receiptInput());
  const plan = freezeDeep(projectionInput());
  const receiptBefore = structuredClone(receipt);
  const planBefore = structuredClone(plan);
  reconcileReferenceReceipt(receipt);
  projectReferenceTermReduction(plan);
  assert.deepEqual(receipt, receiptBefore);
  assert.deepEqual(plan, planBefore);
});

test("rejects receipt mismatch instead of guessing which component to change", () => {
  for (const delta of [-0.01, 0.01, 1]) {
    const input = receiptInput();
    input.received += delta;
    assert.throws(() => reconcileReferenceReceipt(input));
  }
});

test("rejects overpayment of principal and missing receipt component allocation", () => {
  const input = receiptInput();
  input.principalBefore = 494402;
  assert.throws(() => reconcileReferenceReceipt(input));
  const missing = receiptInput();
  delete missing.ordinary.surety;
  assert.throws(() => reconcileReferenceReceipt(missing));
});

for (const field of ["principalBefore", "received", "extraordinaryPrincipal"]) {
  test(`validates receipt ${field} without numeric coercion or excess precision`, () => {
    for (const invalid of [-1, NaN, Infinity, -Infinity, "500000", null, undefined, 0.001, 1e12 + 1]) {
      const input = receiptInput();
      input[field] = invalid;
      assert.throws(() => reconcileReferenceReceipt(input), String(invalid));
    }
  });
}

for (const field of ["principal", "interest", "surety", "insurance", "lateFee"]) {
  test(`validates the declared ordinary ${field}`, () => {
    for (const invalid of [-1, NaN, Infinity, "0", null, undefined, 0.001, 1e12 + 1]) {
      const input = receiptInput();
      input.ordinary[field] = invalid;
      assert.throws(() => reconcileReferenceReceipt(input), String(invalid));
    }
  });
}

for (const field of ["principal", "creditInstallment", "suretyPerInstallment", "insurancePerInstallment"]) {
  test(`validates projection ${field}`, () => {
    for (const invalid of [-1, NaN, Infinity, "0", null, undefined, 0.001, 1e12 + 1]) {
      const input = projectionInput();
      input[field] = invalid;
      assert.throws(() => projectReferenceTermReduction(input), String(invalid));
    }
  });
}

test("requires an explicit valid periodic rate; never falls back to this reference rate", () => {
  for (const invalid of [-0.01, NaN, Infinity, "0.010881", null, undefined, 1.01]) {
    const input = projectionInput();
    input.periodicRate = invalid;
    assert.throws(() => projectReferenceTermReduction(input), String(invalid));
  }
});

test("rejects zero installment, negative amortization and an insufficient original term", () => {
  for (const creditInstallment of [0, 1000, 19206.17]) {
    const input = projectionInput();
    input.creditInstallment = creditInstallment;
    assert.throws(() => projectReferenceTermReduction(input));
  }
  const input = projectionInput();
  input.schedule = input.schedule.slice(0, 20);
  assert.throws(() => projectReferenceTermReduction(input));
});

test("rejects malformed, unordered, duplicate or nonconsecutive schedule entries", () => {
  const edits = [
    (input) => { input.schedule = []; },
    (input) => { input.schedule = null; },
    (input) => { input.schedule[0] = null; },
    (input) => { input.schedule[0].date = "2026-02-30"; },
    (input) => { input.schedule[0].date = "02/10/2026"; },
    (input) => { input.schedule[0].date = "2026-10-02T00:00:00Z"; },
    (input) => { input.schedule[1].date = input.schedule[0].date; },
    (input) => { input.schedule[1].date = "2026-09-17"; },
    (input) => { input.schedule[0].number = 0; },
    (input) => { input.schedule[0].number = 4.5; },
    (input) => { input.schedule[0].number = "4"; },
    (input) => { input.schedule[1].number = 4; },
    (input) => { input.schedule[1].number = 6; },
  ];
  for (const edit of edits) {
    const input = projectionInput();
    edit(input);
    assert.throws(() => projectReferenceTermReduction(input));
  }
});

test("rejects invalid prior payments and does not silently discard them on eliminated rows", () => {
  for (const invalid of [-1, NaN, Infinity, "5440", null, 0.001, 1e12 + 1, 19206.18, 158500.01]) {
    const input = projectionInput();
    input.schedule[0].priorInterestPaid = invalid;
    assert.throws(() => projectReferenceTermReduction(input), String(invalid));
  }
  const input = projectionInput();
  input.schedule.find((row) => row.number === 25).priorInterestPaid = 1;
  assert.throws(() => projectReferenceTermReduction(input));
});

test("rejects an interest-only installment rather than reporting a principal payment", () => {
  const input = projectionInput();
  input.principal = 100;
  input.periodicRate = 0.1;
  input.creditInstallment = 10;
  input.schedule[0].priorInterestPaid = 0;
  assert.throws(() => projectReferenceTermReduction(input));
});

test("does not create additional installments beyond a supplied calendar or its size limit", () => {
  const input = projectionInput();
  input.schedule = Array.from({ length: 601 }, (_, index) => ({
    number: index + 1,
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  }));
  assert.throws(() => projectReferenceTermReduction(input));
});

test("a reconciled zero principal removes the remaining rows without new fees", () => {
  const receipt = receiptInput();
  receipt.principalBefore = 494403;
  assert.equal(reconcileReferenceReceipt(receipt).principalAfter, 0);
  const input = projectionInput();
  input.principal = 0;
  input.schedule[0].priorInterestPaid = 0;
  const result = projectReferenceTermReduction(input);
  assert.equal(result.remainingInstallments, 0);
  assert.equal(result.lastInstallmentNumber, null);
  assert.ok(result.rows.every((row) => row.removed && row.pending === 0));
  assert.ok(Object.values(result.totals).every((amount) => amount === 0));
});

test("requires an actual extraordinary payment, not a zero or ordinary-only receipt", () => {
  const empty = receiptInput();
  empty.received = 0;
  empty.extraordinaryPrincipal = 0;
  for (const key of Object.keys(empty.ordinary)) empty.ordinary[key] = 0;
  assert.throws(() => reconcileReferenceReceipt(empty));
  const ordinaryOnly = receiptInput();
  ordinaryOnly.extraordinaryPrincipal = 0;
  ordinaryOnly.received = 11037;
  assert.throws(() => reconcileReferenceReceipt(ordinaryOnly));
});
