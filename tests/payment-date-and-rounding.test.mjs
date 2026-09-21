import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const {
  getDefaultFirstPaymentDate,
  getDefaultFirstPaymentDateObject,
} = await jiti.import("../lib/credit-factory.ts");
const { resolveSelectedPaymentAmount } = await jiti.import(
  "../lib/manual-payment-amount.ts"
);
const creditFactoryConsoleSource = readFileSync(
  path.join(
    projectRoot,
    "app/dashboard/creditos/credit-factory-console.tsx"
  ),
  "utf8"
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

test("la fecha administrativa reemplaza solo el vencimiento de la proxima cuota", () => {
  const plan = buildCreditPaymentPlan({
    montoCredito: 400_000,
    valorCuota: 100_000,
    plazoMeses: 4,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
    fechaProximoPago: "2026-09-05",
    today: "2026-09-06",
  });

  assert.deepEqual(
    plan.installments.map((item) => item.fechaVencimiento),
    ["2026-09-05", "2026-10-02", "2026-10-17", "2026-11-02"]
  );
  assert.equal(plan.nextInstallment?.numero, 1);
  assert.equal(plan.nextInstallment?.fechaVencimiento, "2026-09-05");
  assert.equal(plan.nextInstallment?.estaEnMora, true);
  assert.equal(plan.estadoPago, "MORA");
});

test("la fecha administrativa sigue a la primera cuota pendiente sin reescribir las pagadas", () => {
  const plan = buildCreditPaymentPlan({
    montoCredito: 400_000,
    valorCuota: 100_000,
    plazoMeses: 4,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
    fechaProximoPago: "2026-10-05",
    today: "2026-10-01",
    abonos: [{ valor: 100_000 }],
  });

  assert.deepEqual(
    plan.installments.map((item) => item.fechaVencimiento),
    ["2026-09-17", "2026-10-05", "2026-10-17", "2026-11-02"]
  );
  assert.equal(plan.installments[0].estado, "PAGO");
  assert.equal(plan.nextInstallment?.numero, 2);
  assert.equal(plan.nextInstallment?.fechaVencimiento, "2026-10-05");
  assert.equal(plan.estadoPago, "AL_DIA");
});

test("un credito liquidado ignora la excepcion de proximo vencimiento", () => {
  const plan = buildCreditPaymentPlan({
    montoCredito: 200_000,
    valorCuota: 100_000,
    plazoMeses: 2,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
    fechaProximoPago: "2026-09-05",
    settled: true,
  });

  assert.equal(plan.nextInstallment, null);
  assert.deepEqual(
    plan.installments.map((item) => item.fechaVencimiento),
    ["2026-09-17", "2026-10-02"]
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

test("la primera cuota quincenal respeta todos los bordes del calendario", () => {
  const cases = [
    ["2026-09-01", "2026-09-17"],
    ["2026-09-05", "2026-09-17"],
    ["2026-09-06", "2026-10-02"],
    ["2026-09-20", "2026-10-02"],
    ["2026-09-21", "2026-10-17"],
    ["2026-08-31", "2026-09-17"],
    ["2026-12-31", "2027-01-17"],
  ];

  for (const [activatedAt, expected] of cases) {
    assert.equal(
      getDefaultFirstPaymentDate(activatedAt, "QUINCENAL"),
      expected,
      `activacion ${activatedAt}`
    );
    assert.equal(
      getDefaultFirstPaymentDateObject("QUINCENAL", activatedAt).toISOString(),
      `${expected}T12:00:00.000Z`,
      `instante persistible para ${activatedAt}`
    );
  }
});

test("el cambio del dia 20 al 21 ocurre a medianoche de Colombia", () => {
  assert.equal(
    getDefaultFirstPaymentDate("2026-09-21T04:59:59.999Z", "QUINCENAL"),
    "2026-10-02"
  );
  assert.equal(
    getDefaultFirstPaymentDate("2026-09-21T05:00:00.000Z", "QUINCENAL"),
    "2026-10-17"
  );
});

test("el paso 2 muestra el primer pago como fecha civil sin retroceder un dia", () => {
  const firstPaymentLabel = creditFactoryConsoleSource.match(
    /const parsedFechaPrimerPago = fechaPrimerPago[\s\S]{0,760}: "{{FECHA_PRIMER_PAGO}}";/
  )?.[0];
  const firstPaymentBlock = creditFactoryConsoleSource.match(
    /<small>Primer pago<\/small>[\s\S]{0,420}<\/strong>/
  )?.[0];

  assert.ok(firstPaymentLabel, "debe existir una etiqueta compartida de primer pago");
  assert.ok(firstPaymentBlock, "debe existir la tarjeta Primer pago del paso 2");
  assert.doesNotMatch(
    firstPaymentLabel,
    /new Date\(fechaPrimerPago\)\.toLocaleDateString/,
    "una fecha YYYY-MM-DD no debe convertirse como instante UTC"
  );
  assert.match(
    firstPaymentLabel,
    /parseColombiaDate\(fechaPrimerPago\)/,
    "debe usar el helper date-only que conserva el dia calendario"
  );
  assert.match(
    firstPaymentLabel,
    /parsedFechaPrimerPago\.toLocaleDateString\(\s*"es-CO"\s*,\s*\{/,
    "debe formatear la fecha civil parseada con opciones explicitas"
  );
  assert.match(firstPaymentLabel, /timeZone:\s*COLOMBIA_TIME_ZONE/);
  assert.match(firstPaymentLabel, /day:\s*"2-digit"/);
  assert.match(firstPaymentLabel, /month:\s*"2-digit"/);
  assert.match(firstPaymentLabel, /year:\s*"numeric"/);
  assert.match(
    firstPaymentBlock,
    /fechaPrimerPago\s*\?\s*fechaPrimerPagoLabel\s*:\s*"[^"]*"/,
    "la tarjeta del paso 2 debe reutilizar la misma etiqueta segura"
  );
  assert.match(
    creditFactoryConsoleSource,
    /Fecha de inicio:\s*\{fechaPrimerPagoLabel\}/,
    "la segunda visualizacion debe reutilizar la misma etiqueta segura"
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
