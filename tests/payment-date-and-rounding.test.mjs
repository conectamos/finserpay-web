import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": projectRoot,
  },
});
const {
  COLOMBIA_TIME_ZONE,
  colombiaDateKey,
  parseColombiaDate,
} = await jiti.import("../lib/colombia-date.ts");
const { buildCreditPaymentPlan } = await jiti.import(
  "../lib/credit-payment-plan.ts"
);
const { getDefaultFirstPaymentDate } = await jiti.import(
  "../lib/credit-factory.ts"
);
const { resolveSelectedPaymentAmount } = await jiti.import(
  "../lib/manual-payment-amount.ts"
);

test("un timestamp UTC se muestra en el dia real de Colombia", () => {
  const paymentDate = parseColombiaDate("2026-08-03T04:04:00.000Z");
  const day = new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    timeZone: COLOMBIA_TIME_ZONE,
  }).format(paymentDate);
  const month = new Intl.DateTimeFormat("es-CO", {
    month: "short",
    timeZone: COLOMBIA_TIME_ZONE,
  })
    .format(paymentDate)
    .replace(".", "")
    .toUpperCase();

  assert.equal(`${day} ${month}`, "02 AGO");
  assert.equal(colombiaDateKey(paymentDate), "2026-08-02");
  assert.equal(colombiaDateKey("2026-08-17"), "2026-08-17");
});

test("la mora comienza al cambiar el dia calendario en Colombia", () => {
  const beforeMidnight = buildCreditPaymentPlan({
    montoCredito: 2_339_347.2,
    valorCuota: 146_209.2,
    plazoMeses: 16,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-08-02",
    today: "2026-08-03T04:59:59.000Z",
  });
  const afterMidnight = buildCreditPaymentPlan({
    montoCredito: 2_339_347.2,
    valorCuota: 146_209.2,
    plazoMeses: 16,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-08-02",
    today: "2026-08-03T05:00:00.000Z",
  });

  assert.equal(beforeMidnight.estadoPago, "AL_DIA");
  assert.equal(beforeMidnight.installments[0].estaEnMora, false);
  assert.equal(afterMidnight.estadoPago, "MORA");
  assert.equal(afterMidnight.installments[0].estaEnMora, true);
});

test("los vencimientos Prisma conservan su fecha calendario UTC", () => {
  const monthly = buildCreditPaymentPlan({
    montoCredito: 200_000,
    valorCuota: 100_000,
    plazoMeses: 2,
    frecuenciaPago: "MENSUAL",
    fechaPrimerPago: new Date("2026-08-02T00:00:00.000Z"),
    today: "2026-08-01",
  });
  const fortnightly = buildCreditPaymentPlan({
    montoCredito: 300_000,
    valorCuota: 100_000,
    plazoMeses: 3,
    frecuenciaPago: "CATORCENAL",
    fechaPrimerPago: new Date("2026-08-02T00:00:00.000Z"),
    today: "2026-08-01",
  });

  assert.deepEqual(
    monthly.installments.map((item) => item.fechaVencimiento),
    ["2026-08-02", "2026-09-02"]
  );
  assert.deepEqual(
    fortnightly.installments.map((item) => item.fechaVencimiento),
    ["2026-08-02", "2026-08-16", "2026-08-30"]
  );
});

test("la secuencia quincenal es estable e independiente de la zona del proceso", () => {
  const plan = buildCreditPaymentPlan({
    montoCredito: 400_000,
    valorCuota: 100_000,
    plazoMeses: 4,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: new Date("2026-08-02T00:00:00.000Z"),
    today: "2026-08-01",
  });

  assert.deepEqual(
    plan.installments.map((item) => item.fechaVencimiento),
    ["2026-08-02", "2026-08-17", "2026-09-02", "2026-09-17"]
  );
});

test("el corte de la primera cuota usa la hora de Colombia", () => {
  assert.equal(
    getDefaultFirstPaymentDate("2026-08-05", "QUINCENAL"),
    "2026-08-17"
  );
  assert.equal(
    getDefaultFirstPaymentDate("2026-08-06T04:59:59.000Z", "QUINCENAL"),
    "2026-08-17"
  );
  assert.equal(
    getDefaultFirstPaymentDate("2026-08-06T05:00:00.000Z", "QUINCENAL"),
    "2026-09-02"
  );
});

test("el valor COP visible aplica el saldo contractual exacto", () => {
  assert.equal(resolveSelectedPaymentAmount(146_209, 146_209.2), 146_209.2);
  assert.equal(resolveSelectedPaymentAmount(146_208, 146_209.2), 146_208);

  const exactPayment = resolveSelectedPaymentAmount(146_209, 146_209.2);
  const plan = buildCreditPaymentPlan({
    montoCredito: 2_339_347.2,
    valorCuota: 146_209.2,
    plazoMeses: 16,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-08-02",
    today: "2026-08-02",
    abonos: Array.from({ length: 5 }, () => ({ valor: exactPayment })),
  });

  assert.equal(plan.paidCount, 5);
  assert.equal(plan.nextInstallment?.numero, 6);
  assert.equal(plan.installments[4].saldoPendiente, 0);
  assert.equal(plan.installments[5].saldoPendiente, 146_209.2);
});
