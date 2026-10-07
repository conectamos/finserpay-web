import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { resolveCarteraDaysPastDue } = await jiti.import("../lib/cartera-due-days.ts");
const installment = (fechaVencimiento, saldoPendiente = 100) => ({ fechaVencimiento, saldoPendiente });
const plan = (...installments) => ({ installments, nextInstallment: installments.find(row => row.saldoPendiente > 0) ?? null });

test("signed Excel days distinguish tomorrow, today, past and later future installments", () => {
  for (const [due, expected] of [["2026-10-08", -1], ["2026-10-07", 0], ["2026-10-06", 1], ["2026-10-10", -3]]) {
    assert.equal(resolveCarteraDaysPastDue(plan(installment(due)), "2026-10-07"), expected);
  }
  assert.equal(resolveCarteraDaysPastDue(plan(), "2026-10-07"), 0);
});

test("oldest pending arrears take precedence over a future next installment, but paid history does not", () => {
  const next = installment("2026-10-08");
  assert.equal(resolveCarteraDaysPastDue({ installments: [installment("2026-09-01", 0), next], nextInstallment: next }, "2026-10-07"), -1);
  assert.equal(resolveCarteraDaysPastDue({ installments: [next, installment("2026-10-06"), installment("2026-10-01")], nextInstallment: next }, "2026-10-07"), 6);
});

test("the signed day changes at Bogotá midnight and is independent of the server timezone", () => {
  const previousTimezone = process.env.TZ;
  try {
    for (const timezone of ["UTC", "America/Bogota", "Asia/Tokyo", "America/Los_Angeles"]) {
      process.env.TZ = timezone;
      const paymentPlan = plan(installment("2026-10-08"));
      assert.equal(resolveCarteraDaysPastDue(paymentPlan, new Date("2026-10-08T04:59:59.999Z")), -1, timezone);
      assert.equal(resolveCarteraDaysPastDue(paymentPlan, new Date("2026-10-08T05:00:00.000Z")), 0, timezone);
      assert.equal(resolveCarteraDaysPastDue(paymentPlan, new Date("2026-10-09T04:59:59.999Z")), 0, timezone);
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("calendar differences handle leap days and year boundaries without elapsed-hour drift", () => {
  assert.equal(resolveCarteraDaysPastDue(plan(installment("2028-03-01")), "2028-02-29"), -1);
  assert.equal(resolveCarteraDaysPastDue(plan(installment("2027-01-01")), "2026-12-31"), -1);
  assert.equal(resolveCarteraDaysPastDue(plan(installment("2028-02-28")), "2028-03-01"), 2);
});
