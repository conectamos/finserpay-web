import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const { buildCreditPaymentPlan } = await jiti.import(
  "../lib/credit-payment-plan.ts"
);
const { calculateCreditEarlyPayoff } = await jiti.import(
  "../lib/credit-early-payoff.ts"
);

test("un credito liquidado conserva el recaudo y cierra las 16 cuotas", () => {
  const plan = buildCreditPaymentPlan({
    montoCredito: 1_146_110.92,
    valorCuota: 121_841,
    plazoMeses: 16,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-03-02",
    today: "2026-08-01",
    abonos: [{ valor: 300_000 }, { valor: 846_110.92 }],
    settled: true,
  });

  assert.equal(plan.estadoPago, "PAGADO");
  assert.equal(plan.paidCount, 16);
  assert.equal(plan.pendingCount, 0);
  assert.equal(plan.overdueCount, 0);
  assert.equal(plan.saldoPendiente, 0);
  assert.equal(plan.nextInstallment, null);
  assert.equal(plan.totalPaid, 1_146_110.92);
  assert.equal(plan.installments.every((item) => item.estado === "PAGO"), true);
});

test("la liquidacion recalcula cargos sin alterar el efectivo recibido", () => {
  const payoff = calculateCreditEarlyPayoff({
    saldoBaseFinanciado: 1_000_000,
    valorInteres: 349_456,
    valorFianza: 600_000,
    montoCredito: 1_949_456,
    valorCuota: 121_841,
    plazoMeses: 16,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-08-15",
    today: "2026-08-01",
    abonos: [{ valor: 300_000 }],
  });

  assert.equal(payoff.eligible, true);
  assert.equal(payoff.totalAbonado, 300_000);
  assert.equal(payoff.capitalPendiente, 846_110.92);
  assert.equal(payoff.montoCreditoLiquidado, 1_146_110.92);
  assert.equal(payoff.interesFianzaCondonado, 803_345.08);
  assert.equal(payoff.valorInteresReconocido, 53_777.47);
  assert.equal(payoff.valorFianzaReconocida, 92_333.45);
});

test("el PDF del plan oculta saldo contractual y conserva Efecty y el calendario", async () => {
  const [pdfSource, routeSource] = await Promise.all([
    readFile(path.join(projectRoot, "lib/credit-payment-plan-pdf.ts"), "utf8"),
    readFile(
      path.join(projectRoot, "app/api/creditos/[id]/plan-pagos/route.ts"),
      "utf8"
    ),
  ]);
  const metricsStart = pdfSource.indexOf("  const metrics = [");
  const metricsEnd = pdfSource.indexOf("  ];", metricsStart);

  assert.notEqual(metricsStart, -1);
  assert.notEqual(metricsEnd, -1);
  const metrics = pdfSource.slice(metricsStart, metricsEnd);

  assert.ok(metrics.includes("VALOR CUOTA"));
  assert.ok(metrics.includes("VALOR ABONADO"));
  assert.ok(metrics.includes("PROXIMA CUOTA"));
  assert.equal(pdfSource.toLowerCase().includes("saldo contractual"), false);
  assert.ok(
    pdfSource.includes(
      "const metricWidth = (531 - metricGap * (metrics.length - 1)) / metrics.length"
    )
  );

  assert.ok(pdfSource.includes('"PAGO EN EFECTY"'));
  assert.ok(pdfSource.includes("input.convenioEfecty"));
  assert.ok(pdfSource.includes("input.referenciaEfecty"));
  assert.ok(pdfSource.includes('"Conserva el comprobante de pago."'));
  assert.ok(routeSource.includes('process.env.EFECTY_CONVENIO_FINSER_PAY || "113950"'));
  assert.ok(
    routeSource.includes(
      "referenciaEfecty: credito.clienteDocumento || credito.folio"
    )
  );
  assert.ok(
    pdfSource.includes(
      'const headers = ["Cuota", "Vencimiento", "Valor", "Abonado", "Pendiente", "Estado"]'
    )
  );
  assert.ok(pdfSource.includes("paymentPlanDateLabel(item.fechaVencimiento)"));
});
