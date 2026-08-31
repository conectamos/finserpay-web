import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": projectRoot,
  },
});
const { buildCreditPaymentPlan } = await jiti.import(
  "../lib/credit-payment-plan.ts"
);
const { resolveNextPaymentDateAfterPayment } = await jiti.import(
  "../lib/credit-next-payment-date.ts"
);

function buildPlan(abonos) {
  return buildCreditPaymentPlan({
    montoCredito: 200_000,
    valorCuota: 100_000,
    plazoMeses: 2,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
    abonos,
    today: "2026-09-01",
  });
}

test("un abono parcial conserva la fecha administrativa de la misma cuota", () => {
  const override = new Date("2026-09-05T12:00:00.000Z");
  const beforePayment = buildCreditPaymentPlan({
    montoCredito: 200_000,
    valorCuota: 100_000,
    plazoMeses: 2,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
    fechaProximoPago: override,
    today: "2026-09-01",
  });
  const afterPayment = buildPlan([{ valor: 50_000 }]);

  const resolved = resolveNextPaymentDateAfterPayment({
    afterPayment: afterPayment.nextInstallment,
    beforePayment: beforePayment.nextInstallment,
    currentNextPaymentDate: override,
  });

  assert.equal(beforePayment.nextInstallment?.numero, 1);
  assert.equal(afterPayment.nextInstallment?.numero, 1);
  assert.equal(resolved?.toISOString(), "2026-09-05T12:00:00.000Z");
});

test("al completar la cuota deja el override viejo y usa el calendario contractual", () => {
  const override = new Date("2026-09-05T12:00:00.000Z");
  const beforePayment = buildCreditPaymentPlan({
    montoCredito: 200_000,
    valorCuota: 100_000,
    plazoMeses: 2,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
    fechaProximoPago: override,
    today: "2026-09-01",
  });
  const afterPayment = buildPlan([{ valor: 100_000 }]);

  const resolved = resolveNextPaymentDateAfterPayment({
    afterPayment: afterPayment.nextInstallment,
    beforePayment: beforePayment.nextInstallment,
    currentNextPaymentDate: override,
  });

  assert.equal(beforePayment.nextInstallment?.numero, 1);
  assert.equal(afterPayment.nextInstallment?.numero, 2);
  assert.equal(afterPayment.nextInstallment?.fechaVencimiento, "2026-10-02");
  assert.equal(resolved?.toISOString(), "2026-10-02T12:00:00.000Z");
});

test("los planes posteriores al recaudo no reciben el override anterior", () => {
  const sources = [
    [
      "app/api/creditos/[id]/abonos/route.ts",
      "const txPlan = earlyPayoffInTx",
      "const paymentCompletesCredit",
    ],
    [
      "lib/efecty-recaudos.ts",
      "const plan = buildCreditPaymentPlan({",
      "const finalized =",
      true,
    ],
    [
      "lib/wompi-payment-processing.ts",
      "const plan = earlyPayoff",
      "const paymentCompletesCredit",
    ],
  ];

  for (const [relativePath, startMarker, endMarker, useLast] of sources) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
    const start = useLast
      ? source.lastIndexOf(startMarker)
      : source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    const postPaymentPlan = source.slice(start, end);

    assert.ok(start >= 0 && end > start, `No se encontro el plan post-pago en ${relativePath}`);
    assert.doesNotMatch(
      postPaymentPlan,
      /fechaProximoPago\s*:/,
      `${relativePath} no debe aplicar el override viejo al plan post-pago`
    );
  }
});
